/**
 * FB-Sale vs FB-DV labels.
 *
 * Topic decides. The customer's latest message that hits a topic wins;
 * page text is used only when the customer has no topic. Product, price,
 * ship, and order are Sale, even when Lành signed. Service words and FAQ
 * service entries are DV. A Lành sign-off is only a tiebreaker when no
 * topic is detected; from.name never selects the label. A manual Sale or
 * DV label always wins.
 *
 * DV keywords are learned only from threads labeled DV by a service topic,
 * never from a sign-off. Catalog product names and generic sales words are
 * not learned. Backfill and relabel stay local: they do not call Claude.
 * Live classification may, and that call gets at most eight short sanitized
 * examples plus the thread label and learned keywords. Message bodies
 * are not logged.
 */
const ops = require('./ops');
const pii = require('./pii');
const bizLine = require('./bizLine');
const lanhMark = require('./lanhMark');
const fbDvRule = require('./fbDvRule');
const store = require('./conversationStore');

const SOURCES = ['staff_lanh', 'signature', 'keyword', 'manual', 'model'];

/** Phrases the owner called out, beyond the older sale/DV word list. */
const SEED_EXTRA = [
  ['di trong ngay', 'đi trong ngày'],
  ['bao nhieu nguoi', 'bao nhiêu người'],
  ['farmstay', 'farmstay'],
  ['mua ve', 'mua vé'],
  ['gia ve', 'giá vé'],
  ['ve tham quan', 'vé tham quan'],
  ['ngay den', 'ngày đến'],
  ['ngay di', 'ngày đi'],
  ['dat cho', 'đặt chỗ'],
  ['nghi qua dem', 'nghỉ qua đêm'],
  ['tour trong ngay', 'tour trong ngày'],
  ['phong o', 'phòng ở'],
];

const SEED_DISPLAY = [
  'phòng',
  'đặt phòng',
  'qua đêm',
  'ở lại',
  'homestay',
  'check-in',
  'sự kiện',
  'team building',
  'cắm trại',
  ...SEED_EXTRA.map((pair) => pair[1]),
];

let learned = [];
let keywordDisplay = [];
let keywordCache = null;
let shotCache = null;

function resetForTests() {
  learned = [];
  keywordDisplay = [];
  keywordCache = null;
  shotCache = null;
  fbDvRule.resetForTests();
}

function extraPhrases() {
  return [...SEED_EXTRA.map((pair) => pair[0]), ...learned];
}

function hasPhrase(text, phrases) {
  const folded = ops.normalizeText(text);
  if (!folded) return false;
  const hay = ` ${folded} `;
  return phrases.some((phrase) => {
    const n = ops.normalizeText(phrase);
    return n && hay.includes(` ${n} `);
  });
}

function dvHit(text) {
  if (bizLine.classify(text) === 'dv') return true;
  return hasPhrase(text, extraPhrases());
}

function nameIsLanh(name) {
  return lanhMark.textHasLanh(name);
}

function textHasLanh(text) {
  return lanhMark.isSignoff(text);
}

/**
 * @returns {'staff_lanh'|'signature'|null}
 * Detector only. ruleFromMessages does not use this: from.name never
 * selects a label, and a sign-off counts only when fbDvRule finds no topic.
 * A different human name blocks the signature on that one message.
 */
function lanhAttribution(messages) {
  let signature = false;
  for (const row of messages || []) {
    if (!row || row.direction !== 'out') continue;
    const meta = row.sender_meta || {};
    const name = meta.from_name || row.sender_label || '';
    const fromId = meta.from_id != null ? String(meta.from_id) : '';
    const pageId = meta.page_id != null ? String(meta.page_id) : '';
    if (name && nameIsLanh(name)) return 'staff_lanh';
    const otherHuman = name && !nameIsLanh(name) && fromId && pageId && fromId !== pageId;
    if (otherHuman) continue;
    const pageIdentity = !fromId || (pageId && fromId === pageId) || !name;
    if (pageIdentity && textHasLanh(row.message_text || row.text || '')) signature = true;
  }
  return signature ? 'signature' : null;
}

function ruleFromMessages(messages) {
  return fbDvRule.decide(messages);
}

/**
 * @returns {{biz_line:string, biz_sticky:boolean, source:string, confidence:number}|null}
 */
