/**
 * FB-DV labeling rule. Pure code: no model calls.
 *
 * Three classes. Service wording is DV. Shipping, an order, or a real
 * product name is Sale. Price words (giá, mua, đặt, cọc, tiền) never set
 * a topic, so a later price question keeps the earlier topic. A message
 * with both a service and a product stays DV unless it also has an order
 * or shipping word. Neutral-only messages are skipped. Page text is used
 * only when the customer never states a topic. A Lành sign-off is only a
 * tiebreaker. DV keywords are learned only from service-topic DV threads.
 */
const ops = require('./ops');
const bizLine = require('./bizLine');
const catalog = require('./catalog');
const lanhMark = require('./lanhMark');

/**
 * Brand and generic tokens shared with the label sample. A catalog pair
 * that contains one of these is not a product phrase ("doc mo", "thong tin").
 */
const GENERIC_NAME_TOKENS = new Set([
  'doc', 'mo', 'farm', 'thien', 'nhien', 'thong', 'tin', 'suc', 'khoe',
  'an', 'toan', 'su', 'dung', 'hang', 'tuan', 'thu', 'gian',
  'cao', 'cap', 'combo', 'va',
]);

/** Stay, visit, and ticket wording. Bare "ve" and bare "dem" are not included. */
const SERVICE_CORE = [
  'phong',
  'dat phong',
  'farmstay',
  'homestay',
  'luu tru',
  'nghi dem',
  'qua dem',
  'nghi qua dem',
  'may dem',
  'o lai',
  'ngu lai',
  'su kien',
  'chuong trinh',
  'team building',
  'teambuilding',
  'cam trai',
  'tham quan',
  'trai nghiem',
  'booking',
  'check in',
  'check out',
  'tour',
  'tour trong ngay',
  'tiec',
  'workshop',
  'nha nghi',
  'nghi duong',
  'villa',
  'bungalow',
  'leu',
  'nhan phong',
  'tra phong',
  'bao nhieu nguoi',
  'ngay den',
  'ngay di',
  'di trong ngay',
  'dat cho',
  'phong o',
  'mua ve',
  'gia ve',
  've tham quan',
  've vao cong',
];

/** Order and shipping. These are Sale even when the message also talks about a stay. */
const ORDER_SHIP = [
  'ship',
  'phi ship',
  'giao hang',
  'van chuyen',
  'dat hang',
  'dat mua',
  'order',
  'cod',
  'gio hang',
];

/** Strong Sale that is not an order word. Product names are added from the catalog. */
const STRONG_EXTRA = [
  'con hang',
  'het hang',
  'san pham',
];

/** Never sets a topic. "gia" must not flip "gia đình", and "mua" must not flip "mùa". */
const NEUTRAL_WORDS = [
  'gia',
  'xin gia',
  'bao nhieu',
  'mua',
  'dat',
  'dat coc',
  'coc',
  'chuyen khoan',
  'tien',
];

const SALES_TOKENS = new Set([
  'gia', 'xin', 'ship', 'dat', 'mua', 'coc', 'tien', 'order', 'cod',
]);
const SERVICE_GROUPS = new Set(['dv', 'dich vu', 'service']);

let productCache = null;
let serviceCache = null;
let nounCache = null;

function resetForTests() {
  productCache = null;
  serviceCache = null;
  nounCache = null;
}

function staticServicePhrases() {
  const set = new Set();
  for (const phrase of [...SERVICE_CORE, ...bizLine.DV_PHRASES]) {
    const n = ops.normalizeText(phrase);
    if (!n || n === 've' || n === 'dem') continue;
    set.add(n);
  }
  return [...set];
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
  return [...staticServicePhrases(), ...extra];
}

function nightStay(text) {
  const folded = ops.normalizeText(text);
  if (!folded) return false;
  return /(?:^|\s)(?:\d+|may)\s+dem(?:\s|$)/.test(` ${folded} `);
}

function hasService(text) {
  return nightStay(text) || paddedHit(text, servicePhrases());
}

function nameTokens(name) {
  return ops.normalizeText(name).split(' ').filter((token) => token.length >= 2);
}

function nounsFromNames(names) {
  const nouns = new Set();
  for (const name of names) {
    for (const token of nameTokens(name)) {
      if (!GENERIC_NAME_TOKENS.has(token)) nouns.add(token);
    }
  }
  return nouns;
}

function catalogNouns() {
  if (nounCache) return nounCache;
  nounCache = nounsFromNames(catalog.rows().map((row) => row.name_vi));
  return nounCache;
}

function mentionsNoun(name, nouns) {
  const tokens = nameTokens(name);
  for (let i = 0; i < tokens.length; i += 1) {
    if (nouns.has(tokens[i])) return true;
    if (i > 0 && nouns.has(`${tokens[i - 1]} ${tokens[i]}`)) return true;
  }
  return false;
}

