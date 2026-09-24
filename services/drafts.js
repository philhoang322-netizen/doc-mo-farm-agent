/**
 * Outbound chat drafts for the HITL review queue.
 *
 * Persistence:
 *   - DATABASE_URL set → Postgres table outbound_drafts (migration 013).
 *   - Otherwise an in-memory Map. Railway restarts, redeploys, and crashes
 *     wipe that Map. There is no durable disk on the platform.
 *   - Optional JSON mirror for local `node server.js` only: set
 *     DRAFTS_JSON_PATH, or leave it unset outside production and the file
 *     data/drafts.json is used. Do not treat that file as durable on Railway.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const audit = require('./audit');
const zaloService = require('./zaloService');
const botService = require('./zaloBotService');
const messenger = require('./messenger');
const trainingLog = require('./trainingLog');

const STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SENT'];
const STATUS_SET = new Set(STATUSES);

// Display buckets for the ops console. approval_status in the database
// stays on the four HITL values above.
const OPS_STATUSES = ['success', 'failure', 'pending', 'sending', 'queued', 'rejected'];
const OPS_SET = new Set(OPS_STATUSES);
const MESSAGE_TYPES = ['follower', 'zns', 'broadcast'];
const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);
const BUILTIN_CHANNELS = [
  { id: 'farm', name: '@Farm', builtin: true },
  { id: 'shopee', name: 'Shopee', builtin: true },
  { id: 'fb', name: 'FB', builtin: true },
];

const LIMITS = {
  customer_name: 200,
  customer_phone: 40,
  customer_user_id: 120,
  customer_intent: 1000,
  assigned_department: 120,
  ticket_status: 120,
  draft_reply: 8000,
  kiot_summary: 4000,
  invoice_code: 80,
  customer_code: 80,
  qr_image_url: 1000,
  pii_note: 300,
  template_name: 120,
  customer_query: 2000,
};

const EDITABLE = [
  'customer_name', 'customer_phone', 'customer_user_id', 'customer_intent',
  'assigned_department', 'ticket_status', 'draft_reply', 'kiot_summary',
  'invoice_code', 'customer_code', 'qr_image_url',
];

class DraftError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// In-memory fallback used only when DATABASE_URL is unset.
// Railway restarts wipe this Map. See jsonFilePath() for the local file mirror.
const memory = new Map();
const customChannels = new Map();
let ready = null;

function storageMode() {
  return db.DB_ENABLED ? 'postgres' : 'memory';
}

function jsonFilePath() {
  if (db.DB_ENABLED) return null;
  if (process.env.DRAFTS_JSON_PATH) return process.env.DRAFTS_JSON_PATH;
  // Local convenience only. Production without a database stays memory-only
  // so an ephemeral container disk cannot look like durable storage.
  if (process.env.NODE_ENV === 'production') return null;
  return path.join(__dirname, '..', 'data', 'drafts.json');
}

function blankDraft(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    channel: fields.channel,
    customer_name: fields.customer_name,
    customer_phone: fields.customer_phone,
    customer_user_id: fields.customer_user_id,
    customer_intent: fields.customer_intent,
    assigned_department: fields.assigned_department,
    ticket_status: fields.ticket_status,
    draft_reply: fields.draft_reply,
    approval_status: 'PENDING_REVIEW',
    kiot_summary: fields.kiot_summary,
    invoice_code: fields.invoice_code,
    customer_code: fields.customer_code,
    qr_image_url: fields.qr_image_url,
    pii_note: fields.pii_note || null,
    reviewed_at: null,
    sent_at: null,
    send_error: null,
    send_via: null,
    send_hook: null,
    message_type: fields.message_type,
    template_name: fields.template_name,
    sales_channel: fields.sales_channel || 'farm',
    delivery_phase: null,
    customer_query: fields.customer_query || fields.customer_intent || null,
    ai_draft_version: fields.draft_reply,
  };
}

function opsStatus(d) {
  if (!d) return 'pending';
  if (d.delivery_phase === 'sending') return 'sending';
  if (d.approval_status === 'SENT') return 'success';
  if (d.approval_status === 'REJECTED') return 'rejected';
  if (d.send_error) return 'failure';
  if (d.approval_status === 'APPROVED') return 'queued';
  return 'pending';
}

function decorate(d) {
  if (!d) return null;
  return { ...d, ops_status: opsStatus(d) };
}

function vietnamDay(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
}

function toIso(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function fromRow(row) {
  if (!row) return null;
  return decorate({
    id: row.id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    channel: row.channel,
    customer_name: row.customer_name || null,
    customer_phone: row.customer_phone || null,
    customer_user_id: row.customer_user_id || null,
    customer_intent: row.customer_intent || null,
    assigned_department: row.assigned_department || null,
    ticket_status: row.ticket_status || null,
    draft_reply: row.draft_reply || '',
    approval_status: row.approval_status,
    kiot_summary: row.kiot_summary || null,
    invoice_code: row.invoice_code || null,
    customer_code: row.customer_code || null,
    qr_image_url: row.qr_image_url || null,
    pii_note: row.pii_note || null,
    reviewed_at: toIso(row.reviewed_at),
    sent_at: toIso(row.sent_at),
    send_error: row.send_error || null,
    send_via: row.send_via || null,
    send_hook: row.send_hook || null,
    message_type: row.message_type || null,
    template_name: row.template_name || null,
    sales_channel: row.sales_channel || 'farm',
    delivery_phase: row.delivery_phase || null,
    customer_query: row.customer_query || null,
    ai_draft_version: row.ai_draft_version || null,
  });
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS outbound_drafts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    channel             TEXT NOT NULL CHECK (channel IN ('zalo', 'messenger')),
    customer_name       TEXT,
    customer_phone      TEXT,
    customer_user_id    TEXT,
    customer_intent     TEXT,
    assigned_department TEXT,
    ticket_status       TEXT,
    draft_reply         TEXT NOT NULL DEFAULT '',
    approval_status     TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
                        CHECK (approval_status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SENT')),
    kiot_summary        TEXT,
    invoice_code        TEXT,
    customer_code       TEXT,
    qr_image_url        TEXT,
    pii_note            TEXT,
    reviewed_at         TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    send_error          TEXT,
    send_via            TEXT,
    send_hook           TEXT,
    message_type        TEXT,
    template_name       TEXT,
    sales_channel       TEXT,
    delivery_phase      TEXT,
    customer_query      TEXT,
    ai_draft_version    TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_status_created
    ON outbound_drafts (approval_status, created_at DESC);
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS message_type TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sales_channel TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS delivery_phase TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS customer_query TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS ai_draft_version TEXT;
CREATE TABLE IF NOT EXISTS sales_channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    if (db.DB_ENABLED) {
      // Separate statements: node-pg rejects multi-command prepared queries.
      for (const sql of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
        await db.pool.query(sql);
      }
      await db.pool.query(
        'ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS pii_note TEXT'
      );
    } else {
      await loadFile();
      await loadChannels();
    }
    await trainingLog.ensureReady();
  })().catch((err) => {
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
      if (row && row.id) {
        delete row.ops_status;
        memory.set(row.id, row);
      }
    }
  } catch (e) {
    console.warn('HITL draft file unreadable, starting empty:', e.message);
  }
}

async function persistFile() {
  const file = jsonFilePath();
  if (!file) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const rows = [...memory.values()].map(row => {
    const copy = { ...row };
    delete copy.ops_status;
    return copy;
  });
  await fs.promises.writeFile(tmp, JSON.stringify(rows));
  await fs.promises.rename(tmp, file);
}

function channelsFilePath() {
  const draftFile = jsonFilePath();
  if (!draftFile) return null;
  return path.join(path.dirname(draftFile), 'sales_channels.json');
}

async function loadChannels() {
  customChannels.clear();
  const file = channelsFilePath();
  if (!file || !fs.existsSync(file)) return;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const row of parsed) {
      if (row && row.id && row.name) customChannels.set(row.id, row);
    }
  } catch (e) {
    console.warn('Sales channel file unreadable, starting empty:', e.message);
  }
}

async function persistChannels() {
  const file = channelsFilePath();
  if (!file) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify([...customChannels.values()]));
  await fs.promises.rename(tmp, file);
}

function cleanChannel(v) {
  const c = String(v || '').trim().toLowerCase();
  if (c !== 'zalo' && c !== 'messenger') {
    throw new DraftError(400, 'channel phải là zalo hoặc messenger');
  }
  return c;
}

function cleanText(key, v) {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  if (!s) return null;
  if (s.length > LIMITS[key]) throw new DraftError(400, `${key} quá dài`);
  return s;
}

function cleanReply(v) {
  const s = String(v ?? '').replace(/\0/g, '').trim();
  if (s.length > LIMITS.draft_reply) throw new DraftError(400, 'draft_reply quá dài');
  return s;
}

function cleanUrl(v) {
  if (v == null || String(v).trim() === '') return null;
  let u;
  try {
    u = new URL(String(v).trim());
  } catch {
    throw new DraftError(400, 'qr_image_url không phải đường dẫn hợp lệ');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new DraftError(400, 'qr_image_url phải là http hoặc https');
  }
  if (u.href.length > LIMITS.qr_image_url) throw new DraftError(400, 'qr_image_url quá dài');
  return u.href;
}

function fieldsFrom(body, { requireReply }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DraftError(400, 'Cần một JSON object');
  }
  const reply = cleanReply(body.draft_reply);
  if (requireReply && !reply) throw new DraftError(400, 'Thiếu draft_reply');
  return {
    channel: cleanChannel(body.channel),
    customer_name: cleanText('customer_name', body.customer_name),
    customer_phone: cleanText('customer_phone', body.customer_phone),
    customer_user_id: cleanText('customer_user_id', body.customer_user_id),
    customer_intent: cleanText('customer_intent', body.customer_intent),
    assigned_department: cleanText('assigned_department', body.assigned_department),
    ticket_status: cleanText('ticket_status', body.ticket_status),
    draft_reply: reply,
    kiot_summary: cleanText('kiot_summary', body.kiot_summary),
    invoice_code: cleanText('invoice_code', body.invoice_code),
    customer_code: cleanText('customer_code', body.customer_code),
    qr_image_url: cleanUrl(body.qr_image_url),
    pii_note: cleanText('pii_note', body.pii_note),
    message_type: cleanMessageType(body.message_type),
    template_name: cleanText('template_name', body.template_name),
    customer_query: cleanText('customer_query', body.customer_query),
  };
}

function cleanMessageType(v) {
  if (v == null || String(v).trim() === '') return null;
  const t = String(v).trim().toLowerCase();
  if (!MESSAGE_TYPE_SET.has(t)) throw new DraftError(400, 'Loại tin không hợp lệ');
  return t;
}

function applyEdits(draft, body) {
  const next = { ...draft };
  if (Object.prototype.hasOwnProperty.call(body, 'channel')) {
    next.channel = cleanChannel(body.channel);
  }
  for (const key of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (key === 'draft_reply') next.draft_reply = cleanReply(body.draft_reply);
    else if (key === 'qr_image_url') next.qr_image_url = cleanUrl(body.qr_image_url);
    else next[key] = cleanText(key, body[key]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'message_type')) {
    next.message_type = cleanMessageType(body.message_type);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'template_name')) {
    next.template_name = cleanText('template_name', body.template_name);
  }
  next.updated_at = new Date().toISOString();
  return next;
}

async function insertDraft(draft) {
  if (!db.DB_ENABLED) {
    memory.set(draft.id, draft);
    await persistFile();
    return draft;
  }
  const r = await db.pool.query(
    `INSERT INTO outbound_drafts (
       id, created_at, updated_at, channel, customer_name, customer_phone,
       customer_user_id, customer_intent, assigned_department, ticket_status,
       draft_reply, approval_status, kiot_summary, invoice_code, customer_code,
       qr_image_url, pii_note, reviewed_at, sent_at, send_error, send_via, send_hook,
       message_type, template_name, sales_channel, delivery_phase,
       customer_query, ai_draft_version
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
     ) RETURNING *`,
    [
      draft.id, draft.created_at, draft.updated_at, draft.channel,
      draft.customer_name, draft.customer_phone, draft.customer_user_id,
      draft.customer_intent, draft.assigned_department, draft.ticket_status,
      draft.draft_reply, draft.approval_status, draft.kiot_summary,
      draft.invoice_code, draft.customer_code, draft.qr_image_url,
      draft.pii_note,
      draft.reviewed_at, draft.sent_at, draft.send_error, draft.send_via,
      draft.send_hook, draft.message_type, draft.template_name,
      draft.sales_channel, draft.delivery_phase,
      draft.customer_query, draft.ai_draft_version,
    ]
  );
  return fromRow(r.rows[0]);
}

async function saveDraft(draft) {
  if (!db.DB_ENABLED) {
    if (!memory.has(draft.id)) return null;
    memory.set(draft.id, draft);
    await persistFile();
    return draft;
  }
  const r = await db.pool.query(
    `UPDATE outbound_drafts SET
       channel=$2, customer_name=$3, customer_phone=$4, customer_user_id=$5,
       customer_intent=$6, assigned_department=$7, ticket_status=$8,
       draft_reply=$9, approval_status=$10, kiot_summary=$11, invoice_code=$12,
       customer_code=$13, qr_image_url=$14, pii_note=$15, reviewed_at=$16, sent_at=$17,
       send_error=$18, send_via=$19, send_hook=$20, updated_at=$21,
       message_type=$22, template_name=$23, sales_channel=$24, delivery_phase=$25,
       customer_query=$26, ai_draft_version=$27
     WHERE id=$1
     RETURNING *`,
    [
      draft.id, draft.channel, draft.customer_name, draft.customer_phone,
      draft.customer_user_id, draft.customer_intent, draft.assigned_department,
      draft.ticket_status, draft.draft_reply, draft.approval_status,
      draft.kiot_summary, draft.invoice_code, draft.customer_code,
      draft.qr_image_url, draft.pii_note, draft.reviewed_at, draft.sent_at, draft.send_error,
      draft.send_via, draft.send_hook, draft.updated_at,
      draft.message_type, draft.template_name, draft.sales_channel, draft.delivery_phase,
      draft.customer_query, draft.ai_draft_version,
    ]
  );
  return fromRow(r.rows[0]);
}

async function createDraft(body, ctx = {}) {
  await ensureReady();
  const fields = fieldsFrom(body, { requireReply: true });
  fields.sales_channel = await assertSalesChannel(
    body && body.sales_channel ? body.sales_channel : 'farm'
  );
  const draft = decorate(await insertDraft(blankDraft(fields)));
  await audit.record({
    actor: ctx.actor || 'ai',
    action: 'draft.created',
    entity_type: 'draft',
    entity_id: draft.id,
    before: null,
    after: audit.draftSnapshot(draft),
    meta: audit.draftMeta(draft),
  });
  return draft;
}

async function getDraft(id) {
  await ensureReady();
  if (!isUuid(id)) return null;
  if (!db.DB_ENABLED) return decorate(memory.get(id) || null);
  const r = await db.pool.query('SELECT * FROM outbound_drafts WHERE id=$1', [id]);
  return fromRow(r.rows[0]);
}

function normalizeListQuery(query) {
  if (typeof query === 'string' || query == null) return { status: query || null };
  return {
    status: query.status || null,
    ops: query.ops || null,
    type: query.type || null,
    salesChannel: query.salesChannel || null,
  };
}

function matchesScope(d, q) {
  const sales = d.sales_channel || 'farm';
  if (q.salesChannel && sales !== q.salesChannel) return false;
  if (q.type && d.message_type !== q.type) return false;
  return true;
}

function emptyOpsCounts() {
  return { success: 0, failure: 0, pending: 0, sending: 0, queued: 0, rejected: 0 };
}

async function listDrafts(query) {
  await ensureReady();
  const q = normalizeListQuery(query);
  if (q.status && !STATUS_SET.has(q.status)) throw new DraftError(400, 'status không hợp lệ');
  if (q.ops && !OPS_SET.has(q.ops)) throw new DraftError(400, 'ops không hợp lệ');
  if (q.type && !MESSAGE_TYPE_SET.has(q.type)) throw new DraftError(400, 'Loại tin không hợp lệ');
  if (q.salesChannel) await assertSalesChannel(q.salesChannel);

  const all = db.DB_ENABLED
    ? (await db.pool.query('SELECT * FROM outbound_drafts ORDER BY created_at DESC LIMIT 500')).rows.map(fromRow)
    : [...memory.values()].map(d => decorate(d));
  const scoped = all.filter(d => matchesScope(d, q));
  const counts = emptyOpsCounts();
  for (const d of scoped) counts[opsStatus(d)] = (counts[opsStatus(d)] || 0) + 1;
  const drafts = scoped
    .filter(d => {
      if (q.status && d.approval_status !== q.status) return false;
      if (q.ops && opsStatus(d) !== q.ops) return false;
      return true;
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 200);
  return { drafts, counts, storage: db.DB_ENABLED ? 'postgres' : 'memory' };
}

async function messageStats(salesChannel) {
  await ensureReady();
  if (salesChannel) await assertSalesChannel(salesChannel);
  const all = db.DB_ENABLED
    ? (await db.pool.query(
      `SELECT sent_at, template_name, sales_channel, approval_status
         FROM outbound_drafts
        WHERE approval_status = 'SENT'`
    )).rows.map(row => ({
      sent_at: toIso(row.sent_at),
      template_name: row.template_name || null,
      sales_channel: row.sales_channel || 'farm',
      approval_status: row.approval_status,
    }))
    : [...memory.values()].filter(d => d.approval_status === 'SENT');
  const sent = all.filter(d => !salesChannel || (d.sales_channel || 'farm') === salesChannel);
  const byDay = new Map();
  const byTemplate = new Map();
  const today = vietnamDay(new Date().toISOString());
  for (const d of sent) {
    const day = vietnamDay(d.sent_at);
    if (!day || !today) continue;
    const age = (Date.parse(today) - Date.parse(day)) / 86400000;
    if (age < 0 || age > 13) continue;
    byDay.set(day, (byDay.get(day) || 0) + 1);
    const key = (d.template_name || '').trim();
    byTemplate.set(key, (byTemplate.get(key) || 0) + 1);
  }
  return {
    byDay: [...byDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
    byTemplate: [...byTemplate.entries()]
      .map(([template_name, count]) => ({ template_name: template_name || null, count }))
      .sort((a, b) => b.count - a.count || String(a.template_name || '').localeCompare(String(b.template_name || ''), 'vi')),
  };
}

async function listChannels() {
  await ensureReady();
  if (db.DB_ENABLED) {
    const r = await db.pool.query('SELECT id, name, created_at FROM sales_channels ORDER BY name');
    const custom = r.rows.map(row => ({
      id: row.id,
      name: row.name,
      builtin: false,
      created_at: toIso(row.created_at),
    }));
    return BUILTIN_CHANNELS.concat(custom);
  }
  const custom = [...customChannels.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
  return BUILTIN_CHANNELS.concat(custom);
}

async function assertSalesChannel(id) {
  const clean = String(id || '').trim();
  if (!clean) throw new DraftError(400, 'Thiếu kênh bán');
  const channels = await listChannels();
  if (!channels.some(c => c.id === clean)) throw new DraftError(400, 'Kênh bán không có');
  return clean;
}

async function addChannel(name) {
  await ensureReady();
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > 40) {
    throw new DraftError(400, 'Tên kênh cần từ 1 đến 40 ký tự');
  }
  const channels = await listChannels();
  if (channels.some(c => c.name.toLowerCase() === clean.toLowerCase())) {
    throw new DraftError(400, 'Kênh này đã có');
  }
  const row = {
    id: 'c' + crypto.randomBytes(4).toString('hex'),
    name: clean,
    builtin: false,
    created_at: new Date().toISOString(),
  };
  if (!db.DB_ENABLED) {
    customChannels.set(row.id, row);
    await persistChannels();
    return row;
  }
  await db.pool.query(
    'INSERT INTO sales_channels (id, name, created_at) VALUES ($1,$2,$3)',
    [row.id, row.name, row.created_at]
  );
  return row;
}

function isUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

/**
 * RESPONSE STATION — the only place an approved HITL draft is delivered.
 * Webhook handlers do not call this. Filter and the model never call this.
 * A person presses Duyệt và gửi; this sends the approved text on the channel
 * stored on the draft (Facebook PSID or Zalo user id).
 *
 *   zalo + customer_user_id "bot_<chatId>" → zaloBotService.sendMessage
 *   zalo + any other user id                → zaloService.sendTextMessage (OA)
 *   messenger + customer_user_id "fb_<psid>" → messenger.sendText (Graph Send API)
 *
 * When delivery cannot run, the caller keeps approval_status = APPROVED
 * and returns `hook` so a later change can plug the missing sender in here.
 */