function classifyContext({ channel, text, messages, label, prior }) {
  if (prior && prior.biz_sticky && (prior.biz_line === 'sale' || prior.biz_line === 'dv')) {
    return { biz_line: prior.biz_line, biz_sticky: true, source: 'manual', confidence: 1 };
  }
  if (label && label.source === 'manual' && (label.label === 'sale' || label.label === 'dv')) {
    return { biz_line: label.label, biz_sticky: true, source: 'manual', confidence: 1 };
  }
  if (channel !== 'messenger') return null;

  const ruled = ruleFromMessages(withNewest(messages, text));
  if (ruled) {
    return {
      biz_line: ruled.label,
      biz_sticky: false,
      source: ruled.source,
      confidence: ruled.confidence,
    };
  }
  const sawPage = (messages || []).some((row) => row && row.direction === 'out');
  if (!sawPage && label && (label.source === 'staff_lanh' || label.source === 'signature') && label.label === 'dv') {
    return {
      biz_line: 'dv',
      biz_sticky: false,
      source: label.source,
      confidence: label.confidence || 0.9,
    };
  }

  const priorTexts = (messages || []).map((row) => row.message_text || row.text || '');
  const newest = String(text || '');
  const newestLine = bizLine.classify(newest);
  const priorDv = priorTexts.some((part) => dvHit(part));
  const labeledDv = label && label.label === 'dv';
  if (labeledDv) {
    const strongSale = newestLine === 'sale' && !dvHit(newest) && !priorDv;
    if (strongSale) {
      return { biz_line: 'sale', biz_sticky: false, source: 'keyword', confidence: 0.7 };
    }
    return {
      biz_line: 'dv',
      biz_sticky: false,
      source: label.source || 'keyword',
      confidence: label.confidence || 0.75,
    };
  }
  if (newestLine === 'dv' || dvHit(newest)) {
    if (newestLine === 'sale') {
      return { biz_line: 'sale', biz_sticky: false, source: 'keyword', confidence: 0.8 };
    }
    return { biz_line: 'dv', biz_sticky: false, source: 'keyword', confidence: 0.8 };
  }
  if (priorDv && newestLine !== 'sale') {
    return { biz_line: 'dv', biz_sticky: false, source: 'keyword', confidence: 0.7 };
  }
  if (newestLine === 'sale' && !priorDv) {
    return { biz_line: 'sale', biz_sticky: false, source: 'keyword', confidence: 0.8 };
  }
  return null;
}

async function ensureLearned() {
  if (keywordCache) return keywordCache;
  keywordCache = (async () => {
    const labels = await store.allLabels('fb');
    await refreshKeywords(labels);
    shotCache = await fewShotFromStore(labels);
  })().catch((err) => {
    keywordCache = null;
    throw err;
  });
  return keywordCache;
}

function withNewest(messages, text) {
  const rows = messages || [];
  const newest = String(text || '').trim();
  if (!newest) return rows;
  const last = rows[rows.length - 1];
  const lastText = last ? String(last.message_text || last.text || '').trim() : '';
  if (lastText === newest) return rows;
  return rows.concat([{ direction: 'in', message_text: newest }]);
}

function threadWindow(messages, text) {
  const rows = (messages || []).slice(-10);
  const newest = String(text || '').trim();
  if (!newest) return rows;
  const last = rows[rows.length - 1];
  const lastText = last ? String(last.message_text || last.text || '').trim() : '';
  if (lastText === newest) return rows;
  return rows.concat([{ direction: 'in', message_text: newest }]).slice(-10);
}

async function liveModel(messages, label, text) {
  const rows = threadWindow(messages, text);
  if (!rows.some((row) => String(row.message_text || row.text || '').trim())) return null;
  let shots = shotCache;
  if (!shots) {
    try {
      shots = await fewShotFromStore(await store.allLabels('fb'));
      shotCache = shots;
    } catch (err) {
      console.error('few-shot skipped:', err.message);
      shots = [];
    }
  }
  return modelClassify(rows, shots, {
    label: label && label.label,
    keywords: keywordDisplay.slice(0, 30),
  });
}

