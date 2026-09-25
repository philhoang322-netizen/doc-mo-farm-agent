/**
 * Pure quick-entry parser and catalog matcher for the admin KiotViet form.
 * No network. The inbox loads the cached catalog, then calls matchQuickEntry.
 *
 * A line is filled only when one candidate is clearly ahead. Several
 * plausible matches, or a weak score, stay unresolved so the manager picks.
 */

const WEIGHT_TO_G = { kg: 1000, g: 1, lang: 100 };

function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(s) {
  return fold(s).replace(/\s/g, '');
}

function tokens(s) {
  return fold(s).split(' ').filter(Boolean);
}

function parseDecimal(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 1000) / 1000;
}

function normUnit(raw) {
  const u = fold(raw);
  if (!u) return null;
  if (u === 'kg' || u === 'ky' || u === 'ki') return 'kg';
  if (u === 'g' || u === 'gr' || u === 'gram') return 'g';
  if (u === 'lang' || u === 'lan') return 'lang';
  if (u === 'l' || u === 'lit' || u === 'ml') return u === 'ml' ? 'ml' : 'l';
  return null;
}

function isWeightUnit(unit) {
  const u = normUnit(unit) || fold(unit);
  return u === 'kg' || u === 'g' || u === 'lang' || u.includes('kg');
}

const UNIT_WORD = 'kg|gram|gr|ky|ký|ki|lạng|lang|ml|g|l';
const UNIT_TOKEN = '(?:' + UNIT_WORD + ')(?![a-zA-Z0-9])';
const LEADING = new RegExp(
  '^(\\d+(?:[.,]\\d+)?)\\s*(' + UNIT_TOKEN + ')?\\s*(?:x\\s+)?(.+)$',
  'i'
);
const TRAILING = new RegExp(
  '^(.+?)\\s+(?:x\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(' + UNIT_TOKEN + ')?$',
  'i'
);

function parsePhrase(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(LEADING);
  if (m && m[3] && !/^\d/.test(m[3].trim())) {
    const quantity = parseDecimal(m[1]);
    const phrase = m[3].trim();
    if (quantity != null && phrase) {
      return { quantity, unit: normUnit(m[2]), phrase, raw: s };
    }
  }
  m = s.match(TRAILING);
  if (m && m[1] && !/^\d/.test(m[1].trim())) {
    const quantity = parseDecimal(m[2]);
    const phrase = m[1].trim();
    if (quantity != null && phrase) {
      return { quantity, unit: normUnit(m[3]), phrase, raw: s };
    }
  }
  return { quantity: 1, unit: null, phrase: s, raw: s };
}

/** Split on comma, newline, semicolon, "+", or the word "và" / "va". */
function splitPhrases(text) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/[；;]/g, ',');
  const parts = [];
  // A comma between digits is a decimal (0,5), not a new line.
  const chunks = src.split(/\n+|(?<!\d)\s*,\s*(?!\d)|\s*\+\s+|\s+(?:và|va)\s+/i);
  for (const chunk of chunks) {
    const piece = String(chunk || '').trim();
    if (piece) parts.push(piece);
  }
  return parts;
}

function parseQuickEntry(text) {
  return splitPhrases(text).map(parsePhrase).filter(Boolean).slice(0, 30);
}

function nameScore(phrase, product) {
  const qFold = fold(phrase);
  const qTokens = tokens(phrase);
  const qCompact = compact(phrase);
  const nameFold = fold(product.name || '');
  const nameTokens = tokens(product.name || '');
  const nameCompact = compact(product.name || '');
  const code = compact(product.code || '');

  if (code && (code === qCompact || code === qFold.replace(/\s/g, ''))) return 100;
  if (nameFold && nameFold === qFold) return 98;
  if (qTokens.length && nameTokens.length && qTokens.every(t => nameTokens.includes(t))) {
    if (nameTokens.length === qTokens.length) return 96;
    const coverage = qTokens.length / nameTokens.length;
    return 72 + Math.round(coverage * 18);
  }
  if (qCompact.length >= 3 && nameCompact.includes(qCompact)) return 68;
  if (!qTokens.length) return 0;
  const hit = qTokens.filter(t => t.length >= 2 && nameTokens.some(nt => nt === t || nt.includes(t)));
  if (hit.length === qTokens.length) return 64;
  if (!hit.length) return 0;
  return Math.round(40 * hit.length / qTokens.length);
}

function aliasScore(phrase, product, aliases) {
  const key = compact(phrase);
  let best = 0;
  for (const alias of aliases || []) {
    if (!alias || !alias.key || !key.includes(alias.key)) continue;
    const code = String(product.code || '').toUpperCase();
    if (alias.sku && code === String(alias.sku).toUpperCase()) best = Math.max(best, 100);
    else if (compact(product.name || '').includes(alias.key)) best = Math.max(best, 84);
  }
  return best;
}

function scoreProduct(phrase, product, aliases) {
  let score = Math.max(nameScore(phrase, product), aliasScore(phrase, product, aliases));
  if (product.isActive === false) score -= 30;
  return score;
}