async function deliver(draft) {
  const text = String(draft.draft_reply || '').trim();
  if (!text) {
    return {
      ok: false,
      sent: false,
      via: null,
      hook: 'services/drafts.js deliver()',
      error: 'Bản nháp đang trống, chưa gửi.',
    };
  }

  if ((draft.sales_channel || 'farm') !== 'farm') {
    return {
      ok: false,
      sent: false,
      via: null,
      hook: 'sales_channel:' + draft.sales_channel,
      error: null,
      pendingAdapter: true,
    };
  }

  if (draft.channel === 'messenger') {
    const hook = 'services/messenger.js sendText';
    const psid = messenger.psidFromUserId(draft.customer_user_id);
    if (!psid) {
      return {
        ok: false,
        sent: false,
        via: null,
        hook,
        error: 'Thiếu PSID khách (fb_<psid>). Bản nháp giữ ở APPROVED. Hook: services/messenger.js sendText(psid, text).',
      };
    }
    if (!messenger.enabled() || !process.env.FB_PAGE_ACCESS_TOKEN) {
      return {
        ok: false,
        sent: false,
        via: null,
        hook,
        error: 'Chưa gửi được qua Messenger (bật MESSENGER_ENABLED và đặt FB_PAGE_ACCESS_TOKEN). Bản nháp giữ ở APPROVED. Hook: services/messenger.js sendText(psid, text).',
      };
    }
    try {
      const result = await messenger.sendText(psid, text);
      if (!result || !result.ok) {
        const detail = (result && result.error) || messenger.getLastError() || 'Facebook từ chối tin nhắn';
        return {
          ok: false,
          sent: false,
          via: null,
          hook,
          error: `Facebook chưa gửi được: ${detail}. Bản nháp giữ ở APPROVED. Hook: services/messenger.js sendText(psid, text).`,
        };
      }
      let qrError = null;
      if (draft.qr_image_url && !text.includes(draft.qr_image_url)) {
        const qr = await messenger.sendImage(psid, draft.qr_image_url);
        if (!qr || !qr.ok) qrError = 'Đã gửi nội dung, chưa gửi được ảnh QR.';
      }
      return { ok: true, sent: true, via: 'messenger', hook, error: qrError };
    } catch (e) {
      return {
        ok: false,
        sent: false,
        via: null,
        hook,
        error: `${e.message}. Bản nháp giữ ở APPROVED. Hook: services/messenger.js sendText(psid, text).`,
      };
    }
  }

  const uid = String(draft.customer_user_id || '').trim();
  if (!uid) {
    return {
      ok: false,
      sent: false,
      via: null,
      hook: 'zaloService.sendTextMessage',
      error: 'Thiếu user id khách. Bản nháp giữ ở APPROVED. Hook: zaloService.sendTextMessage(userId, text).',
    };
  }

  try {
    if (uid.startsWith('bot_')) {
      const chatId = uid.slice(4);
      if (!chatId || !process.env.ZALO_BOT_TOKEN) {
        return {
          ok: false,
          sent: false,
          via: null,
          hook: 'zaloBotService.sendMessage',
          error: 'Chưa gửi được qua Zalo Bot (thiếu ZALO_BOT_TOKEN hoặc chat id). Bản nháp giữ ở APPROVED. Hook: zaloBotService.sendMessage(chatId, text).',
        };
      }
      const result = await botService.sendMessage(chatId, text);
      if (!result) {
        return {
          ok: false,
          sent: false,
          via: null,
          hook: 'zaloBotService.sendMessage',
          error: 'Zalo Bot API không gửi được. Bản nháp giữ ở APPROVED. Hook: zaloBotService.sendMessage(chatId, text).',
        };
      }
      let qrError = null;
      if (draft.qr_image_url) {
        const photo = await botService.sendPhoto(chatId, draft.qr_image_url, 'Mã QR thanh toán');
        if (!photo) qrError = 'Đã gửi nội dung, chưa gửi được ảnh QR.';
      }
      return { ok: true, sent: true, via: 'zalo_bot', hook: 'zaloBotService.sendMessage', error: qrError };
    }

    if (!zaloService.getTokens().accessToken) {
      return {
        ok: false,
        sent: false,
        via: null,
        hook: 'zaloService.sendTextMessage',
        error: 'Chưa có token Zalo OA (ZALO_ACCESS_TOKEN). Bản nháp giữ ở APPROVED. Hook: zaloService.sendTextMessage(userId, text).',
      };
    }
    const result = await zaloService.sendTextMessage(uid, text);
    if (!result) {
      const last = zaloService.getLastError();
      const detail = last && typeof last === 'object'
        ? (last.message || JSON.stringify(last))
        : (last || 'Zalo từ chối tin nhắn');
      return {
        ok: false,
        sent: false,
        via: null,
        hook: 'zaloService.sendTextMessage',
        error: `Zalo OA chưa gửi được: ${detail}. Bản nháp giữ ở APPROVED. Hook: zaloService.sendTextMessage(userId, text).`,
      };
    }
    let qrError = null;
    if (draft.qr_image_url && !text.includes(draft.qr_image_url)) {
      const qr = await zaloService.sendTextMessage(uid, draft.qr_image_url);
      if (!qr) qrError = 'Đã gửi nội dung. Ảnh QR gửi kèm bằng link vì OA helper chỉ có tin chữ, và lần gửi link chưa thành công.';
    }
    return { ok: true, sent: true, via: 'zalo_oa', hook: 'zaloService.sendTextMessage', error: qrError };
  } catch (e) {
    const hook = uid.startsWith('bot_') ? 'zaloBotService.sendMessage' : 'zaloService.sendTextMessage';
    return {
      ok: false,
      sent: false,
      via: null,
      hook,
      error: `${e.message}. Bản nháp giữ ở APPROVED. Hook: ${hook}.`,
    };
  }
}

