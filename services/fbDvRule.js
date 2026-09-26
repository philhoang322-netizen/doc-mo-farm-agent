/**
 * FB-DV labeling rule. Pure code: no model calls.
 *
 * A page signature is a Lành sign-off, not an inline mention.
 * A sign-off thread that mentions a catalog product and no service
 * wording is Sale. DV keywords are learned only from signature threads
 * that do talk about the service.
 */
const ops = require('./ops');
const catalog = require('./catalog');

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
  'check in',
  'booking',
];

const SALES_TOKENS = new Set(['gia', 'ship', 'dat', 'mua']);

let productCache = null;

function resetForTests() {
  productCache = null;
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

function hasService(text) {
  return paddedHit(text, SERVICE_WORDS);
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

async function loadProductPhrases() {
  const names = catalog.rows().map((row) => row.name_vi);
  try {
    const items = await require('./faqStore').all();
    for (const item of items || []) {
      if (item && item.product) names.push(item.product);
    }
  } catch (err) {
    console.error('FAQ products skipped:', err.message);
  }
  productCache = collectPhrases(names);
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

module.exports = {
  SERVICE_WORDS,
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
};
