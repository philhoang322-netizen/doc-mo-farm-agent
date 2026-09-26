/**
 * Read-only look at why a thread was labeled Sale or DV.
 * Does not write labels, drafts, or keywords.
 *
 * Page snippets are the matched Lành token plus about 40 characters
 * on either side. Customer text is only the first inbound line, cut
 * to 60 characters. Phones and similar values in those snippets are
 * masked. Nothing here is written to the log.
 */
const ops = require('./ops');
const pii = require('./pii');
const bizLine = require('./bizLine');
const lanhMark = require('./lanhMark');
const catalog = require('./catalog');
const store = require('./conversationStore');
const threadLabels = require('./threadLabels');
const fbDvRule = require('./fbDvRule');

const REASONS = ['staff_lanh', 'signature', 'keyword', 'manual', 'model'];
const LABELS = ['sale', 'dv', 'unknown'];
const PAD = 40;
const CUSTOMER_CAP = 60;

const SERVICE_PHRASES = [
  'phong',
  'farmstay',
  'luu tru',
  'su kien',
  'chuong trinh',
  ...bizLine.DV_PHRASES,
  'di trong ngay',
  'mua ve',
  'gia ve',
  've tham quan',
  'dat cho',
  'nghi qua dem',
  'tour trong ngay',
  'phong o',
];

/** Product wording that showed up in the learned DV list, plus catalog cousins. */
const PRODUCT_EXTRA = [
  'len men',
  'xin gia',
  'nuoc nghe',
  'nuoc gung',
  'dau goi',
  'dau tam',
  'xuc xich',
  'keo chuoi',
  'chuoi say',
  'thit heo',
  'thit bo',
  'mat ong',
  'hai san',
  'ga ta',
  'nong san',
];

const GENERIC_NAME_TOKENS = new Set([
  'nuoc', 'len', 'men', 'cao', 'cap', 'chat', 'loai', 'hang', 'farm',
]);

const SIGNOFF_PARTICLES = new Set(['a', 'nha', 'nhe', 'ha', 'ah', 'oi', 'shop']);

function clampLimit(value) {
  const n = Number(value == null || value === '' ? 30 : value);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function parseFilter(input) {
  const label = input && input.label != null && input.label !== '' ? String(input.label) : 'dv';
  const reason = input && input.reason != null && input.reason !== '' ? String(input.reason) : 'signature';
  if (!LABELS.includes(label)) {
    const err = new Error('Nhãn không hợp lệ');
    err.status = 400;
    throw err;
  }
  if (!REASONS.includes(reason)) {
    const err = new Error('Lý do không hợp lệ');
    err.status = 400;
    throw err;
  }
  return { label, reason, limit: clampLimit(input && input.limit) };
}

function paddedHit(text, phrases) {
  const folded = ops.normalizeText(text);
  if (!folded) return false;
  const hay = ` ${folded} `;
  return phrases.some((phrase) => {
    const n = ops.normalizeText(phrase);
    return n && hay.includes(` ${n} `);
  });
}

function phrasesFromName(name) {
  const folded = ops.normalizeText(name);
  if (!folded || folded.length < 4) return [];
  const tokens = folded.split(' ').filter((token) => token.length >= 2);
  const out = [];
  if (tokens.length >= 2 || folded.length >= 6) out.push(folded);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const pair = `${tokens[i]} ${tokens[i + 1]}`;
    const bothGeneric = GENERIC_NAME_TOKENS.has(tokens[i]) && GENERIC_NAME_TOKENS.has(tokens[i + 1]);
    if (!bothGeneric && pair.length >= 4) out.push(pair);
  }
  return out;
}

async function catalogEntries() {
  const entries = [];
  const seen = new Set();
  const add = (name, source) => {
    const display = String(name || '').trim();
    if (!display) return;
    const phrases = phrasesFromName(display);
    if (!phrases.length) return;
    const key = ops.normalizeText(display);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name: display, source, phrases });
  };
  for (const row of catalog.rows()) add(row.name_vi, 'products');
  try {
    const items = await require('./faqStore').all();
    for (const item of items || []) add(item.product, 'faq');
  } catch (err) {
    console.error('FAQ catalog skipped:', err.message);
  }
  return entries;
}