const chains = new Map();
function withLock(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const tail = next.then(() => {}, () => {});
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return next;
}

function sameText(a, b) {
  return String(a ?? '') === String(b ?? '');
}

const CONTENT_KEYS = [
  'channel', 'customer_name', 'customer_phone', 'customer_user_id', 'customer_intent',
  'assigned_department', 'ticket_status', 'draft_reply', 'kiot_summary',
  'invoice_code', 'customer_code', 'qr_image_url',
];

function contentChanged(before, after) {
  return CONTENT_KEYS.some(key => !sameText(before[key], after[key]));
}

async function writeDraftAudit(existing, saved, { actor, wantSend, send }) {
  const meta = audit.draftMeta(saved);
  if (contentChanged(existing, saved)) {
    await audit.record({
      actor,
      action: 'draft.edited',
      entity_type: 'draft',
      entity_id: saved.id,
      before: audit.draftSnapshot(existing),
      after: audit.draftSnapshot(saved),
      meta,
    });
  }
  if (wantSend) {
    await audit.record({
      actor,
      action: 'draft.approved',
      entity_type: 'draft',
      entity_id: saved.id,
      before: audit.draftSnapshot(existing),
      after: audit.draftSnapshot({ ...saved, approval_status: 'APPROVED' }),
      meta,
    });
    await audit.record({
      actor,
      action: send && send.sent ? 'draft.sent' : 'draft.send_failed',
      entity_type: 'draft',
      entity_id: saved.id,
      before: { approval_status: existing.approval_status },
      after: {
        approval_status: saved.approval_status,
        draft_reply: saved.draft_reply,
        send_via: saved.send_via,
        send_error: saved.send_error,
      },
      meta,
    });
    return;
  }
  if (saved.approval_status === existing.approval_status) return;
  let action = 'draft.status_changed';
  if (saved.approval_status === 'APPROVED') action = 'draft.approved';
  else if (saved.approval_status === 'REJECTED') action = 'draft.rejected';
  else if (saved.approval_status === 'PENDING_REVIEW') action = 'draft.reopened';
  await audit.record({
    actor,
    action,
    entity_type: 'draft',
    entity_id: saved.id,
    before: audit.draftSnapshot(existing),
    after: audit.draftSnapshot(saved),
    meta,
  });
}

