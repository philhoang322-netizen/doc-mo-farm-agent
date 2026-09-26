/**
 * FB-DV labeling rule. Pure code: no model calls.
 *
 * The customer's latest message that hits a topic decides. Page text is
 * used only when the customer never hits a topic. A product, a price,
 * shipping, or an order is Sale. Service wording and FAQ service entries
 * are DV. A Lành sign-off is only a tiebreaker when nothing has a topic.
 * DV keywords are learned only from service-topic DV threads.
 */
const ops = require('./ops');
const catalog = require('./catalog');
const lanhMark = require('./lanhMark');

const SERVICE_WORDS = [
  'phong',
  'farmstay',
  'luu tru',
  'nghi dem',
  'qua dem',
  'su kien',
  'chuong trinh',
  'team building',
  'cam trai',
  've',
  'tham quan',
  'trai nghiem',
  'booking',
];

/** Price, shipping, and ordering goods. Bare "dat" is not included, so "đặt phòng" stays a service hit. */
const GOODS_WORDS = [
  'gia',
  'xin gia',
  'ship',
  'phi ship',
  'giao hang',
  'dat hang',
  'dat mua',
  'mua',
  'order',
  'van chuyen',
];

const SALES_TOKENS = new Set(['gia', 'ship', 'dat', 'mua']);
const SERVICE_GROUPS = new Set(['dv', 'dich vu', 'service']);

let productCache = null;
let serviceCache = null;

function resetForTests() {
  productCache = null;
  serviceCache = null;
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

function servicePhrases() {
  const extra = serviceCache ? [...serviceCache] : [];
  return [...SERVICE_WORDS, ...extra];
}

function hasService(text) {
  return paddedHit(text, servicePhrases());
}

function phrasesFromName(name) {
  const folded = ops.normalizeText(name);
  if (!folded || folded.length < 4) return [];
  const tokens = folded.split(' ').filter((token) => token.length >= 2);
  const out = [];
  if (tokens.length >= 2 || folded.length >= 6) out.push(folded);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const pair = `${tokens[i]} ${tokens[i + 1]}`;
    if (pair.length >= 4) out.push(pair);
  }
  return out;
}

function collectPhrases(names) {
  const set = new Set();
  for (const name of names) {
    for (const phrase of phrasesFromName(name)) set.add(phrase);
  }
  return set;
}

function threadBlob(messages) {
  return (messages || []).map((row) => (row && (row.message_text || row.text)) || '').join('\n');
}

function faqIsService(item) {
  if (!item) return false;
  const group = ops.normalizeText(item.group || '');
  if (SERVICE_GROUPS.has(group)) return true;
  return paddedHit(`${item.group || ''} ${item.product || ''}`, SERVICE_WORDS);
}

async function loadProductPhrases() {
  const productNames = catalog.rows().map((row) => row.name_vi);
  const serviceNames = [];
  try {
    const items = await require('./faqStore').all();
    for (const item of items || []) {
      if (!item) continue;
      if (faqIsService(item)) {
        if (item.product) serviceNames.push(item.product);
        if (item.group) serviceNames.push(item.group);
      } else if (item.product) {
        productNames.push(item.product);
      }
    }
  } catch (err) {
    console.error('FAQ products skipped:', err.message);
  }
  productCache = collectPhrases(productNames);
  serviceCache = collectPhrases(serviceNames);
  return productCache;
}

function productPhrases() {
  if (productCache) return productCache;
  return collectPhrases(catalog.rows().map((row) => row.name_vi));
}

function hasProduct(text) {
  return paddedHit(text, [...productPhrases()]);
}

function isProductOnly(messages) {
  const blob = threadBlob(messages);
  if (hasService(blob)) return false;
  return hasProduct(blob);
}

function blockedKeyword(phrase) {
  const n = ops.normalizeText(phrase);
  if (!n) return true;
  const tokens = n.split(' ').filter(Boolean);
  if (tokens.some((token) => SALES_TOKENS.has(token))) return true;
  const products = productPhrases();
  if (products.has(n)) return true;
  for (const name of products) {
    if (name.includes(' ') && ` ${name} `.includes(` ${n} `)) return true;
  }
  return false;
}

/** Start index of the rightmost whole-phrase hit, or -1. */
function lastHitIndex(text, phrases) {
  const folded = ops.normalizeText(text);
  if (!folded) return -1;
  const hay = ` ${folded} `;
  let best = -1;
  for (const phrase of phrases) {
    const n = ops.normalizeText(phrase);
    if (!n) continue;
    const at = hay.lastIndexOf(` ${n} `);
    if (at > best) best = at;
  }
  return best;
}

/**
 * Rightmost topic in one message. A later service word beats an earlier
 * price word ("xin giá phòng" is DV). A later product beats an earlier
 * room word. The same start index counts as Sale.
 * @returns {'sale'|'dv'|null}
 */
function topicOf(text) {
  const serviceAt = lastHitIndex(text, servicePhrases());
  const productAt = lastHitIndex(text, [...productPhrases(), ...GOODS_WORDS]);
  if (serviceAt < 0 && productAt < 0) return null;
  if (productAt >= serviceAt) return 'sale';
  return 'dv';
}

function messageText(row) {
  return String((row && (row.message_text || row.text)) || '');
}

function latestTopic(messages, inboundOnly) {
  const rows = messages || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    const inbound = row.direction !== 'out';
    if (inboundOnly !== inbound) continue;
    const topic = topicOf(messageText(row));
    if (topic) return topic;
  }
  return null;
}

function isPageSignoff(row) {
  if (!row || row.direction !== 'out') return false;
  const meta = row.sender_meta || {};
  const name = meta.from_name || row.sender_label || '';
  const fromId = meta.from_id != null ? String(meta.from_id) : '';
  const pageId = meta.page_id != null ? String(meta.page_id) : '';
  const otherHuman = name && !lanhMark.textHasLanh(name) && fromId && pageId && fromId !== pageId;
  if (otherHuman) return false;
  const pageIdentity = !fromId || (pageId && fromId === pageId) || !name;
  if (!pageIdentity) return false;
  return lanhMark.isSignoff(messageText(row));
}

/**
 * Customer topic first. Page text only when no inbound message has a topic.
 * Sign-off only when the thread has no topic at all. from.name is ignored.
 * @returns {{label:'dv'|'sale', source:'keyword'|'signature', confidence:number}|null}
 */
function decide(messages) {
  const topic = latestTopic(messages, true) || latestTopic(messages, false);
  if (topic === 'dv') return { label: 'dv', source: 'keyword', confidence: 0.85 };
  if (topic === 'sale') return { label: 'sale', source: 'keyword', confidence: 0.85 };
  if ((messages || []).some(isPageSignoff)) {
    return { label: 'dv', source: 'signature', confidence: 0.55 };
  }
  return null;
}

module.exports = {
  SERVICE_WORDS,
  GOODS_WORDS,
  resetForTests,
  paddedHit,
  hasService,
  hasProduct,
  isProductOnly,
  threadBlob,
  loadProductPhrases,
  productPhrases,
  blockedKeyword,
  phrasesFromName,
  topicOf,
  decide,
  faqIsService,
};
