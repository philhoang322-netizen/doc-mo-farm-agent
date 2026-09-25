/**
 * In-process Vietnamese keyword ranker. No embeddings.
 * Each token is kept in its original form and in a diacritic-folded form.
 * Product-name synonyms come from the FAQ rows (parentheses and slash aliases).
 */
const STOP = new Set([
  'co', 'khong', 'la', 'gi', 'the', 'nao', 'duoc', 'minh', 'ban', 'farm',
  'voi', 'va', 'cho', 'thi', 'nhu', 'nay', 'tai', 'cua', 'bao', 'nhieu',
  'mot', 'cac', 'nhung', 'neu', 'khi', 'da', 'se', 'em', 'anh', 'chi',
  'oi', 'nhe', 'nha', 'ah', 'a',
]);

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function tokenize(text) {
  const raw = String(text || '').toLowerCase().match(/\p{L}+|\d+/gu) || [];
  const original = [];
  const folded = [];
  for (const token of raw) {
    if (token.length < 2 && !/^\d+$/.test(token)) continue;
    const foldedToken = fold(token);
    if (STOP.has(foldedToken)) continue;
    original.push(token);
    folded.push(foldedToken);
  }
  return { original, folded };
}

function synonymGroups(items) {
  const groups = [];
  for (const item of items) {
    const toks = [...new Set(tokenize(`${item.product || ''} ${item.variants || ''}`).folded)];
    if (toks.length) groups.push(new Set(toks));
  }
  return groups;
}

function indexDoc(item) {
  const parts = [
    [item.question, 3],
    [item.variants, 2],
    [item.product, 2],
    [item.group, 1],
  ];
  const tf = new Map();
  const original = new Set();
  for (const [text, weight] of parts) {
    const analyzed = tokenize(text);
    for (const token of analyzed.folded) tf.set(token, (tf.get(token) || 0) + weight);
    for (const token of analyzed.original) original.add(token);
  }
  let len = 0;
  for (const n of tf.values()) len += n;
  return { item, tf, original, len: len || 1 };
}

function search(items, query, limit = 5) {
  const enabled = (items || []).filter(item => item && item.enabled !== false);
  if (!enabled.length) return [];
  const analyzed = tokenize(query);
  if (!analyzed.folded.length) return [];
  const docs = enabled.map(indexDoc);
  const groups = synonymGroups(enabled);
  const qWeight = new Map();
  for (const token of analyzed.folded) qWeight.set(token, 1);
  for (const token of [...qWeight.keys()]) {
    if (qWeight.get(token) !== 1) continue;
    for (const group of groups) {
      if (!group.has(token)) continue;
      for (const sibling of group) {
        if (!qWeight.has(sibling)) qWeight.set(sibling, 0.45);
      }
    }
  }
  const df = new Map();
  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.len;
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const avgdl = totalLen / docs.length || 1;
  const N = docs.length;
  const k1 = 1.2;
  const b = 0.55;
  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const [term, weight] of qWeight) {
      const freq = doc.tf.get(term) || 0;
      if (!freq) continue;
      const docsWith = df.get(term) || 0;
      const idf = Math.log(1 + (N - docsWith + 0.5) / (docsWith + 0.5));
      const denom = freq + k1 * (1 - b + b * doc.len / avgdl);
      score += weight * idf * (freq * (k1 + 1)) / denom;
    }
    let bonus = 0;
    for (const token of analyzed.original) {
      if (doc.original.has(token)) bonus += 0.5;
    }
    const own = [...qWeight.entries()].filter(([, weight]) => weight === 1).map(([term]) => term);
    const hit = own.filter(term => doc.tf.has(term)).length;
    const cover = own.length ? hit / own.length : 0;
    score += bonus + cover * 3;
    if (cover >= 0.8) score += 2;
    if (score > 0) scored.push({ item: doc.item, score, cover });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

function confidence(best, second) {
  if (!best || !(best.score > 0)) return 0;
  let value = 1 - Math.exp(-best.score / 4);
  const ambiguous = second
    && second.item.code !== best.item.code
    && second.score >= best.score * 0.92
    && (best.cover || 0) < 0.85;
  if (ambiguous) value *= 0.55;
  return Math.round(Math.min(0.99, value) * 100) / 100;
}

module.exports = { search, confidence, fold, tokenize };