async function updateDraft(id, body, ctx = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DraftError(400, 'Cần một JSON object');
  }
  const input = { ...body };
  const named = ctx.actorName != null ? ctx.actorName : input.actor_name;
  delete input.actor_name;
  if (input.approval_status === 'SENT' && input.send !== true) {
    throw new DraftError(400, 'Không đặt SENT trực tiếp. Dùng send: true để gửi.');
  }
  if (input.approval_status && input.approval_status !== 'SENT' && !STATUS_SET.has(input.approval_status)) {
    throw new DraftError(400, 'approval_status không hợp lệ');
  }
  await ensureReady();
  if (!isUuid(id)) return null;
  const actor = ctx.actor || audit.managerActor(named);

  return withLock(id, async () => {
    const existing = await getDraft(id);
    if (!existing) return null;
    let next = applyEdits(existing, input);
    if (Object.prototype.hasOwnProperty.call(input, 'sales_channel')) {
      next.sales_channel = await assertSalesChannel(input.sales_channel);
    }
    const wantSend = input.send === true;
    let send = null;

    if (wantSend) {
      if (existing.approval_status === 'SENT') {
        return {
          draft: existing,
          send: { ok: false, sent: false, via: existing.send_via, hook: null, error: 'Tin này đã gửi rồi.' },
        };
      }
      if (input.approval_status === 'REJECTED') {
        throw new DraftError(400, 'Không gửi một bản nháp đang từ chối.');
      }
      next.approval_status = 'APPROVED';
      next.reviewed_at = new Date().toISOString();
      next.sent_at = null;
      next.delivery_phase = 'sending';
      next.send_error = null;
      await saveDraft(next);
      try {
        await trainingLog.storeIfEdited(next);
      } catch (e) {
        console.error('Training log failed:', e.message);
      }
      send = await deliver(next);
      next.delivery_phase = null;
      if (send.pendingAdapter) {
        next.approval_status = 'APPROVED';
        next.send_via = null;
        next.sent_at = null;
        next.send_error = null;
      } else if (send.sent) {
        next.approval_status = 'SENT';
        next.sent_at = new Date().toISOString();
        next.send_via = send.via;
      } else {
        next.approval_status = 'APPROVED';
        next.send_via = null;
        next.sent_at = null;
      }
      next.send_hook = send.hook || null;
      if (!send.pendingAdapter) next.send_error = send.error || null;
    } else if (Object.prototype.hasOwnProperty.call(input, 'approval_status')) {
      next.approval_status = input.approval_status;
      next.delivery_phase = null;
      if (input.approval_status === 'PENDING_REVIEW') {
        next.reviewed_at = null;
        next.sent_at = null;
        next.send_error = null;
        next.send_via = null;
        next.send_hook = null;
      } else {
        next.reviewed_at = new Date().toISOString();
      }
    }

    const saved = await saveDraft(next);
    if (!saved) return { draft: null, send };
    await writeDraftAudit(existing, saved, { actor, wantSend, send });
    await maybeClaimHandover(existing, saved, body);
    return { draft: decorate(saved), send };
  });
}

