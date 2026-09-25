/**
 * Manager corrections captured when an AI draft is edited before Approve & Send.
 *
 * Similarity (no embedding index in this repo): fold the customer message and
 * each stored customer_original_query to lowercase without diacritics, then
 * count shared keywords of length >= 3, ignoring a few function words.
 * Same sales_channel only. An example is used when it shares at least two
 * keywords, or one keyword of length >= 5. Otherwise it is left out — a
 * recent but unrelated correction is not injected. Top 3 by overlap, then
 * recency. ILIKE-style containment is the same token check.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./database');

const ACTION = 'STORE_AS_FEW_SHOT_EXAMPLE';
/** Unedited approvals are still examples, but they rank below a real correction. */
const APPROVED_WEIGHT = 0.35;
const CORRECTION_WEIGHT = 1;
const STOP = new Set([
  'anh', 'chi', 'em', 'minh', 'ban', 'da', 'khong', 'duoc', 'mot',
  'cai', 'nay', 'roi', 'nhe', 'voi', 'cua', 'thi', 'cho', 'lam',
  'the', 'nao', 'xin', 'chao', 'hoi', 'giup',
]);

const memory = [];
let ready = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS training_logs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    draft_id                    UUID,
    sales_channel               TEXT,
    customer_original_query     TEXT NOT NULL DEFAULT '',
    customer_intent             TEXT,
    ai_draft_version            TEXT NOT NULL,
    manager_corrected_version   TEXT NOT NULL,
    action                      TEXT NOT NULL DEFAULT 'STORE_AS_FEW_SHOT_EXAMPLE',
    example_kind                TEXT,
    example_weight              REAL,
    actor                       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_logs_draft
    ON training_logs (draft_id) WHERE draft_id IS NOT NULL;
`;

function jsonFilePath() {
  if (db.DB_ENABLED) return null;
  if (process.env.TRAINING_LOG_PATH) return process.env.TRAINING_LOG_PATH;
  if (process.env.DRAFTS_JSON_PATH) {
    return path.join(path.dirname(process.env.DRAFTS_JSON_PATH), 'training_logs.json');
  }
  if (process.env.NODE_ENV === 'production') return null;
  return path.join(__dirname, '..', 'data', 'training_logs.json');
}

function toIso(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function trainingLog(row) {
  return {
    customer_original_query: row.customer_original_query || '',
    ai_draft_version: row.ai_draft_version,
    manager_corrected_version: row.manager_corrected_version,
    action: row.action || ACTION,
    example_kind: row.example_kind || null,
    example_weight: row.example_weight == null ? null : Number(row.example_weight),
    actor: row.actor || null,
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: toIso(row.created_at),
    draft_id: row.draft_id || null,
    sales_channel: row.sales_channel || 'farm',
    customer_intent: row.customer_intent || null,
    ...trainingLog(row),
  };
}

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    if (db.DB_ENABLED) {
    for (const sql of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
      await db.pool.query(sql);
    }
    await db.pool.query('ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS example_kind TEXT');
    await db.pool.query('ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS example_weight REAL');
    await db.pool.query('ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS actor TEXT');
    return;
    }
    await loadFile();
  })().catch(err => {
    ready = null;
    throw err;
  });
  return ready;
}

async function loadFile() {
  const file = jsonFilePath();
  if (!file || !fs.existsSync(file)) return;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!Array.isArray(parsed)) return;
    memory.splice(0, memory.length, ...parsed.filter(row => row && row.id));
  } catch (e) {
    console.warn('Training log unreadable, starting empty:', e.message);
  }
}

async function persistFile() {
  const file = jsonFilePath();
  if (!file) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(memory));
  await fs.promises.rename(tmp, file);
}

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd');
}

function tokens(s) {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

function overlapScore(example, query) {
  const q = new Set(tokens(query));
  if (!q.size) return 0;
  const src = new Set(tokens(
    `${example.customer_original_query || ''} ${example.customer_intent || ''}`
  ));
  let n = 0;
  let long = false;
  for (const word of src) {
    if (!q.has(word)) continue;
    n += 1;
    if (word.length >= 5) long = true;
  }
  if (n >= 2 || long) return n + (long ? 1 : 0);
  return 0;
}

async function alreadyStored(draftId) {
  if (!draftId) return false;
  if (!db.DB_ENABLED) return memory.some(row => row.draft_id === draftId);
  const r = await db.pool.query('SELECT 1 FROM training_logs WHERE draft_id = $1 LIMIT 1', [draftId]);
  return r.rows.length > 0;
}

/**
 * Store a pair only when the approved text differs from the frozen AI draft.
 * Unchanged approvals are skipped. Returns the row, or null when skipped.
 */
async function storeIfEdited(draft) {
  const original = String(draft && draft.ai_draft_version || '').trim();
  const corrected = String(draft && draft.draft_reply || '').trim();
  if (!original || !corrected || original === corrected) return null;
  return storeOnApprove(draft, { actor: null });
}

/**
 * Store the sent reply when the manager left learning on.
 * An edit is a correction (weight 1). An unchanged approval is a
 * lower-weight approved example (weight 0.35). Returns null when
 * learning is off, the reply is empty, or this draft was already stored.
 */
async function storeOnApprove(draft, opts = {}) {
  await ensureReady();
  if (!draft || opts.learn === false) return null;
  const original = String(draft.ai_draft_version || '').trim();
  const corrected = String(draft.draft_reply || '').trim();
  if (!corrected) return null;
  if (await alreadyStored(draft.id)) return null;
  const edited = !original || original !== corrected;
  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    draft_id: draft.id || null,
    sales_channel: draft.sales_channel || 'farm',
    customer_original_query: String(draft.customer_query || draft.customer_intent || '').trim(),
    customer_intent: draft.customer_intent || null,
    ai_draft_version: original,
    manager_corrected_version: corrected,
    action: ACTION,
    example_kind: edited ? 'correction' : 'approved',
    example_weight: edited ? CORRECTION_WEIGHT : APPROVED_WEIGHT,
    actor: opts.actor ? String(opts.actor).slice(0, 120) : null,
  };
  if (!db.DB_ENABLED) {
    memory.push(row);
    await persistFile();
    return fromRow(row);
  }
  const r = await db.pool.query(
    `INSERT INTO training_logs (
       id, created_at, draft_id, sales_channel, customer_original_query,
       customer_intent, ai_draft_version, manager_corrected_version, action,
       example_kind, example_weight, actor
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      row.id, row.created_at, row.draft_id, row.sales_channel,
      row.customer_original_query, row.customer_intent, row.ai_draft_version,
      row.manager_corrected_version, row.action,
      row.example_kind, row.example_weight, row.actor,
    ]
  );
  return fromRow(r.rows[0]);
}

