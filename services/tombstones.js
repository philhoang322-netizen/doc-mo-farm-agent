/**
 * Minimal record that a source message was deleted from /admin.
 *
 * Stores channel, source message id, deleted_by, and deleted_at.
 * Never stores the message body, the reply, or the customer name.
 * Đồng bộ tin bị sót and webhook retries consult this so a hard-deleted
 * draft is not created again after the row is gone.
 */
const fs = require('fs');
const path = require('path');
const db = require('./database');

const memory = new Map();
let ready = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deleted_message_tombstones (
    channel        TEXT NOT NULL,
    source_msg_id  TEXT NOT NULL,
    deleted_by     TEXT,
    deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel, source_msg_id)
);
`;

function channelKey(channel) {
  if (channel === 'messenger') return 'messenger';
  if (channel === 'zalo' || channel === 'oa' || channel === 'bot') return 'zalo';
  return channel ? String(channel) : '';
}

function jsonFilePath() {
  if (db.DB_ENABLED) return null;
  if (process.env.TOMBSTONE_JSON_PATH) return process.env.TOMBSTONE_JSON_PATH;
  if (process.env.DRAFTS_JSON_PATH) {
    return path.join(path.dirname(process.env.DRAFTS_JSON_PATH), 'tombstones.json');
  }
  if (process.env.NODE_ENV === 'production') return null;
  return path.join(__dirname, '..', 'data', 'tombstones.json');
}

function mapKey(channel, sourceMsgId) {
  return channelKey(channel) + '\0' + String(sourceMsgId || '').trim();
}

function rowOf(input) {
  const channel = channelKey(input && input.channel);
  const sourceMsgId = String((input && (input.sourceMsgId || input.source_msg_id)) || '').trim().slice(0, 200);
  if (!channel || !sourceMsgId) return null;
  const who = input.deletedBy || input.deleted_by || null;
  const at = input.deletedAt || input.deleted_at || new Date().toISOString();
  return {
    channel,
    source_msg_id: sourceMsgId,
    deleted_by: who ? String(who).slice(0, 120) : null,
    deleted_at: new Date(at).toISOString(),
  };
}

function fromDb(row) {
  if (!row) return null;
  const at = row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at;
  return {
    channel: row.channel,
    source_msg_id: row.source_msg_id,
    deleted_by: row.deleted_by || null,
    deleted_at: at,
  };
}

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    if (db.DB_ENABLED) {
      for (const sql of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
        await db.pool.query(sql);
      }
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
    memory.clear();
    for (const row of parsed) {
      const clean = rowOf(row);
      if (clean) memory.set(mapKey(clean.channel, clean.source_msg_id), clean);
    }
  } catch (e) {
    console.warn('tombstone file unreadable, starting empty:', e.message);
  }
}

async function persistFile() {
  const file = jsonFilePath();
  if (!file) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify([...memory.values()]));
  await fs.promises.rename(tmp, file);
}

async function record(input) {
  await ensureReady();
  const row = rowOf(input);
  if (!row) return null;
  if (!db.DB_ENABLED) {
    memory.set(mapKey(row.channel, row.source_msg_id), row);
    await persistFile();
    return { ...row };
  }
  const r = await db.pool.query(
    `INSERT INTO deleted_message_tombstones (channel, source_msg_id, deleted_by, deleted_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel, source_msg_id) DO NOTHING
     RETURNING channel, source_msg_id, deleted_by, deleted_at`,
    [row.channel, row.source_msg_id, row.deleted_by, row.deleted_at]
  );
  if (r.rows[0]) return fromDb(r.rows[0]);
  return get(row.channel, row.source_msg_id);
}

async function get(channel, sourceMsgId) {
  await ensureReady();
  const id = String(sourceMsgId || '').trim();
  const key = channelKey(channel);
  if (!key || !id) return null;
  if (!db.DB_ENABLED) return memory.get(mapKey(key, id)) || null;
  const r = await db.pool.query(
    `SELECT channel, source_msg_id, deleted_by, deleted_at
       FROM deleted_message_tombstones
      WHERE channel = $1 AND source_msg_id = $2`,
    [key, id]
  );
  return fromDb(r.rows[0]);
}

async function isBlocked(channel, sourceMsgId) {
  const row = await get(channel, sourceMsgId);
  return !!row;
}

module.exports = {
  channelKey,
  ensureReady,
  record,
  get,
  isBlocked,
};
