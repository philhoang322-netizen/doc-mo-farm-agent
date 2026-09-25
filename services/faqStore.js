/**
 * Approved FAQ rows and versioned bot rules.
 * Postgres when DATABASE_URL is set; otherwise memory (tests, local).
 * Nothing here is seeded from the public repo.
 */
const db = require('./database');
const { DEFAULT_RULES } = require('./faqPersona');

const memory = new Map();
let ruleVersions = [];
let ready = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS faq_items (
    code           TEXT PRIMARY KEY,
    item_group     TEXT NOT NULL DEFAULT '',
    product        TEXT NOT NULL DEFAULT '',
    question       TEXT NOT NULL,
    variants       TEXT NOT NULL DEFAULT '',
    answer         TEXT NOT NULL DEFAULT '',
    conditions     TEXT NOT NULL DEFAULT '',
    action_flag    TEXT NOT NULL,
    verify_status  TEXT NOT NULL,
    source         TEXT NOT NULL DEFAULT '',
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_faq_items_enabled ON faq_items (enabled)`,
  `CREATE TABLE IF NOT EXISTS bot_rule_versions (
    version     INTEGER PRIMARY KEY,
    body        TEXT NOT NULL,
    actor       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

function toIso(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function shape(row) {
  if (!row) return null;
  const enabled = !(row.enabled === false || row.enabled === 'f' || row.enabled === 'false');
  return {
    code: row.code,
    group: row.group != null ? row.group : (row.item_group || ''),
    product: row.product || '',
    question: row.question || '',
    variants: row.variants || '',
    answer: row.answer || '',
    conditions: row.conditions || '',
    action_flag: row.action_flag,
    verify_status: row.verify_status,
    source: row.source || '',
    enabled,
    updated_at: toIso(row.updated_at),
  };
}

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    if (!db.DB_ENABLED) return;
    for (const sql of SCHEMA) await db.pool.query(sql);
  })().catch(err => {
    ready = null;
    throw err;
  });
  return ready;
}

async function all() {
  await ensureReady();
  if (!db.DB_ENABLED) return [...memory.values()].map(shape);
  const r = await db.pool.query('SELECT * FROM faq_items ORDER BY code');
  return r.rows.map(shape);
}

async function enabledItems() {
  const rows = await all();
  return rows.filter(item => item.enabled);
}

async function countEnabled() {
  const rows = await enabledItems();
  return rows.length;
}

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

async function list(q) {
  const rows = await all();
  const needle = fold(q).trim();
  if (!needle) return rows;
  return rows.filter(item => fold([
    item.code, item.group, item.product, item.question, item.answer, item.action_flag,
  ].join(' ')).includes(needle));
}

async function get(code) {
  const key = String(code || '').trim();
  if (!key) return null;
  await ensureReady();
  if (!db.DB_ENABLED) return shape(memory.get(key) || null);
  const r = await db.pool.query('SELECT * FROM faq_items WHERE code = $1', [key]);
  return shape(r.rows[0] || null);
}

async function replaceAll(items) {
  await ensureReady();
  const now = new Date().toISOString();
  const rows = items.map(item => ({ ...item, updated_at: now }));
  if (!db.DB_ENABLED) {
    memory.clear();
    for (const item of rows) memory.set(item.code, item);
    return all();
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM faq_items');
    for (const item of rows) {
      await client.query(
        `INSERT INTO faq_items (
          code, item_group, product, question, variants, answer, conditions,
          action_flag, verify_status, source, enabled, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          item.code, item.group || '', item.product || '', item.question,
          item.variants || '', item.answer || '', item.conditions || '',
          item.action_flag, item.verify_status, item.source || '',
          item.enabled !== false, now,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
    throw err;
  } finally {
    client.release();
  }
  return all();
}

async function update(code, patch) {
  const item = await get(code);
  if (!item) return null;
  const next = { ...item };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'answer')) {
    next.answer = String(patch.answer ?? '').replace(/\0/g, '').trim().slice(0, 8000);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    next.enabled = !!patch.enabled;
  }
  next.updated_at = new Date().toISOString();
  await ensureReady();
  if (!db.DB_ENABLED) {
    memory.set(next.code, next);
    return shape(next);
  }
  const r = await db.pool.query(
    `UPDATE faq_items SET answer = $2, enabled = $3, updated_at = $4 WHERE code = $1 RETURNING *`,
    [next.code, next.answer, next.enabled, next.updated_at]
  );
  return shape(r.rows[0] || null);
}

function defaultRules() {
  return { version: 0, body: DEFAULT_RULES, actor: null, created_at: null };
}

async function currentRules() {
  await ensureReady();
  if (!db.DB_ENABLED) {
    return ruleVersions.length ? ruleVersions[ruleVersions.length - 1] : defaultRules();
  }
  const r = await db.pool.query(
    'SELECT version, body, actor, created_at FROM bot_rule_versions ORDER BY version DESC LIMIT 1'
  );
  if (!r.rows[0]) return defaultRules();
  return {
    version: r.rows[0].version,
    body: r.rows[0].body,
    actor: r.rows[0].actor || null,
    created_at: toIso(r.rows[0].created_at),
  };
}

async function saveRules(body, actor) {
  const text = String(body ?? '').replace(/\0/g, '').trim();
  if (!text) {
    const err = new Error('Quy tắc đang trống');
    err.status = 400;
    throw err;
  }
  if (text.length > 20000) {
    const err = new Error('Quy tắc quá dài');
    err.status = 400;
    throw err;
  }
  await ensureReady();
  const current = await currentRules();
  const version = (current.version || 0) + 1;
  const row = {
    version,
    body: text,
    actor: actor ? String(actor).slice(0, 120) : null,
    created_at: new Date().toISOString(),
  };
  if (!db.DB_ENABLED) {
    ruleVersions.push(row);
    return row;
  }
  const r = await db.pool.query(
    `INSERT INTO bot_rule_versions (version, body, actor, created_at)
     VALUES ($1, $2, $3, $4) RETURNING version, body, actor, created_at`,
    [row.version, row.body, row.actor, row.created_at]
  );
  return {
    version: r.rows[0].version,
    body: r.rows[0].body,
    actor: r.rows[0].actor || null,
    created_at: toIso(r.rows[0].created_at),
  };
}

function resetForTests() {
  memory.clear();
  ruleVersions = [];
}

module.exports = {
  ensureReady,
  all,
  enabledItems,
  countEnabled,
  list,
  get,
  replaceAll,
  update,
  currentRules,
  saveRules,
  resetForTests,
};
