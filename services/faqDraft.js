/**
 * Ground a customer message in the approved FAQ.
 * Handoff and live-price replies are written here.
 * A verified TU_DONG match may call Claude, with training examples first.
 */
const llm = require('./llm');
const trainingLog = require('./trainingLog');
const store = require('./faqStore');
const retrieve = require('./faqRetrieve');
const policy = require('./faqPolicy');
const faqPrompt = require('./faqPrompt');
const faqText = require('./faqText');

let completer = null;
let kiotSearch = null;

function setCompleterForTests(fn) {
  if (fn && process.env.NODE_ENV !== 'test') {
    throw new Error('setCompleterForTests is only available when NODE_ENV=test');
  }
  completer = fn || null;
}

function setKiotSearchForTests(fn) {
  if (fn && process.env.NODE_ENV !== 'test') {
    throw new Error('setKiotSearchForTests is only available when NODE_ENV=test');
  }
  kiotSearch = fn || null;
}

function numbersIn(text) {
  return [...String(text || '').matchAll(/\d[\d.]*/g)].map(match => match[0].replace(/\./g, ''));
}

function keepsNumbers(draft, answer) {
  const need = numbersIn(answer);
  const have = new Set(numbersIn(draft));
  return need.every(n => have.has(n));
}

function extraNumbers(draft, answer, query) {
  const allowed = new Set(numbersIn(`${answer}\n${query}`));
  return numbersIn(draft).some(n => !allowed.has(n));
}

function reasks(draft, answer) {
  if (!/[?]/.test(String(draft || ''))) return false;
  const d = policy.fold(draft);
  const a = policy.fold(answer);
  const day = /trong ngay|di ngay/;
  const night = /qua dem|o lai dem|o dem/;
  return day.test(a) && night.test(a) && day.test(d) && night.test(d);
}

function dropPii(text, answer) {
  const allowPhone = policy.fold(answer).includes('so dien thoai');
  let out = String(text || '');
  if (!allowPhone) {
    out = out.replace(/(?:\+?84|0)(?:[\s.]?\d){8,10}/g, '');
    out = out.split('\n').filter(line => {
      const folded = policy.fold(line);
      if (/so dien thoai|sdt/.test(folded) && /xin|cho|gui|nhan/.test(folded)) return false;
      if (/dia chi/.test(folded) && /xin|cho|gui|nha/.test(folded)) return false;
      return true;
    }).join('\n');
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function verbatim(item) {
  const answer = String(item.answer || '').trim();
  if (!answer) return policy.HOLD;
  if (/^dạ/i.test(answer)) return answer;
  return `Dạ ${answer}`;
}

function formatVnd(n) {
  const s = Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${s}đ`;
}

async function lookupKiot(query) {
  if (kiotSearch) return kiotSearch(query);
  if (process.env.NODE_ENV === 'test') return [];
  try {
    const kiot = require('./kiotviet');
    return await kiot.searchProducts(query, 3);
  } catch (err) {
    console.error('Kiot FAQ lookup failed:', err.message);
    return [];
  }
}

async function complete(system, user) {
  if (completer) return completer(system, user);
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const created = await llm.anthropicCreate(client, {
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = (created.response.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  return text.trim() || null;
}

async function adapt(query, item) {
  let training = '';
  try {
    training = await trainingLog.promptBlock(query, 'farm');
  } catch (err) {
    console.error('Training examples skipped:', err.message);
  }
  const faq = await faqPrompt.promptBlock(query);
  const system = `${training || ''}${faq}`;
  let text = null;
  try {
    text = await complete(system, query);
  } catch (err) {
    console.error('FAQ Claude draft failed:', err.message);
  }
  text = faqText.stripReviewerBlock(text || '');
  text = dropPii(text, item.answer);
  if (!text || !keepsNumbers(text, item.answer) || extraNumbers(text, item.answer, query) || reasks(text, item.answer)) {
    text = verbatim(item);
  }
  return dropPii(faqText.stripReviewerBlock(text), item.answer);
}

async function liveReply(query, decision) {
  const item = decision.item;
  const folded = policy.fold(`${query} ${item.question}`);
  const wantsFee = /phi ship|phi giao|phi van chuyen/.test(folded);
  if (wantsFee) {
    return {
      ...decision,
      mode: 'handoff',
      handoff: true,
      reason: 'phí giao cần người trực, chưa có số live',
      text: policy.HOLD,
      triage: policy.triageFor(query, true, 'phí giao cần người trực, chưa có số live'),
    };
  }
  const hits = await lookupKiot(item.product || query);
  const product = (hits || []).find(row => row && Number(row.price) > 0) || null;
  const wantsStock = /con hang|ton kho|het hang|con khong/.test(folded);
  const wantsPrice = /gia|bao nhieu/.test(folded) || !wantsStock;
  if (wantsStock && !wantsPrice) {
    const row = (hits || [])[0];
    if (row && row.available != null && Number.isFinite(Number(row.available))) {
      const name = row.name || item.product || 'món này';
      const n = Number(row.available);
      const text = n > 0
        ? `Dạ ${name} bên KiotViet đang còn ${n} ạ.`
        : `Dạ ${name} bên KiotViet đang hết ạ.`;
      return { ...decision, text, reason: 'tồn kho lấy từ KiotViet' };
    }
    return {
      ...decision,
      mode: 'handoff',
      handoff: true,
      reason: 'chưa lấy được tồn kho KiotViet',
      text: policy.HOLD,
      triage: policy.triageFor(query, true, 'chưa lấy được tồn kho KiotViet'),
    };
  }
  if (product) {
    const name = product.name || item.product || 'món này';
    return {
      ...decision,
      text: `Dạ ${name} farm đang niêm yết ${formatVnd(product.price)} trên KiotViet ạ.`,
      reason: 'giá KiotViet thay giá trong FAQ',
    };
  }
  return {
    ...decision,
    mode: 'handoff',
    handoff: true,
    reason: 'chưa lấy được giá KiotViet',
    text: policy.HOLD,
    triage: policy.triageFor(query, true, 'chưa lấy được giá KiotViet'),
  };
}

function pack(decision, text) {
  const body = faqText.stripReviewerBlock(text || policy.HOLD) || policy.HOLD;
  return {
    handled: true,
    text: body,
    reviewer: policy.reviewer(decision),
    triage: decision.triage,
  };
}

async function compose(userMessage) {
  const query = String(userMessage || '').trim();
  try {
    const count = await store.countEnabled();
    if (!count) return { handled: false };
    const items = await store.enabledItems();
    const hits = retrieve.search(items, query, 5);
    const decision = policy.decide(query, hits);
    if (decision.mode === 'handoff') return pack(decision, decision.text);
    if (decision.mode === 'live') {
      const live = await liveReply(query, decision);
      return pack(live, live.text);
    }
    const text = await adapt(query, decision.item);
    return pack(decision, text);
  } catch (err) {
    console.error('FAQ compose failed:', err.message);
    const count = await store.countEnabled().catch(() => 0);
    if (!count) return { handled: false };
    const decision = policy.decide(query, []);
    decision.reason = 'lỗi tra FAQ, chuyển người';
    decision.text = policy.HOLD;
    decision.handoff = true;
    decision.mode = 'handoff';
    decision.triage = policy.triageFor(query, true, decision.reason);
    return pack(decision, decision.text);
  }
}

module.exports = {
  compose,
  setCompleterForTests,
  setKiotSearchForTests,
  formatVnd,
};