function pageIdentity(row) {
  if (!row || row.direction !== 'out') return false;
  const meta = row.sender_meta || {};
  const name = meta.from_name || row.sender_label || '';
  const fromId = meta.from_id != null ? String(meta.from_id) : '';
  const pageId = meta.page_id != null ? String(meta.page_id) : '';
  if (name && lanhMark.textHasLanh(name)) return false;
  const otherHuman = name && !lanhMark.textHasLanh(name) && fromId && pageId && fromId !== pageId;
  if (otherHuman) return false;
  return !fromId || (pageId && fromId === pageId) || !name;
}

function placementOf(text, end) {
  const rest = ops.normalizeText(String(text || '').slice(end));
  if (!rest) return 'signoff';
  const tail = rest.split(' ').filter(Boolean);
  if (tail.every((token) => SIGNOFF_PARTICLES.has(token))) return 'signoff';
  return 'inline';
}

function snippetAround(text, start, end) {
  const src = String(text || '');
  const from = Math.max(0, start - PAD);
  const to = Math.min(src.length, end + PAD);
  let snippet = src.slice(from, to);
  if (from > 0) snippet = `…${snippet}`;
  if (to < src.length) snippet = `${snippet}…`;
  return pii.maskText(snippet);
}

function signatureHits(messages) {
  const hits = [];
  for (const row of messages || []) {
    if (!pageIdentity(row)) continue;
    const text = row.message_text || row.text || '';
    for (const hit of lanhMark.findLanhTokens(text)) {
      hits.push({
        substring: hit.token,
        context: snippetAround(text, hit.start, hit.end),
        placement: placementOf(text, hit.end),
      });
    }
  }
  return hits;
}

function firstCustomer(messages) {
  const row = (messages || []).find((item) => item && item.direction === 'in' && String(item.message_text || '').trim());
  if (!row) return '';
  return pii.maskText(String(row.message_text)).slice(0, CUSTOMER_CAP);
}

function threadBlob(messages) {
  return (messages || []).map((row) => row.message_text || row.text || '').join('\n');
}

function matchedCatalog(blob, entries) {
  const names = [];
  for (const entry of entries) {
    if (paddedHit(blob, entry.phrases)) names.push(entry.name);
    if (names.length >= 8) break;
  }
  return names;
}

function groupMessages(rows) {
  const byThread = new Map();
  for (const row of rows || []) {
    const list = byThread.get(row.thread_id) || [];
    list.push(row);
    byThread.set(row.thread_id, list);
  }
  return byThread;
}

function describeThread(label, messages, entries) {
  const hits = signatureHits(messages);
  const blob = threadBlob(messages);
  const catalogNames = matchedCatalog(blob, entries);
  const product = catalogNames.length > 0 || paddedHit(blob, PRODUCT_EXTRA);
  const service = paddedHit(blob, SERVICE_PHRASES);
  return {
    thread_id: label.thread_id,
    label: label.label,
    reason: label.source,
    message_count: (messages || []).length,
    signature: hits[0]
      ? {
        substring: hits[0].substring,
        context: hits[0].context,
        placement: hits[0].placement,
      }
      : null,
    first_customer: firstCustomer(messages),
    catalog_products: catalogNames,
    has_product_keyword: product,
    has_service_keyword: service,
    _hits: hits,
  };
}

function histogram(described) {
  const buckets = new Map();
  for (const thread of described) {
    const seen = new Set();
    for (const hit of thread._hits || []) {
      const row = buckets.get(hit.substring) || {
        substring: hit.substring,
        threads: 0,
        messages: 0,
        signoff_messages: 0,
        inline_messages: 0,
      };
      row.messages += 1;
      if (hit.placement === 'signoff') row.signoff_messages += 1;
      else row.inline_messages += 1;
      if (!seen.has(hit.substring)) {
        seen.add(hit.substring);
        row.threads += 1;
      }
      buckets.set(hit.substring, row);
    }
  }
  return [...buckets.values()].sort((a, b) => b.threads - a.threads || a.substring.localeCompare(b.substring));
}

