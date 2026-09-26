/**
 * Manual Sale/DV moves as topic-weight training.
 * Pure code: no model calls. The folded inbound text stays in the database
 * (or the in-memory fallback). Stats and samples return n-grams only.
 */
const crypto = require('crypto');
const db = require('./database');
const ops = require('./ops');
const fbDvRule = require('./fbDvRule');
const fbNotices = require('../public/admin/fb-notices');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS label_moves (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('fb', 'zalo')),
    thread_id TEXT NOT NULL,
    from_label TEXT,
    to_label TEXT NOT NULL CHECK (to_label IN ('sale', 'dv')),
    actor TEXT,
    moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    inbound_text TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_label_moves_moved ON label_moves (moved_at DESC)`,
];

const STOP = new Set([
  'la', 'va', 'cua', 'cho', 'minh', 'ban', 'shop', 'da', 'em', 'anh', 'chi',
  'khong', 'co', 'gi', 'nao', 'the', 'voi', 'mot', 'nha', 'oi', 'ha', 'uh',
  'nhung', 'nay', 'roi', 'lam', 'giup', 'nhe', 'duc', 'qua', 'toi', 'a',
  'vang', 'ok', 'hi', 'hello', 'alo', 'chao', 'xin', 'ua', 'um', 'dạ',
]);

const GREETINGS = new Set([
  'xin chao', 'chao shop', 'alo shop', 'hi shop', 'hello', 'chao ban',
  'chao anh', 'chao chi', 'chao em',
]);

/** A clear topic rule. One move adds at most MOVE_UNIT per phrase. */
const BASE = 2;
const MOVE_UNIT = 1;
const PHRASE_CAP = 2.5;
const DOC_CAP = 2.5;
const FLOOR = 0.8;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_N = 8;

let memory = [];
let weights = { sale: new Map(), dv: new Map() };
let moveCount = { total: 0, sale: 0, dv: 0 };
let ready = null;

function resetForTests() {
  memory = [];
  weights = { sale: new Map(), dv: new Map() };
  moveCount = { total: 0, sale: 0, dv: 0 };
  ready = null;
}

async function ensure() {
  if (!db.DB_ENABLED) return;
  if (ready) return ready;
  ready = (async () => {
    for (const sql of SCHEMA) await db.pool.query(sql);
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

function clip(value, max) {
  const s = String(value || '').replace(/\0/g, '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function decay(movedAt, now) {
  const t = Date.parse(movedAt);
  if (!Number.isFinite(t)) return MOVE_UNIT;
  const weeks = Math.max(0, (now - t) / WEEK_MS);
  return Math.max(0.4, Math.pow(0.85, weeks));
}

function ngrams(text) {
  if (fbNotices.describe(text)) return [];
  const kept = ops.normalizeText(fbNotices.stripUrls(text))
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP.has(token) && !fbNotices.noisePhrase(token));
  const out = [];
  for (const token of kept) {
    if (token.length >= 5 && !GREETINGS.has(token)) out.push(token);
  }
  for (let i = 0; i < kept.length - 1; i += 1) {
    const pair = `${kept[i]} ${kept[i + 1]}`;
    if (GREETINGS.has(pair) || pair.length < 4 || fbNotices.noisePhrase(pair)) continue;
    out.push(pair);
  }
  return out;
}

function catalogHit(phrase) {
  const products = fbDvRule.productPhrases();
  if (products.has(phrase)) return true;
  for (const name of products) {
    if (name.includes(' ') && ` ${name} `.includes(` ${phrase} `)) return true;
  }
  return false;
}

function addWeight(map, phrase, amount) {
  map.set(phrase, Math.min(PHRASE_CAP, (map.get(phrase) || 0) + amount));
}

function rebuild(rows, now = Date.now()) {
  const sale = new Map();
  const dv = new Map();
  const count = { total: 0, sale: 0, dv: 0 };
  for (const row of rows || []) {
    if (!row || (row.to_label !== 'sale' && row.to_label !== 'dv')) continue;
    count.total += 1;
    count[row.to_label] += 1;
    const factor = MOVE_UNIT * decay(row.moved_at, now);
    const side = row.to_label === 'dv' ? dv : sale;
    for (const phrase of new Set(ngrams(row.inbound_text || ''))) {
      if (catalogHit(phrase)) {
        addWeight(sale, phrase, factor);
        continue;
      }
      addWeight(side, phrase, factor);
    }
  }
  weights = { sale, dv };
  moveCount = count;
  return weights;
}

async function allRows() {
  await ensure();
  if (!db.DB_ENABLED) return memory.slice();
  const r = await db.pool.query('SELECT * FROM label_moves ORDER BY moved_at ASC');
  return r.rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    thread_id: row.thread_id,
    from_label: row.from_label || null,
    to_label: row.to_label,
    actor: row.actor || null,
    moved_at: row.moved_at instanceof Date ? row.moved_at.toISOString() : row.moved_at,
    inbound_text: row.inbound_text || '',
  }));
}

async function recompute(now) {
  await fbDvRule.loadProductPhrases();
  rebuild(await allRows(), now);
  return summary();
}

function scoreText(text) {
  const seen = new Set();
  let sale = 0;
  let dv = 0;
  for (const phrase of ngrams(text)) {
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    sale += weights.sale.get(phrase) || 0;
    dv += weights.dv.get(phrase) || 0;
  }
  return { sale: Math.min(DOC_CAP, sale), dv: Math.min(DOC_CAP, dv) };
}

function messageText(row) {
  return String((row && (row.message_text || row.text)) || '');
}

function scoreMessages(messages) {
  const rows = messages || [];
  let fallback = { sale: 0, dv: 0 };
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.direction === 'out') continue;
    const scores = scoreText(messageText(row));
    fallback = scores;
    if (scores.sale > 0 || scores.dv > 0) return scores;
  }
  return fallback;
}

/**
 * Base topic weight plus capped learned weights.
 * A sign-off is not a topic, so learned weights replace it.
 * One move cannot outvote a clear topic unless several of its phrases match.
 */
function combine(base, scores) {
  const learnedSale = Math.min(DOC_CAP, Number(scores && scores.sale) || 0);
  const learnedDv = Math.min(DOC_CAP, Number(scores && scores.dv) || 0);
  const topical = base && base.source !== 'signature' && (base.label === 'sale' || base.label === 'dv');
  const sale = (topical && base.label === 'sale' ? BASE : 0) + learnedSale;
  const dv = (topical && base.label === 'dv' ? BASE : 0) + learnedDv;
  if (sale < FLOOR && dv < FLOOR) return base || null;
  if (Math.abs(sale - dv) < 0.2) return base || null;
  const label = dv > sale ? 'dv' : 'sale';
  if (base && base.label === label && base.source !== 'signature') return base;
  return { label, source: 'keyword', confidence: 0.72 };
}

function topList(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([phrase, weight]) => ({
      phrase,
      weight: Math.round(weight * 100) / 100,
    }));
}

function summary() {
  return {
    manual_moves: { total: moveCount.total, sale: moveCount.sale, dv: moveCount.dv },
    learned_ngrams: {
      sale: topList(weights.sale),
      dv: topList(weights.dv),
    },
  };
}

async function record(input) {
  const channel = input && (input.channel === 'fb' || input.channel === 'zalo') ? input.channel : null;
  const threadId = clip(input && input.threadId, 200);
  const toLabel = input && (input.toLabel === 'sale' || input.toLabel === 'dv') ? input.toLabel : null;
  if (!channel || !threadId || !toLabel) return null;
  const from = input.fromLabel === 'sale' || input.fromLabel === 'dv' || input.fromLabel === 'unknown'
    ? input.fromLabel
    : null;
  const row = {
    id: crypto.randomUUID(),
    channel,
    thread_id: threadId,
    from_label: from,
    to_label: toLabel,
    actor: clip(input.actor, 80) || null,
    moved_at: input.movedAt || new Date().toISOString(),
    inbound_text: clip(ops.normalizeText(input.inboundText), 400),
  };
  await ensure();
  if (!db.DB_ENABLED) memory.push(row);
  else {
    await db.pool.query(
      `INSERT INTO label_moves
        (id, channel, thread_id, from_label, to_label, actor, moved_at, inbound_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id, row.channel, row.thread_id, row.from_label, row.to_label, row.actor, row.moved_at, row.inbound_text]
    );
  }
  await recompute();
  return { id: row.id, to_label: row.to_label };
}

module.exports = {
  resetForTests,
  ngrams,
  recompute,
  scoreMessages,
  combine,
  summary,
  record,
  BASE,
  PHRASE_CAP,
};