/**
 * Approve-flow hook. Setting ticket_status to NEEDS_HUMAN, or sending
 * claim:true, assigns the thread. Approving or sending a normal sales
 * draft does not. A failure here must not undo the saved draft.
 */
async function maybeClaimHandover(existing, saved, body) {
  try {
    const handover = require('./handover');
    const claim = body.claim === true || body.claimed === true;
    const was = handover.classifyHumanNeed({ ticketStatus: existing.ticket_status });
    const now = handover.classifyHumanNeed({
      ticketStatus: saved.ticket_status,
      claim,
    });
    if (!claim && !(now && !was)) return;
    await handover.escalate({
      reason: claim
        ? 'Nhân viên đánh dấu claim — cần người trực'
        : 'Bản nháp được đánh dấu NEEDS_HUMAN',
      urgency: 'high',
      externalId: saved.customer_user_id,
      customer: {
        display_name: saved.customer_name,
        phone: saved.customer_phone,
      },
      lastMessage: saved.customer_intent,
      draftId: saved.id,
      ticketStatus: saved.ticket_status,
      claim,
      needsHuman: !claim && String(saved.ticket_status || '').includes('NEEDS_HUMAN'),
    });
  } catch (e) {
    console.error('Handover from draft update failed:', e.message);
  }
}

module.exports = {
  STATUSES,
  OPS_STATUSES,
  MESSAGE_TYPES,
  BUILTIN_CHANNELS,
  DraftError,
  storageMode,
  opsStatus,
  createDraft,
  listDrafts,
  getDraft,
  updateDraft,
  listChannels,
  addChannel,
  messageStats,
};