async function listRecent(limit = 50) {
  await ensureReady();
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  if (!db.DB_ENABLED) {
    return memory.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, n).map(fromRow);
  }
  const r = await db.pool.query(
    'SELECT * FROM training_logs ORDER BY created_at DESC LIMIT $1',
    [n]
  );
  return r.rows.map(fromRow);
}

async function relevantExamples(query, salesChannel, limit = 3) {
  await ensureReady();
  const channel = salesChannel || 'farm';
  const cap = Math.max(1, Math.min(5, Number(limit) || 3));
  let rows;
  if (!db.DB_ENABLED) {
    rows = memory.filter(row => (row.sales_channel || 'farm') === channel);
  } else {
    const r = await db.pool.query(
      `SELECT * FROM training_logs
        WHERE COALESCE(sales_channel, 'farm') = $1
        ORDER BY created_at DESC
        LIMIT 80`,
      [channel]
    );
    rows = r.rows.map(fromRow);
  }
  return rows
    .map(row => ({ row, score: overlapScore(row, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      const aw = a.score * weightOf(a.row) * roleFactor(a.row);
      const bw = b.score * weightOf(b.row) * roleFactor(b.row);
      if (bw !== aw) return bw - aw;
      return a.row.created_at < b.row.created_at ? 1 : -1;
    })
    .slice(0, cap)
    .map(item => item.row);
}

function weightOf(row) {
  const n = Number(row && row.example_weight);
  if (Number.isFinite(n) && n > 0) return n;
  return CORRECTION_WEIGHT;
}

/** Manager corrections outrank sale/dv when the overlap is otherwise equal. */
function roleFactor(row) {
  const actor = String((row && row.actor) || '');
  if (!actor || actor.startsWith('manager')) return 1;
  return 0.6;
}

function clip(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

/** Text appended to the uncached system block before the model generates. */
async function promptBlock(query, salesChannel) {
  const examples = await relevantExamples(query, salesChannel, 3);
  if (!examples.length) return '';
  const body = examples.map((ex, i) => {
    const role = ex.example_kind === 'approved'
      ? 'Quản lý đã duyệt (không sửa, trọng số thấp hơn)'
      : 'Quản lý gửi';
    return (
      `Ví dụ ${i + 1}\n` +
      `Khách: ${clip(ex.customer_original_query, 400) || '(không lưu câu khách)'}\n` +
      `Bản AI: ${clip(ex.ai_draft_version, 500) || '(trống)'}\n` +
      `${role}: ${clip(ex.manager_corrected_version, 500)}`
    );
  }).join('\n\n');
  return (
    '\n\nCÂU QUẢN LÝ ĐÃ SỬA — khi câu khách gần các ví dụ này, ưu tiên giọng và cách viết của quản lý. ' +
    'Không đổi giá, không thêm khuyến mãi ngoài tài liệu.\n' +
    body
  );
}

module.exports = {
  ACTION,
  APPROVED_WEIGHT,
  CORRECTION_WEIGHT,
  ensureReady,
  storeIfEdited,
  storeOnApprove,
  listRecent,
  relevantExamples,
  promptBlock,
  trainingLog,
};