async function resolveTurn({ channel, userId, text, prior }) {
  const storeChannel = channel === 'messenger' ? 'fb' : (channel === 'zalo' ? 'zalo' : null);
  let messages = [];
  let label = null;
  if (storeChannel === 'fb') {
    try {
      await ensureLearned();
    } catch (err) {
      console.error('keywords skipped:', err.message);
    }
  }
  if (storeChannel && userId) {
    try {
      messages = await store.recent(storeChannel, userId, 10);
      label = await store.getLabel(storeChannel, userId);
    } catch (err) {
      console.error('thread context skipped:', err.message);
    }
  }
  const decided = classifyContext({ channel, text, messages, label, prior });
  if (decided) return decided;
  if (channel === 'messenger') {
    try {
      const modeled = await liveModel(messages, label, text);
      if (modeled && (modeled.label === 'dv' || modeled.label === 'sale')) {
        if (userId) {
          try {
            await store.setLabel('fb', userId, modeled);
          } catch (err) {
            console.error('thread label skipped:', err.message);
          }
        }
        return {
          biz_line: modeled.label,
          biz_sticky: false,
          source: 'model',
          confidence: modeled.confidence,
        };
      }
    } catch (err) {
      console.error('live classify skipped:', err.message);
    }
  }
  const fallback = bizLine.resolve({ channel, text, prior });
  return {
    biz_line: fallback.biz_line,
    biz_sticky: fallback.biz_sticky === true,
    source: 'keyword',
    confidence: fallback.biz_line ? 0.4 : 0,
  };
}

function storeChannelOfDraft(channel) {
  if (channel === 'messenger') return 'fb';
  if (channel === 'zalo') return 'zalo';
  return null;
}

async function setManual(draftChannel, userId, line) {
  const channel = storeChannelOfDraft(draftChannel);
  if (!channel || !userId) return null;
  if (line !== 'sale' && line !== 'dv') return null;
  return store.setLabel(channel, String(userId), {
    label: line,
    source: 'manual',
    confidence: 1,
  });
}

function messageText(row) {
  return String((row && (row.message_text || row.text)) || '');
}

function decideThread(messages, existing) {
  if (existing && existing.source === 'manual') {
    return {
      label: existing.label,
      source: 'manual',
      confidence: existing.confidence == null ? 1 : existing.confidence,
    };
  }
  const ruled = ruleFromMessages(messages);
  if (ruled) return ruled;
  const lastIn = [...(messages || [])].reverse().find((row) => row && row.direction === 'in');
  const window = (messages || []).slice(-10);
  const decided = classifyContext({
    channel: 'messenger',
    text: lastIn ? messageText(lastIn) : '',
    messages: window,
    label: null,
    prior: null,
  });
  if (decided && (decided.biz_line === 'dv' || decided.biz_line === 'sale')) {
    return { label: decided.biz_line, source: 'keyword', confidence: decided.confidence || 0.7 };
  }
  return { label: 'unknown', source: 'keyword', confidence: 0.3 };
}

const STOP = new Set([
  'la', 'va', 'cua', 'cho', 'minh', 'ban', 'shop', 'da', 'em', 'anh', 'chi',
  'khong', 'co', 'gi', 'nao', 'the', 'voi', 'mot', 'nha', 'farm', 'oi', 'ha',
  'nhung', 'nay', 'roi', 'lam', 'giup', 'nhe', 'nha', 'duc', 'qua',
]);

