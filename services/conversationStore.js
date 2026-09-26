/**
 * Durable thread history for Facebook Messenger and Zalo.
 *
 * Bodies stay in this table (or the in-memory fallback). Callers must not
 * log message text. source_msg_id is unique so webhook retries, echoes, and
 * a second backfill do not duplicate a row.
 */
const crypto = require('crypto');
const db = require('./database');
const fbNotices = require('../public/admin/fb-notices');

const memory = new Map();
const labels = new Map();
let ready = null;
let memBackfill = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversation_messages (
    source_msg_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('fb', 'zalo')),
    thread_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    sender_label TEXT,
    message_text TEXT,
    attachments_summary TEXT,
    created_time TIMESTAMPTZ NOT NULL,
    sender_meta JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread
    ON conversation_messages (channel, thread_id, created_time)`,
  `CREATE TABLE IF NOT EXISTS thread_labels (
    channel TEXT NOT NULL CHECK (channel IN ('fb', 'zalo')),
    thread_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (label IN ('sale', 'dv', 'unknown')),
    source TEXT NOT NULL CHECK (source IN ('staff_lanh', 'signature', 'keyword', 'manual', 'model')),
    confidence REAL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel, thread_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fb_backfill_state (
    id INTEGER PRIMARY KEY,
    months INTEGER,
    cursor TEXT,
    threads INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    pages INTEGER NOT NULL DEFAULT 0,
    rate_limits INTEGER NOT NULL DEFAULT 0,
    skipped_old INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    already INTEGER NOT NULL DEFAULT 0,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

function resetForTests() {
  memory.clear();
  labels.clear();
  memBackfill = null;
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
  if (value == null) return null;
  const s = String(value).replace(/\0/g, '');
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function cleanMeta(meta) {
  const src = meta && typeof meta === 'object' ? meta : {};
  const out = {};
  if (src.from_name) out.from_name = String(src.from_name).slice(0, 120);
  if (src.from_id != null && String(src.from_id)) out.from_id = String(src.from_id).slice(0, 64);
  if (src.to_id != null && String(src.to_id)) out.to_id = String(src.to_id).slice(0, 64);
  if (src.page_id != null && String(src.page_id)) out.page_id = String(src.page_id).slice(0, 64);
  if (src.app_id != null && String(src.app_id) !== '') out.app_id = String(src.app_id).slice(0, 64);
  if (Array.isArray(src.tags) && src.tags.length) {
    out.tags = src.tags.map((t) => String(t).slice(0, 80)).filter(Boolean).slice(0, 20);
  }
  const kinds = ['greeting', 'post', 'ad', 'story', 'comment', 'reel'];
  if (kinds.includes(src.system_notice)) out.system_notice = src.system_notice;
  if (src.story_url && /^https?:\/\//i.test(String(src.story_url))) {
    out.story_url = String(src.story_url).slice(0, 500);
  }
  if (src.story_id) out.story_id = String(src.story_id).slice(0, 120);
  return out;
}

function noticeMeta(text, meta) {
  const out = cleanMeta(meta);
  const notice = fbNotices.describe(text);
  if (!notice) return out;
  out.system_notice = notice.kind;
  if (notice.url) out.story_url = notice.url.slice(0, 500);
  if (notice.storyId) out.story_id = String(notice.storyId).slice(0, 120);
  return out;
}

function fromRow(row) {
  if (!row) return null;
  const meta = row.sender_meta && typeof row.sender_meta === 'object'
    ? row.sender_meta
    : {};
  return {
    source_msg_id: row.source_msg_id,
    channel: row.channel,
    thread_id: row.thread_id,
    direction: row.direction,
    sender_label: row.sender_label || null,
    message_text: row.message_text || '',
    attachments_summary: row.attachments_summary || null,
    created_time: toIso(row.created_time),
    sender_meta: cleanMeta(meta),
  };
}

function labelFromRow(row) {
  if (!row) return null;
  return {
    channel: row.channel,
    thread_id: row.thread_id,
    label: row.label,
    source: row.source,
    confidence: row.confidence == null ? null : Number(row.confidence),
    updated_at: toIso(row.updated_at),
  };
}

function hashId(channel, threadId, text, summary) {
  const h = crypto.createHash('sha256').update(`${text || ''}|${summary || ''}`).digest('hex').slice(0, 16);
  return `local_${channel}_${threadId}_${h}`;
}

async function getById(sourceMsgId) {
  await ensure();
  if (!db.DB_ENABLED) return memory.get(sourceMsgId) || null;
  const r = await db.pool.query(
    'SELECT * FROM conversation_messages WHERE source_msg_id=$1',
    [sourceMsgId]
  );
  return fromRow(r.rows[0]);
}

async function mergeExisting(existing, incoming) {
  const sender_label = existing.sender_label || incoming.sender_label || null;
  const message_text = existing.message_text || incoming.message_text || '';
  const attachments_summary = existing.attachments_summary || incoming.attachments_summary || null;
  const sender_meta = noticeMeta(message_text, {
    ...cleanMeta(existing.sender_meta),
    ...cleanMeta(incoming.sender_meta),
  });
  const next = {
    ...existing,
    sender_label,
    message_text,
    attachments_summary,
    sender_meta,
  };
  if (!db.DB_ENABLED) {
    memory.set(existing.source_msg_id, next);
    return next;
  }
  await db.pool.query(
    `UPDATE conversation_messages SET
       sender_label=$2,
       message_text=$3,
       attachments_summary=$4,
       sender_meta=$5::jsonb
     WHERE source_msg_id=$1`,
    [
      existing.source_msg_id,
      sender_label,
      message_text,
      attachments_summary,
      JSON.stringify(sender_meta),
    ]
  );
  return next;
}

/**
 * Insert one message. A repeated source_msg_id updates missing metadata only.
 * @returns {{inserted:boolean}|null}
 */
async function record(input) {
  if (!input) return null;
  const channel = input.channel === 'fb' || input.channel === 'zalo' ? input.channel : null;
  const threadId = clip(input.thread_id, 160);
  const direction = input.direction === 'in' || input.direction === 'out' ? input.direction : null;
  const sourceMsgId = clip(input.source_msg_id, 200);
  if (!channel || !threadId || !direction || !sourceMsgId) return null;

  const row = {
    source_msg_id: sourceMsgId,
    channel,
    thread_id: threadId,
    direction,
    sender_label: clip(input.sender_label, 120),
    message_text: clip(input.message_text, 8000) || '',
    attachments_summary: clip(input.attachments_summary, 200),
    created_time: toIso(input.created_time),
    sender_meta: null,
  };
  row.sender_meta = noticeMeta(row.message_text, input.sender_meta);

  await ensure();
  const existing = await getById(sourceMsgId);
  if (existing) {
    await mergeExisting(existing, row);
    return { inserted: false };
  }

  if (!db.DB_ENABLED) {
    memory.set(sourceMsgId, row);
    return { inserted: true };
  }
  try {
    await db.pool.query(
      `INSERT INTO conversation_messages (
         source_msg_id, channel, thread_id, direction, sender_label,
         message_text, attachments_summary, created_time, sender_meta
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        row.source_msg_id,
        row.channel,
        row.thread_id,
        row.direction,
        row.sender_label,
        row.message_text,
        row.attachments_summary,
        row.created_time,
        JSON.stringify(row.sender_meta),
      ]
    );
    return { inserted: true };
  } catch (err) {
    if (err && err.code === '23505') return { inserted: false };
    throw err;
  }
}

async function recordOutbound(input) {
  const channel = input && input.channel;
  const threadId = input && input.thread_id;
  const text = input && input.text != null ? String(input.text) : '';
  const summary = input && input.attachments_summary ? String(input.attachments_summary) : null;
  const source = input && input.source_msg_id
    ? String(input.source_msg_id)
    : hashId(channel, threadId, text, summary);
  return record({
    channel,
    thread_id: threadId,
    direction: 'out',
    sender_label: input && input.sender_label,
    message_text: text,
    attachments_summary: summary,
    created_time: new Date().toISOString(),
    source_msg_id: source,
    sender_meta: input && input.sender_meta,
  });
}

async function recordPipelineInbound(p) {
  if (!p) return null;
  const channel = p.channel === 'messenger'
    ? 'fb'
    : (p.channel === 'oa' || p.channel === 'bot' || p.channel === 'zalo' ? 'zalo' : null);
  if (!channel) return null;
  const threadId = channel === 'fb'
    ? (String(p.externalKey || '').startsWith('fb_')
      ? String(p.externalKey)
      : (p.replyTo ? `fb_${p.replyTo}` : ''))
    : String(p.externalKey || p.replyTo || '');
  const mid = p.msgId ? String(p.msgId) : '';
  if (!threadId || !mid) return null;
  const meta = {};
  if (p.senderName) meta.from_name = String(p.senderName).slice(0, 120);
  return record({
    channel,
    thread_id: threadId,
    direction: 'in',
    sender_label: p.senderName || null,
    message_text: p.text || '',
    attachments_summary: p.kind ? String(p.kind).slice(0, 40) : null,
    created_time: new Date().toISOString(),
    source_msg_id: mid,
    sender_meta: meta,
  });
}

function toIdList(to) {
  const ids = [];
  const push = (item) => {
    if (item && item.id != null && String(item.id)) ids.push(String(item.id));
  };
  if (!to) return ids;
  if (Array.isArray(to)) {
    to.forEach(push);
    return ids;
  }
  push(to);
  if (Array.isArray(to.data)) to.data.forEach(push);
  return ids;
}

function summarizeAttachments(attachments) {
  const list = Array.isArray(attachments)
    ? attachments
    : (attachments && Array.isArray(attachments.data) ? attachments.data : []);
  if (!list.length) return null;
  const counts = {};
  for (const item of list) {
    const type = String((item && item.type) || 'file').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'file';
    counts[type] = (counts[type] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, n]) => (n > 1 ? `${type}×${n}` : type))
    .join(', ')
    .slice(0, 200);
}

function tagList(tags) {
  const list = Array.isArray(tags) ? tags : (tags && Array.isArray(tags.data) ? tags.data : []);
  return list.map((tag) => {
    if (typeof tag === 'string') return tag;
    if (tag && tag.name) return String(tag.name);
    return '';
  }).filter(Boolean);
}

/**
 * One Messenger webhook event. Echoes (page replies) are direction out.
 * Customer messages are direction in. No mid → nothing stored.
 */
async function recordMessengerEvent(ev, pageId) {
  const msg = ev && ev.message;
  if (!msg) return null;
  const mid = msg.mid != null ? String(msg.mid).trim() : '';
  if (!mid) return null;
  const sender = ev.sender && ev.sender.id != null ? String(ev.sender.id) : '';
  const recipient = ev.recipient && ev.recipient.id != null ? String(ev.recipient.id) : '';
  const page = pageId ? String(pageId) : '';
  const echo = msg.is_echo === true || (page && sender === page);
  const psid = echo ? recipient : sender;
  if (!psid || (page && psid === page)) return null;
  const meta = {};
  if (page) meta.page_id = page;
  if (sender) meta.from_id = sender;
  if (recipient) meta.to_id = recipient;
  if (msg.app_id != null && String(msg.app_id) !== '') meta.app_id = String(msg.app_id);
  const tags = tagList(msg.tags);
  if (tags.length) meta.tags = tags;
  const created = ev.timestamp ? new Date(Number(ev.timestamp)) : new Date();
  return record({
    channel: 'fb',
    thread_id: `fb_${psid}`,
    direction: echo ? 'out' : 'in',
    sender_label: null,
    message_text: typeof msg.text === 'string' ? msg.text : '',
    attachments_summary: summarizeAttachments(msg.attachments),
    created_time: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    source_msg_id: mid,
    sender_meta: meta,
  });
}

async function recent(channel, threadId, limit = 10) {
  const n = Math.min(50, Math.max(1, Number(limit) || 10));
  await ensure();
  if (!threadId) return [];
  if (!db.DB_ENABLED) {
    return [...memory.values()]
      .filter((row) => row.channel === channel && row.thread_id === threadId)
      .sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)))
      .slice(-n);
  }
  const r = await db.pool.query(
    `SELECT * FROM (
       SELECT * FROM conversation_messages
       WHERE channel=$1 AND thread_id=$2
       ORDER BY created_time DESC
       LIMIT $3
     ) t ORDER BY created_time ASC`,
    [channel, threadId, n]
  );
  return r.rows.map(fromRow);
}

async function all(channel) {
  await ensure();
  if (!db.DB_ENABLED) {
    return [...memory.values()]
      .filter((row) => row.channel === channel)
      .sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
  }
  const r = await db.pool.query(
    'SELECT * FROM conversation_messages WHERE channel=$1 ORDER BY created_time ASC',
    [channel]
  );
  return r.rows.map(fromRow);
}

async function count() {
  await ensure();
  if (!db.DB_ENABLED) return memory.size;
  const r = await db.pool.query('SELECT COUNT(*)::int AS n FROM conversation_messages');
  return r.rows[0].n;
}

async function promptTurns(externalKey, limit = 10) {
  const key = String(externalKey || '');
  if (!key) return [];
  const channel = key.startsWith('fb_') ? 'fb' : 'zalo';
  const rows = await recent(channel, key, limit);
  return rows.map((row) => {
    if (fbNotices.describe(row.message_text || '')) return null;
    const body = row.message_text || row.attachments_summary || '';
    if (!body) return null;
    const content = row.direction === 'out' && row.sender_label
      ? `(${row.sender_label}) ${body}`
      : body;
    return { role: row.direction === 'out' ? 'assistant' : 'user', content };
  }).filter(Boolean);
}

function metaFields(meta) {
  const fields = [];
  if (!meta) return fields;
  if (meta.from_name) fields.push('from.name');
  if (meta.from_id) fields.push('from.id');
  if (meta.to_id) fields.push('to.id');
  if (meta.app_id) fields.push('app_id');
  if (Array.isArray(meta.tags) && meta.tags.length) fields.push('tags');
  return fields;
}

/**
 * Counts and field names for page (outbound) messages. Never returns bodies.
 */
async function attributionSummary() {
  const rows = (await all('fb')).filter((row) => row.direction === 'out');
  const names = new Map();
  const tags = new Map();
  const apps = new Map();
  const fields = new Set();
  let signatureLanh = 0;
  const lanhMark = require('./lanhMark');
  for (const row of rows) {
    const meta = row.sender_meta || {};
    for (const field of metaFields(meta)) fields.add(field);
    if (meta.from_name) names.set(meta.from_name, (names.get(meta.from_name) || 0) + 1);
    for (const tag of meta.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
    if (meta.app_id) apps.set(meta.app_id, (apps.get(meta.app_id) || 0) + 1);
    if (!fbNotices.describe(row.message_text) && lanhMark.isSignoff(row.message_text)) signatureLanh += 1;
  }
  const pack = (map) => [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, 30);
  return {
    fields: [...fields].sort(),
    page_from_names: pack(names).map((item) => ({ name: item.key, count: item.count })),
    tags: pack(tags).map((item) => ({ tag: item.key, count: item.count })),
    echo_app_ids: pack(apps).map((item) => ({ app_id: item.key, count: item.count })),
    signature_lanh_count: signatureLanh,
  };
}

async function setLabel(channel, threadId, row) {
  if (!threadId || (channel !== 'fb' && channel !== 'zalo')) return null;
  const label = row && (row.label === 'sale' || row.label === 'dv' || row.label === 'unknown')
    ? row.label
    : null;
  const source = row && ['staff_lanh', 'signature', 'keyword', 'manual', 'model'].includes(row.source)
    ? row.source
    : null;
  if (!label || !source) return null;
  const saved = {
    channel,
    thread_id: String(threadId),
    label,
    source,
    confidence: row.confidence == null ? null : Number(row.confidence),
    updated_at: new Date().toISOString(),
  };
  await ensure();
  if (!db.DB_ENABLED) {
    labels.set(`${channel}:${threadId}`, saved);
    return saved;
  }
  const r = await db.pool.query(
    `INSERT INTO thread_labels (channel, thread_id, label, source, confidence, updated_at)
     VALUES ($1,$2,$3,$4,$5, NOW())
     ON CONFLICT (channel, thread_id) DO UPDATE SET
       label=EXCLUDED.label,
       source=EXCLUDED.source,
       confidence=EXCLUDED.confidence,
       updated_at=NOW()
     RETURNING *`,
    [saved.channel, saved.thread_id, saved.label, saved.source, saved.confidence]
  );
  return labelFromRow(r.rows[0]);
}

async function getLabel(channel, threadId) {
  if (!threadId) return null;
  await ensure();
  if (!db.DB_ENABLED) return labels.get(`${channel}:${threadId}`) || null;
  const r = await db.pool.query(
    'SELECT * FROM thread_labels WHERE channel=$1 AND thread_id=$2',
    [channel, threadId]
  );
  return labelFromRow(r.rows[0]);
}

async function allLabels(channel) {
  await ensure();
  if (!db.DB_ENABLED) {
    return [...labels.values()].filter((row) => !channel || row.channel === channel);
  }
  const r = channel
    ? await db.pool.query('SELECT * FROM thread_labels WHERE channel=$1', [channel])
    : await db.pool.query('SELECT * FROM thread_labels');
  return r.rows.map(labelFromRow);
}

async function loadBackfillState() {
  await ensure();
  if (!db.DB_ENABLED) return memBackfill;
  const r = await db.pool.query('SELECT * FROM fb_backfill_state WHERE id=1');
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    months: row.months,
    cursor: row.cursor || null,
    threads: row.threads || 0,
    messages: row.messages || 0,
    errors: row.errors || 0,
    pages: row.pages || 0,
    rate_limits: row.rate_limits || 0,
    skipped_old: row.skipped_old || 0,
    seen: row.seen || 0,
    already: row.already || 0,
    done: row.done === true,
  };
}

async function saveBackfillState(state) {
  const row = {
    months: state.months || null,
    cursor: state.cursor || null,
    threads: state.threads || 0,
    messages: state.messages || 0,
    errors: state.errors || 0,
    pages: state.pages || 0,
    rate_limits: state.rate_limits || 0,
    skipped_old: state.skipped_old || 0,
    seen: state.seen || 0,
    already: state.already || 0,
    done: state.done === true,
  };
  memBackfill = row;
  await ensure();
  if (!db.DB_ENABLED) return row;
  await db.pool.query(
    `INSERT INTO fb_backfill_state (
       id, months, cursor, threads, messages, errors, pages, rate_limits,
       skipped_old, seen, already, done, updated_at
     ) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (id) DO UPDATE SET
       months=EXCLUDED.months,
       cursor=EXCLUDED.cursor,
       threads=EXCLUDED.threads,
       messages=EXCLUDED.messages,
       errors=EXCLUDED.errors,
       pages=EXCLUDED.pages,
       rate_limits=EXCLUDED.rate_limits,
       skipped_old=EXCLUDED.skipped_old,
       seen=EXCLUDED.seen,
       already=EXCLUDED.already,
       done=EXCLUDED.done,
       updated_at=NOW()`,
    [
      row.months, row.cursor, row.threads, row.messages, row.errors, row.pages,
      row.rate_limits, row.skipped_old, row.seen, row.already, row.done,
    ]
  );
  return row;
}

module.exports = {
  resetForTests,
  ensure,
  record,
  recordOutbound,
  recordPipelineInbound,
  recordMessengerEvent,
  summarizeAttachments,
  recent,
  all,
  count,
  promptTurns,
  attributionSummary,
  setLabel,
  getLabel,
  allLabels,
  loadBackfillState,
  saveBackfillState,
};