function splitCounts(described) {
  const out = {
    threads: described.length,
    product: 0,
    service: 0,
    both: 0,
    product_only: 0,
    service_only: 0,
    neither: 0,
  };
  for (const thread of described) {
    if (thread.has_product_keyword) out.product += 1;
    if (thread.has_service_keyword) out.service += 1;
    if (thread.has_product_keyword && thread.has_service_keyword) out.both += 1;
    else if (thread.has_product_keyword) out.product_only += 1;
    else if (thread.has_service_keyword) out.service_only += 1;
    else out.neither += 1;
  }
  return out;
}

function emptyBucket() {
  return { staff_lanh: 0, signature: 0, keyword: 0, manual: 0, model: 0, total: 0 };
}

function countProjected(rows) {
  const counts = { dv: emptyBucket(), sale: emptyBucket(), unknown: emptyBucket() };
  for (const row of rows || []) {
    const bucket = counts[row.label];
    if (!bucket) continue;
    bucket.total += 1;
    if (Object.prototype.hasOwnProperty.call(bucket, row.source)) bucket[row.source] += 1;
  }
  return counts;
}

function publicThread(thread) {
  return {
    thread_id: thread.thread_id,
    label: thread.label,
    reason: thread.reason,
    message_count: thread.message_count,
    signature: thread.signature,
    first_customer: thread.first_customer,
    catalog_products: thread.catalog_products,
    has_product_keyword: thread.has_product_keyword,
    has_service_keyword: thread.has_service_keyword,
  };
}

async function build(input) {
  const filter = parseFilter(input || {});
  const [rows, labels, entries] = await Promise.all([
    store.all('fb'),
    store.allLabels('fb'),
    catalogEntries(),
    fbDvRule.loadProductPhrases(),
  ]);
  const byThread = groupMessages(rows);
  const existing = new Map(labels.map((row) => [row.thread_id, row]));
  const projected = [];
  const seen = new Set();
  for (const [threadId, messages] of byThread) {
    seen.add(threadId);
    projected.push(threadLabels.decideThread(messages, existing.get(threadId) || null));
  }
  for (const label of labels) {
    if (label.channel && label.channel !== 'fb') continue;
    if (seen.has(label.thread_id)) continue;
    projected.push(threadLabels.decideThread([], label));
  }
  const described = [];
  for (const label of labels) {
    if (label.channel && label.channel !== 'fb') continue;
    const messages = byThread.get(label.thread_id) || [];
    described.push(describeThread(label, messages, entries));
  }
  const signatureDv = described.filter((thread) => thread.label === 'dv' && thread.reason === 'signature');
  const selected = described
    .filter((thread) => thread.label === filter.label && thread.reason === filter.reason)
    .sort((a, b) => String(a.thread_id).localeCompare(String(b.thread_id)));
  return {
    filter,
    matched_threads: selected.length,
    threads: selected.slice(0, filter.limit).map(publicThread),
    signature_histogram: histogram(selected),
    signature_dv: splitCounts(signatureDv),
    rule_counts: countProjected(projected),
    catalog_sources: ['products', 'faq'],
    matcher: {
      topic: 'The customer\'s latest message with a topic hit wins. Page text is used only when the customer has no topic. Inside one message the later hit wins, so "xin giá phòng" is DV and a later product is Sale. Catalog and FAQ product names, price, ship, and order are Sale. Service words and FAQ service entries are DV.',
      counts_as_signature: 'A Lành sign-off is only a tiebreaker when no topic is detected: the name as the last word, ignoring punctuation, emoji, and a trailing ạ/nha/nhé/ạa, or a line that is only the name plus those particles. Inline mentions do not count. Lowercase lành counts only on a name-only line, so lành tính and hiền lành do not. lạnh and trời lạnh do not. from.name does not select the label.',
      product_only: 'A product, price, ship, or order topic is Sale even when Lành signed. Stored signature_dv.product_only still describes the saved labels, not this projection.',
      staff_name: 'from.name Lành does not select the label. staff_lanh is not written by the topic rule. A page name such as Doc Mo Farm is not a staff name.',
    },
  };
}

module.exports = {
  SERVICE_PHRASES,
  clampLimit,
  build,
};