/**
 * Full catalog name, plus adjacent pairs that contain a catalog noun and
 * no brand/generic token. All-generic names ("doc mo", "thong tin") yield nothing.
 */
function phrasesFromName(name, nouns) {
  const folded = ops.normalizeText(name);
  if (!folded || folded.length < 4) return [];
  const tokens = nameTokens(folded);
  const content = tokens.filter((token) => !GENERIC_NAME_TOKENS.has(token));
  if (!content.length) return [];
  const known = nouns || catalogNouns();
  if (!mentionsNoun(folded, known)) return [];
  const out = [];
  if (tokens.length >= 2 || folded.length >= 6) out.push(folded);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (GENERIC_NAME_TOKENS.has(left) || GENERIC_NAME_TOKENS.has(right)) continue;
    const pair = `${left} ${right}`;
    if (pair.length < 4) continue;
    if (!known.has(left) && !known.has(right)) continue;
    out.push(pair);
  }
  return out;
}

function collectPhrases(names, nouns) {
  const set = new Set();
  for (const name of names) {
    for (const phrase of phrasesFromName(name, nouns)) set.add(phrase);
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
  return paddedHit(`${item.group || ''} ${item.product || ''}`, staticServicePhrases());
}

function serviceNamePhrase(name) {
  const folded = ops.normalizeText(name);
  if (!folded || folded.length < 4) return [];
  if (!nameTokens(folded).some((token) => !GENERIC_NAME_TOKENS.has(token))) return [];
  return [folded];
}

async function loadProductPhrases() {
  const catalogNames = catalog.rows().map((row) => row.name_vi);
  const nouns = nounsFromNames(catalogNames);
  nounCache = nouns;
  const productNames = [...catalogNames];
  const serviceNames = [];
  try {
    const items = await require('./faqStore').all();
    for (const item of items || []) {
      if (!item) continue;
      if (faqIsService(item)) {
        if (item.product) serviceNames.push(item.product);
        if (item.group) serviceNames.push(item.group);
      } else if (item.product && mentionsNoun(item.product, nouns)) {
        productNames.push(item.product);
      }
    }
  } catch (err) {
    console.error('FAQ products skipped:', err.message);
  }
  productCache = collectPhrases(productNames, nouns);
  serviceCache = new Set();
  for (const name of serviceNames) {
    for (const phrase of serviceNamePhrase(name)) serviceCache.add(phrase);
  }
  return productCache;
}

function productPhrases() {
  if (productCache) return productCache;
  const names = catalog.rows().map((row) => row.name_vi);
  return collectPhrases(names, nounsFromNames(names));
}

function saleProductNouns() {
  const neutral = new Set();
  for (const phrase of NEUTRAL_WORDS) {
    for (const token of ops.normalizeText(phrase).split(' ')) {
      if (token) neutral.add(token);
    }
  }
  const order = new Set(ORDER_SHIP.map((phrase) => ops.normalizeText(phrase)));
  const out = [];
  for (const phrase of bizLine.SALE_PHRASES) {
    const n = ops.normalizeText(phrase);
    if (!n || order.has(n)) continue;
    const tokens = n.split(' ').filter(Boolean);
    if (tokens.some((token) => GENERIC_NAME_TOKENS.has(token) || neutral.has(token))) continue;
    out.push(n);
  }
  return out;
}

function strongPhrases() {
  return [...ORDER_SHIP, ...STRONG_EXTRA, ...saleProductNouns(), ...productPhrases()];
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

/**
 * One message. Service only is DV. Strong Sale only is Sale. Both is DV
 * unless an order or shipping word is present. Neutral words never set a
 * topic, so the caller keeps the previous topic. previous is not applied
 * here; pass it through classifyMessage.
 * @returns {'sale'|'dv'|null}
 */
function topicOf(text) {
  return classifyMessage(text, null);
}

function classifyMessage(text, previous) {
  const service = hasService(text);
  const strong = paddedHit(text, strongPhrases());
  if (service && strong) return paddedHit(text, ORDER_SHIP) ? 'sale' : 'dv';
  if (service) return 'dv';
  if (strong) return 'sale';
  return previous || null;
}

function messageText(row) {
  return String((row && (row.message_text || row.text)) || '');
}

function latestTopic(messages, inboundOnly) {
  const rows = messages || [];
  let topic = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const inbound = row.direction !== 'out';
    if (inboundOnly !== inbound) continue;
    const next = classifyMessage(messageText(row), null);
    if (next) topic = next;
  }
  return topic;
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
  SERVICE_WORDS: SERVICE_CORE,
  GOODS_WORDS: [...ORDER_SHIP, ...STRONG_EXTRA],
  GENERIC_NAME_TOKENS,
  NEUTRAL_WORDS,
  ORDER_SHIP,
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
  classifyMessage,
  decide,
  faqIsService,
};