function convertQuantity(quantity, enteredUnit, productUnit) {
  const from = normUnit(enteredUnit);
  const to = normUnit(productUnit) || (isWeightUnit(productUnit) ? 'kg' : null);
  if (!from) return { quantity, warning: null };
  if (!to || !WEIGHT_TO_G[from] || !WEIGHT_TO_G[to]) {
    return {
      quantity,
      warning: productUnit
        ? `Bạn nhập theo ${enteredUnit}, KiotViet tính theo ${productUnit}. Kiểm lại số lượng.`
        : null,
    };
  }
  if (from === to) return { quantity, warning: null };
  const converted = quantity * WEIGHT_TO_G[from] / WEIGHT_TO_G[to];
  return { quantity: Math.round(converted * 1000) / 1000, warning: null };
}

function rankPhrase(phrase, products, aliases) {
  const pool = [];
  const inactive = [];
  for (const product of products || []) {
    const score = scoreProduct(phrase, product, aliases);
    if (score < 50) continue;
    const row = { product, score };
    if (product.isActive === false) inactive.push(row);
    else pool.push(row);
  }
  const ranked = (pool.length ? pool : inactive).sort((a, b) => {
    // A clear name/code win stays first. Close scores prefer what is in stock
    // so the dropdown leads with a sellable row, without turning a tie into a guess.
    if (Math.abs(a.score - b.score) >= 12) return b.score - a.score;
    const rank = (product) => {
      const n = Number(product.available);
      if (Number.isFinite(n) && n > 0) return 2;
      if (n === 0) return 0;
      return 1;
    };
    const stock = rank(b.product) - rank(a.product);
    if (stock) return stock;
    return b.score - a.score;
  });
  return ranked;
}

function decide(ranked) {
  const top = ranked[0];
  if (!top || top.score < 55) {
    return { status: 'unmatched', product: null, candidates: ranked.slice(0, 5) };
  }
  const second = ranked[1];
  const gap = second ? top.score - second.score : 100;
  const several = second && second.score >= 60 && gap < 12;
  if (several || top.score < 70) {
    return { status: 'ambiguous', product: null, candidates: ranked.slice(0, 5) };
  }
  return { status: 'matched', product: top.product, candidates: ranked.slice(0, 5) };
}

function publicCandidate(row) {
  const p = row.product;
  return {
    id: p.id,
    code: p.code || null,
    name: p.name || null,
    price: Number(p.price) || 0,
    unit: p.unit || null,
    available: p.available == null ? null : Number(p.available),
    isActive: p.isActive !== false,
    score: row.score,
  };
}

function matchQuickEntry(text, products, options = {}) {
  const aliases = options.aliases || [];
  const parsed = parseQuickEntry(text);
  const lines = parsed.map(entry => {
    const ranked = rankPhrase(entry.phrase, products, aliases);
    const decision = decide(ranked);
    let quantity = entry.quantity;
    let unit = entry.unit;
    let warning = null;
    if (decision.product) {
      const converted = convertQuantity(entry.quantity, entry.unit, decision.product.unit);
      quantity = converted.quantity;
      warning = converted.warning;
      unit = decision.product.unit || entry.unit || null;
    }
    return {
      status: decision.status,
      phrase: entry.phrase,
      raw: entry.raw,
      entered_quantity: entry.quantity,
      entered_unit: entry.unit,
      quantity,
      unit,
      warning,
      product: decision.product ? publicCandidate({ product: decision.product, score: ranked[0].score }) : null,
      candidates: decision.candidates.map(publicCandidate),
    };
  });
  return { lines };
}

function stripTag(s) {
  return String(s || '').replace(/^\[[^\]]+\]\s*/, '').replace(/^[^:\n]{0,40}:\s+/, '').trim();
}

function looksLikeBasket(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 240) return false;
  if (!/\d/.test(t)) return false;
  if (!/[a-zA-Zà-ỹÀ-Ỹ]{3,}/.test(t) && !/[a-z]{3,}/i.test(fold(t))) return false;
  return true;
}

/**
 * Text for the quick-entry box. Prefer the customer's own basket wording
 * so accent-less typing still reaches the matcher. Otherwise rebuild from
 * names the draft already matched.
 */
function prefillText({ customer_query, customer_intent, suggested } = {}) {
  const query = stripTag(customer_query);
  const intent = stripTag(customer_intent);
  if (looksLikeBasket(query)) return query.slice(0, 300);
  if (looksLikeBasket(intent)) return intent.slice(0, 300);
  const lines = Array.isArray(suggested) ? suggested : [];
  if (!lines.length) return '';
  return lines.map(line => {
    const qty = line.quantity == null ? 1 : line.quantity;
    return `${qty} ${line.product_name || line.name || ''}`.trim();
  }).filter(Boolean).join(', ').slice(0, 300);
}

module.exports = {
  fold,
  parseQuickEntry,
  matchQuickEntry,
  prefillText,
  convertQuantity,
  isWeightUnit,
};