function phraseSet(text) {
  const tokens = ops.normalizeText(text).split(' ').filter((token) => token.length >= 3 && !STOP.has(token));
  const found = new Set();
  for (const token of tokens) {
    if (token.length >= 5) found.add(token);
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    found.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return found;
}

function extractKeywords(dvDocs, saleDocs) {
  const dvCount = new Map();
  const saleCount = new Map();
  const add = (docs, bucket) => {
    for (const doc of docs) {
      const seen = phraseSet(doc);
      for (const phrase of seen) bucket.set(phrase, (bucket.get(phrase) || 0) + 1);
    }
  };
  add(dvDocs, dvCount);
  add(saleDocs, saleCount);
  const ranked = [];
  for (const [phrase, count] of dvCount) {
    if (count < 2) continue;
    if ((saleCount.get(phrase) || 0) > 0) continue;
    if (phrase.length < 4) continue;
    ranked.push({ phrase, count });
  }
  ranked.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
  return ranked.slice(0, 40);
}

function topKeywords(ranked) {
  const out = [];
  const seen = new Set();
  for (const item of ranked || []) {
    if (seen.has(item.phrase) || out.length >= 30) continue;
    seen.add(item.phrase);
    out.push(item.phrase);
  }
  for (const word of SEED_DISPLAY) {
    const key = ops.normalizeText(word);
    if (!key || seen.has(key) || out.length >= 30) continue;
    seen.add(key);
    out.push(word);
  }
  return out.slice(0, 30);
}

async function refreshKeywords(labels) {
  await fbDvRule.loadProductPhrases();
  const rows = await store.all('fb');
  const byThread = new Map();
  for (const row of rows) {
    const list = byThread.get(row.thread_id) || [];
    list.push(row);
    byThread.set(row.thread_id, list);
  }
  const dvDocs = [];
  const saleDocs = [];
  for (const label of labels || []) {
    if (label.label !== 'dv' && label.label !== 'sale') continue;
    const messages = byThread.get(label.thread_id) || [];
    const inbound = messages
      .filter((row) => row.direction === 'in')
      .map((row) => row.message_text || '')
      .join('\n');
    if (label.label === 'sale') {
      if (inbound.trim()) saleDocs.push(inbound);
      continue;
    }
    if (label.source !== 'keyword') continue;
    const topic = fbDvRule.decide(messages);
    if (!topic || topic.label !== 'dv' || topic.source !== 'keyword') continue;
    if (inbound.trim()) dvDocs.push(inbound);
  }
  const ranked = extractKeywords(dvDocs, saleDocs)
    .filter((item) => !fbDvRule.blockedKeyword(item.phrase));
  learned = ranked.map((item) => item.phrase);
  keywordDisplay = topKeywords(ranked);
  return keywordDisplay;
}

function buildFewShot(threads) {
  const examples = [];
  for (const label of ['dv', 'sale']) {
    const picked = (threads || []).filter((thread) => thread && thread.label === label).slice(0, 4);
    for (const thread of picked) {
      const lines = (thread.messages || []).slice(-4).map((row) => {
        const who = row.direction === 'out' ? 'Shop' : 'Khách';
        const body = pii.maskText(String(row.message_text || row.text || '').slice(0, 160));
        return `${who}: ${body}`;
      }).filter((line) => !line.endsWith(': '));
      if (!lines.length) continue;
      examples.push({ label, text: lines.join('\n').slice(0, 360) });
    }
  }
  return examples.slice(0, 8);
}

function classificationMessages(messages, shots, hint) {
  const history = [];
  for (const example of (shots || []).slice(0, 8)) {
    history.push({ role: 'user', content: example.text });
    history.push({ role: 'assistant', content: example.label });
  }
  const context = (messages || []).slice(-10).map((row) => {
    const who = row.direction === 'out' ? 'Shop' : 'Khách';
    return `${who}: ${pii.maskText(String(row.message_text || row.text || '').slice(0, 180))}`;
  }).join('\n');
  history.push({ role: 'user', content: context });
  const kw = hint && Array.isArray(hint.keywords) ? hint.keywords.slice(0, 30) : [];
  const labelBit = hint && hint.label
    ? `Nhãn hiện tại của thread: ${hint.label}.`
    : 'Thread chưa có nhãn.';
  const kwBit = kw.length ? `Từ khóa DV đã học: ${kw.join(', ')}.` : '';
  return {
    system: [
      'Phân loại hội thoại thành dv (phòng, ở lại, sự kiện, đi trong ngày, vé tham quan) hoặc sale (nông sản, giao hàng).',
      'Thread đã gắn DV thì câu hỏi mơ hồ vẫn là dv, trừ khi tin mới là sale rõ.',
      labelBit,
      kwBit,
      'Chỉ trả về một từ: dv, sale, hoặc unknown.',
    ].filter(Boolean).join(' '),
    messages: history,
  };
}

async function modelClassify(messages, shots, hint) {
  if (process.env.NODE_ENV === 'test' && process.env.FB_CLASSIFY_MODEL !== '1') return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const payload = classificationMessages(messages, shots, hint);
  if (!payload.messages.length || !String(payload.messages[payload.messages.length - 1].content || '').trim()) {
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const llm = require('./llm');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { response } = await llm.anthropicCreate(client, {
      model: process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      system: payload.system,
      messages: payload.messages,
    });
    const raw = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
      .toLowerCase();
    const token = (raw.split(/\s+/)[0] || '').replace(/[^a-z]/g, '');
    if (token !== 'dv' && token !== 'sale' && token !== 'unknown') return null;
    return { label: token, source: 'model', confidence: token === 'unknown' ? 0.4 : 0.6 };
  } catch (err) {
    console.error('thread model classify skipped:', err.message);
    return null;
  }
}

function emptyBucket() {
  return { staff_lanh: 0, signature: 0, keyword: 0, manual: 0, model: 0, total: 0 };
}

function countLabels(rows) {
  const counts = { dv: emptyBucket(), sale: emptyBucket(), unknown: emptyBucket() };
  for (const row of rows || []) {
    const bucket = counts[row.label];
    if (!bucket) continue;
    bucket.total += 1;
    if (SOURCES.includes(row.source)) bucket[row.source] += 1;
  }
  return counts;
}

async function fewShotFromStore(labels) {
  const rows = await store.all('fb');
  const byThread = new Map();
  for (const row of rows) {
    const list = byThread.get(row.thread_id) || [];
    list.push(row);
    byThread.set(row.thread_id, list);
  }
  const threads = [];
  for (const label of labels || []) {
    if (label.label !== 'dv' && label.label !== 'sale') continue;
    threads.push({
      label: label.label,
      messages: byThread.get(label.thread_id) || [],
    });
  }
  return buildFewShot(threads);
}

async function relabel() {
  await fbDvRule.loadProductPhrases();
  const rows = await store.all('fb');
  const byThread = new Map();
  for (const row of rows) {
    const list = byThread.get(row.thread_id) || [];
    list.push(row);
    byThread.set(row.thread_id, list);
  }
  const existing = new Map((await store.allLabels('fb')).map((row) => [row.thread_id, row]));
  const drafts = require('./drafts');
  const saved = [];
  const rest = [];
  let draftsUpdated = 0;
  for (const [threadId, messages] of byThread) {
    const prior = existing.get(threadId);
    if (prior && prior.source === 'manual') {
      saved.push(prior);
      draftsUpdated += await drafts.applyThreadLabel('messenger', threadId, prior);
      continue;
    }
    const ruled = ruleFromMessages(messages);
    if (ruled) {
      const stored = await store.setLabel('fb', threadId, ruled);
      saved.push(stored);
      draftsUpdated += await drafts.applyThreadLabel('messenger', threadId, stored);
      continue;
    }
    rest.push(threadId);
  }
  const keywords = await refreshKeywords(saved);
  for (const threadId of rest) {
    const row = decideThread(byThread.get(threadId) || [], null);
    const stored = await store.setLabel('fb', threadId, row);
    saved.push(stored);
    if (stored.label === 'sale' || stored.label === 'dv') {
      draftsUpdated += await drafts.applyThreadLabel('messenger', threadId, stored);
    }
  }
  shotCache = await fewShotFromStore(await store.allLabels('fb'));
  keywordCache = Promise.resolve();
  const labels = await store.allLabels('fb');
  return {
    counts: countLabels(labels),
    drafts_updated: draftsUpdated,
    keywords,
  };
}

async function stats() {
  const labels = await store.allLabels('fb');
  return {
    counts: countLabels(labels),
    keywords: await refreshKeywords(labels),
  };
}

function publicContextRow(row) {
  return {
    direction: row.direction === 'out' ? 'out' : 'in',
    sender_label: row.sender_label || null,
    text: row.message_text || row.attachments_summary || '',
    created_time: row.created_time,
    attachments_summary: row.attachments_summary || null,
  };
}

async function contextForDraft(draft) {
  if (!draft) return [];
  const channel = storeChannelOfDraft(draft.channel);
  const threadId = draft.customer_user_id ? String(draft.customer_user_id) : '';
  if (!channel || !threadId) return [];
  const rows = await store.recent(channel, threadId, 30);
  let cut = rows.length;
  if (draft.source_msg_id) {
    const idx = rows.findIndex((row) => row.source_msg_id === draft.source_msg_id);
    if (idx >= 0) cut = idx;
  }
  if (cut === rows.length && draft.customer_query) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].direction === 'in' && rows[i].message_text === draft.customer_query) {
        cut = i;
        break;
      }
    }
  }
  return rows.slice(Math.max(0, cut - 10), cut).map(publicContextRow).filter((row) => row.text);
}

module.exports = {
  SEED_DISPLAY,
  resetForTests,
  dvHit,
  lanhAttribution,
  classifyContext,
  resolveTurn,
  setManual,
  decideThread,
  buildFewShot,
  classificationMessages,
  modelClassify,
  relabel,
  stats,
  contextForDraft,
  topKeywords,
  extractKeywords,
};
