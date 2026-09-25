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
const triage = require('./triage');
const bizLine = require('./bizLine');
const inboxStatus = require('./inboxStatus');
const inboxOrder = require('../public/admin/inbox-order');
const tombstones = require('./tombstones');
const sourceTime = require('../public/admin/card-time');

const STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SENT'];
const STATUS_SET = new Set(STATUSES);

// Display buckets for the ops console. approval_status in the database
// stays on the four HITL values above.
const OPS_STATUSES = ['success', 'failure', 'pending', 'sending', 'queued', 'rejected'];
const OPS_SET = new Set(OPS_STATUSES);
const MESSAGE_TYPES = ['follower', 'zns', 'broadcast'];
const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);
const PLATFORMS = ['zalo', 'messenger'];
const PLATFORM_SET = new Set(PLATFORMS);
const GROUPS = ['zalo', 'fb-sale', 'fb-dv'];
const GROUP_SET = new Set(GROUPS);
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
  source_msg_id: 200,
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
    triage_level: fields.triage_level || null,
    triage_label: fields.triage_label || null,
    review_form: fields.review_form || emptyReviewForm(),
    biz_line: fields.biz_line === 'sale' || fields.biz_line === 'dv' ? fields.biz_line : null,
    biz_sticky: fields.biz_sticky === true,
    deleted_at: null,
    source_msg_id: fields.source_msg_id || null,
    source_received_at: sourceTime.parse(fields.source_received_at)
      || sourceTime.fromSyntheticMsgId(fields.source_msg_id),
    inbox_status: inboxStatus.FOLDER_SET.has(fields.inbox_status) ? fields.inbox_status : 'pending',
    inbox_prev_status: inboxStatus.FOLDER_SET.has(fields.inbox_prev_status) ? fields.inbox_prev_status : null,
    inbox_status_at: fields.inbox_status_at || now,
    inbox_status_auto: fields.inbox_status_auto === true,
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
  const reply = d.draft_reply || '';
  return {
    ...d,
    ops_status: opsStatus(d),
    review_form: parseStoredReviewForm(d.review_form),
    ai_suggested_draft: reply || d.ai_draft_version || '',
    inbox_status: inboxStatus.inferFolder(d),
    decline_hint: inboxStatus.suggestDecline(d),
  };
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
    triage_level: row.triage_level || null,
    triage_label: row.triage_label || null,
    review_form: row.review_form || null,
    biz_line: row.biz_line === 'sale' || row.biz_line === 'dv' ? row.biz_line : null,
    biz_sticky: row.biz_sticky === true || row.biz_sticky === 't' || row.biz_sticky === 'true',
    deleted_at: toIso(row.deleted_at),
    source_msg_id: row.source_msg_id || null,
    source_received_at: toIso(row.source_received_at),
    inbox_status: inboxStatus.FOLDER_SET.has(row.inbox_status) ? row.inbox_status : null,
    inbox_prev_status: inboxStatus.FOLDER_SET.has(row.inbox_prev_status) ? row.inbox_prev_status : null,
    inbox_status_at: toIso(row.inbox_status_at),
    inbox_status_auto: row.inbox_status_auto === true || row.inbox_status_auto === 't',
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
    ai_draft_version    TEXT,
    triage_level        TEXT,
    triage_label        TEXT,
    review_form         TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_status_created
    ON outbound_drafts (approval_status, created_at DESC);
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS message_type TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sales_channel TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS delivery_phase TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS customer_query TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS ai_draft_version TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS triage_level TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS triage_label TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS review_form TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS biz_line TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS biz_sticky BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS source_msg_id TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS source_received_at TIMESTAMPTZ;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_status TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_prev_status TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_status_at TIMESTAMPTZ;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_status_auto BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_triage
    ON outbound_drafts (triage_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_source_msg
    ON outbound_drafts (channel, source_msg_id);
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
    await tombstones.ensureReady();
    await backfillSourceTimes();
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
    delete copy.ai_suggested_draft;
    delete copy.decline_hint;
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
    ...cleanTriage(body),
    message_type: cleanMessageType(body.message_type),
    template_name: cleanText('template_name', body.template_name),
    customer_query: cleanText('customer_query', body.customer_query),
    review_form: Object.prototype.hasOwnProperty.call(body, 'review_form')
      ? cleanReviewForm(body.review_form)
      : emptyReviewForm(),
  };
}

const REFUND_DECISIONS = new Set(['hoan', 'doi', 'hoi']);
const DELIVERY_SLOTS = new Set(['all', 'sang', 'chieu', 'toi']);

function emptyReviewForm() {
  return {
    refund_decision: null,
    refund_amount: null,
    internal_note: null,
    kiot_ref: null,
    province_id: null,
    province_name: null,
    province_code: null,
    district_id: null,
    district_name: null,
    district_code: null,
    ward_id: null,
    ward_name: null,
    address_detail: null,
    address_line: null,
    delivery_slot: null,
    kiot_code: null,
    kiot_total: null,
    kiot_kind: null,
  };
}

function cleanShort(key, v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  if (!s) return null;
  if (s.length > max) throw new DraftError(400, `${key} quá dài`);
  return s;
}

function cleanReviewForm(value) {
  if (value == null || value === '') return emptyReviewForm();
  let src = value;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { throw new DraftError(400, 'review_form không hợp lệ'); }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    throw new DraftError(400, 'review_form không hợp lệ');
  }
  const out = emptyReviewForm();
  if (src.refund_decision != null && String(src.refund_decision).trim() !== '') {
    const d = String(src.refund_decision).trim();
    if (!REFUND_DECISIONS.has(d)) throw new DraftError(400, 'Quyết định hoàn tiền không hợp lệ');
    out.refund_decision = d;
  }
  if (src.delivery_slot != null && String(src.delivery_slot).trim() !== '') {
    const slot = String(src.delivery_slot).trim();
    if (!DELIVERY_SLOTS.has(slot)) throw new DraftError(400, 'Thời gian hẹn giao không hợp lệ');
    out.delivery_slot = slot;
  }
  out.refund_amount = cleanShort('refund_amount', src.refund_amount, 40);
  out.internal_note = cleanShort('internal_note', src.internal_note, 500);
  out.kiot_ref = cleanShort('kiot_ref', src.kiot_ref, 80);
  out.province_id = cleanShort('province_id', src.province_id, 32);
  out.province_name = cleanShort('province_name', src.province_name, 120);
  out.province_code = cleanShort('province_code', src.province_code, 16);
  out.district_id = cleanShort('district_id', src.district_id, 32);
  out.district_name = cleanShort('district_name', src.district_name, 120);
  out.district_code = cleanShort('district_code', src.district_code, 16);
  out.ward_id = cleanShort('ward_id', src.ward_id, 32);
  out.ward_name = cleanShort('ward_name', src.ward_name, 160);
  out.address_detail = cleanShort('address_detail', src.address_detail, 200);
  out.address_line = cleanShort('address_line', src.address_line, 300);
  const kiotCode = cleanShort('kiot_code', src.kiot_code, 40);
  if (kiotCode && !/^[A-Za-z0-9._-]+$/.test(kiotCode)) {
    throw new DraftError(400, 'Mã KiotViet không hợp lệ');
  }
  out.kiot_code = kiotCode;
  out.kiot_total = cleanShort('kiot_total', src.kiot_total, 20);
  if (src.kiot_kind != null && String(src.kiot_kind).trim() !== '') {
    const kind = String(src.kiot_kind).trim();
    if (kind !== 'invoice' && kind !== 'order') throw new DraftError(400, 'Loại chứng từ KiotViet không hợp lệ');
    out.kiot_kind = kind;
  }
  return out;
}

function parseStoredReviewForm(raw) {
  try {
    return cleanReviewForm(raw);
  } catch {
    return emptyReviewForm();
  }
}

function reviewFormJson(form) {
  return JSON.stringify(cleanReviewForm(form || emptyReviewForm()));
}

function cleanTriage(body) {
  let level = null;
  try {
    level = triage.parseLevel(body && body.triage_level);
  } catch (e) {
    throw new DraftError(e.status || 400, e.message);
  }
  return {
    triage_level: level,
    triage_label: level ? triage.labelFor(level) : null,
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
  if (Object.prototype.hasOwnProperty.call(body, 'review_form')) {
    next.review_form = cleanReviewForm(body.review_form);
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
       customer_query, ai_draft_version, triage_level, triage_label, review_form,
       biz_line, biz_sticky, deleted_at, source_msg_id,
       inbox_status, inbox_prev_status, inbox_status_at, inbox_status_auto,
       source_received_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40
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
      draft.triage_level, draft.triage_label,
      reviewFormJson(draft.review_form),
      draft.biz_line, draft.biz_sticky === true, draft.deleted_at, draft.source_msg_id,
      draft.inbox_status, draft.inbox_prev_status, draft.inbox_status_at, draft.inbox_status_auto === true,
      draft.source_received_at,
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
       customer_query=$26, ai_draft_version=$27,
       triage_level=$28, triage_label=$29, review_form=$30,
       biz_line=$31, biz_sticky=$32, deleted_at=$33, source_msg_id=$34,
       inbox_status=$35, inbox_prev_status=$36, inbox_status_at=$37, inbox_status_auto=$38,
       source_received_at=$39
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
      draft.triage_level, draft.triage_label,
      reviewFormJson(draft.review_form),
      draft.biz_line, draft.biz_sticky === true, draft.deleted_at, draft.source_msg_id,
      draft.inbox_status, draft.inbox_prev_status, draft.inbox_status_at, draft.inbox_status_auto === true,
      draft.source_received_at,
    ]
  );
  return fromRow(r.rows[0]);
}

async function backfillSourceTimes() {
  if (!db.DB_ENABLED) {
    let changed = false;
    for (const draft of memory.values()) {
      if (draft.source_received_at) continue;
      const got = sourceTime.fromSyntheticMsgId(draft.source_msg_id);
      if (!got) continue;
      draft.source_received_at = got;
      changed = true;
    }
    if (changed) await persistFile();
    return;
  }
  await db.pool.query(sourceTime.BACKFILL_SQL);
}

async function loadAllRaw() {
  await ensureReady();
  if (!db.DB_ENABLED) return [...memory.values()];
  const r = await db.pool.query(
    'SELECT * FROM outbound_drafts ORDER BY created_at DESC LIMIT 500'
  );
  return r.rows.map(fromRow);
}

function effectiveLine(d) {
  if (!d) return null;
  if (d.biz_line === 'sale' || d.biz_line === 'dv') return d.biz_line;
  if (d.channel === 'messenger') {
    return bizLine.classify(d.customer_query || d.customer_intent || '') || 'sale';
  }
  return null;
}

async function conversationLine(channel, userId) {
  if (!userId) return null;
  const all = await loadAllRaw();
  const mine = all.filter(d => d.channel === channel && d.customer_user_id === userId);
  const stickies = mine.filter(d => d.biz_sticky && (d.biz_line === 'sale' || d.biz_line === 'dv'));
  stickies.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (stickies[0]) return { biz_line: stickies[0].biz_line, biz_sticky: true };
  const labeled = mine
    .map(d => ({ d, line: effectiveLine(d) }))
    .filter(x => x.line === 'sale' || x.line === 'dv');
  labeled.sort((a, b) => String(b.d.created_at || '').localeCompare(String(a.d.created_at || '')));
  if (labeled[0]) return { biz_line: labeled[0].line, biz_sticky: false };
  return null;
}

async function bizForNewDraft(fields, body) {
  if (body && (body.biz_line === 'sale' || body.biz_line === 'dv')) {
    return { biz_line: body.biz_line, biz_sticky: body.biz_sticky === true };
  }
  const prior = await conversationLine(fields.channel, fields.customer_user_id);
  return bizLine.resolve({
    channel: fields.channel,
    text: fields.customer_query || fields.customer_intent || '',
    prior,
  });
}

async function conversationFolder(channel, userId) {
  if (!userId) return null;
  const all = await loadAllRaw();
  const mine = all.filter(d => d.channel === channel && d.customer_user_id === userId && !d.deleted_at);
  mine.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!mine[0]) return null;
  return inboxStatus.inferFolder(mine[0]);
}

async function backfillFolders(rows) {
  for (const d of rows) {
    if (!d || d.deleted_at) continue;
    if (inboxStatus.FOLDER_SET.has(d.inbox_status)) continue;
    d.inbox_status = inboxStatus.inferFolder(d);
    d.inbox_status_at = d.inbox_status_at || d.sent_at || d.updated_at || d.created_at;
    d.inbox_status_auto = false;
    await saveDraft(d);
  }
}

async function applyHesitantMove(rows, now = new Date()) {
  const due = inboxStatus.hesitantCandidates(rows, now, inboxStatus.hesitantHours());
  for (const d of due) {
    await setInboxStatus(d.id, 'hesitant', { actor: 'system', auto: true });
    d.inbox_status = 'hesitant';
  }
  return due.length;
}

async function setInboxStatus(id, to, ctx = {}) {
  await ensureReady();
  if (!inboxStatus.FOLDER_SET.has(to)) throw new DraftError(400, 'Thư mục không hợp lệ');
  const existing = await getDraft(id);
  if (!existing) return null;
  if (existing.deleted_at) throw new DraftError(400, 'Tin đã xoá');
  const from = inboxStatus.inferFolder(existing);
  if (from === 'bought' && to === 'sent') return decorate(existing);
  if (from === to) return decorate(existing);
  const next = {
    ...existing,
    inbox_status: to,
    inbox_status_at: ctx.at ? new Date(ctx.at).toISOString() : new Date().toISOString(),
    inbox_status_auto: ctx.auto === true,
    updated_at: new Date().toISOString(),
  };
  if (ctx.orderCode && !next.invoice_code) next.invoice_code = String(ctx.orderCode).slice(0, 80);
  const saved = await saveDraft(next);
  if (!saved) return null;
  await audit.record({
    actor: ctx.actor || (ctx.auto ? 'system' : 'manager'),
    action: 'draft.inbox_status',
    entity_type: 'draft',
    entity_id: saved.id,
    before: { inbox_status: from },
    after: { inbox_status: to },
    meta: {
      ...audit.draftMeta(saved),
      from,
      to,
      auto: ctx.auto === true,
      at: saved.inbox_status_at,
    },
  });
  return decorate(saved);
}

async function backfillMessengerLines(rows) {
  for (const d of rows) {
    if (!d || d.deleted_at) continue;
    if (d.channel !== 'messenger') continue;
    if (d.biz_line === 'sale' || d.biz_line === 'dv') continue;
    d.biz_line = bizLine.classify(d.customer_query || d.customer_intent || '') || 'sale';
    d.biz_sticky = false;
    await saveDraft(d);
  }
}

function groupKey(d) {
  if (!d) return null;
  if (d.channel === 'zalo') return 'zalo';
  if (d.channel === 'messenger' && d.biz_line === 'dv') return 'fb-dv';
  if (d.channel === 'messenger') return 'fb-sale';
  return null;
}

async function findBySourceMsg(channel, msgId) {
  await ensureReady();
  const id = msgId == null ? '' : String(msgId).trim();
  if (!id) return null;
  if (!db.DB_ENABLED) {
    for (const d of memory.values()) {
      if (d.channel === channel && d.source_msg_id === id) return decorate(d);
    }
    return null;
  }
  const r = await db.pool.query(
    'SELECT * FROM outbound_drafts WHERE channel=$1 AND source_msg_id=$2 ORDER BY created_at DESC LIMIT 1',
    [channel, id]
  );
  return fromRow(r.rows[0]);
}

async function createDraft(body, ctx = {}) {
  await ensureReady();
  const fields = fieldsFrom(body, { requireReply: true });
  fields.sales_channel = await assertSalesChannel(
    body && body.sales_channel ? body.sales_channel : 'farm'
  );
  const biz = await bizForNewDraft(fields, body);
  fields.biz_line = biz.biz_line;
  fields.biz_sticky = biz.biz_sticky;
  fields.source_msg_id = cleanText('source_msg_id', body && body.source_msg_id);
  fields.source_received_at = sourceTime.parse(body && body.source_received_at)
    || sourceTime.fromSyntheticMsgId(fields.source_msg_id);
  if (fields.source_msg_id && await tombstones.isBlocked(fields.channel, fields.source_msg_id)) {
    const err = new DraftError(409, 'Tin đã xoá');
    err.code = 'deleted';
    throw err;
  }
  const prevFolder = await conversationFolder(fields.channel, fields.customer_user_id);
  fields.inbox_status = 'pending';
  fields.inbox_prev_status = prevFolder && prevFolder !== 'pending' ? prevFolder : null;
  fields.inbox_status_at = new Date().toISOString();
  fields.inbox_status_auto = false;
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
    triage: query.triage || null,
    platform: query.platform || null,
    nhom: query.nhom || null,
    zline: query.zline || null,
    hop: query.hop || null,
    viewer: query.viewer || null,
  };
}

function matchesScope(d, q) {
  if (q.hop === 'deleted') {
    if (!d.deleted_at) return false;
  } else if (d.deleted_at) return false;
  if (q.hop && q.hop !== 'deleted' && inboxStatus.inferFolder(d) !== q.hop) return false;
  const sales = d.sales_channel || 'farm';
  if (q.salesChannel && sales !== q.salesChannel) return false;
  if (q.type && d.message_type !== q.type) return false;
  if (q.triage && d.triage_level !== q.triage) return false;
  if (q.platform && d.channel !== q.platform) return false;
  if (q.nhom && groupKey(d) !== q.nhom) return false;
  if (q.nhom === 'zalo' && q.zline && d.biz_line !== q.zline) return false;
  if (q.viewer === 'sale' && groupKey(d) === 'fb-dv') return false;
  if (q.viewer === 'dv') {
    const group = groupKey(d);
    const zaloDv = d.channel === 'zalo' && d.biz_line === 'dv';
    if (group !== 'fb-dv' && !zaloDv) return false;
  }
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
  if (q.triage && !triage.LABEL[q.triage]) throw new DraftError(400, 'triage không hợp lệ');
  if (q.platform && !PLATFORM_SET.has(q.platform)) throw new DraftError(400, 'Nền tảng không hợp lệ');
  if (q.nhom && !GROUP_SET.has(q.nhom)) throw new DraftError(400, 'Nhóm không hợp lệ');
  if (q.zline && q.zline !== 'sale' && q.zline !== 'dv') throw new DraftError(400, 'Nhãn không hợp lệ');
  if (q.hop && q.hop !== 'deleted' && !inboxStatus.FOLDER_SET.has(q.hop)) {
    throw new DraftError(400, 'Thư mục không hợp lệ');
  }

  const raw = await loadAllRaw();
  await backfillMessengerLines(raw);
  await backfillFolders(raw);
  await applyHesitantMove(raw);
  const all = raw.map(d => decorate(d));
  const salesScoped = all.filter(d => matchesScope(d, {
    ...q, triage: null, platform: null, nhom: null, zline: null,
  }));
  const badgeScoped = all.filter(d => {
    if (d.deleted_at) return false;
    if (q.salesChannel && (d.sales_channel || 'farm') !== q.salesChannel) return false;
    return true;
  });
  const counts = emptyOpsCounts();
  for (const d of salesScoped) counts[opsStatus(d)] = (counts[opsStatus(d)] || 0) + 1;
  const inOps = (d) => {
    if (q.ops && opsStatus(d) !== q.ops) return false;
    if (q.status && d.approval_status !== q.status) return false;
    return true;
  };
  const passesList = (d, query) => {
    if (!matchesScope(d, query)) return false;
    if (query.status && d.approval_status !== query.status) return false;
    if (query.ops && opsStatus(d) !== query.ops) return false;
    return true;
  };
  const triageCounts = { hot: 0, urgent: 0, normal: 0 };
  const triageQuery = { ...q, triage: null };
  for (const d of all) {
    if (!passesList(d, triageQuery)) continue;
    if (Object.prototype.hasOwnProperty.call(triageCounts, d.triage_level)) {
      triageCounts[d.triage_level] += 1;
    }
  }
  const platformCounts = { zalo: 0, messenger: 0 };
  for (const d of salesScoped) {
    if (!inOps(d)) continue;
    if (q.triage && d.triage_level !== q.triage) continue;
    if (d.channel === 'zalo' || d.channel === 'messenger') platformCounts[d.channel] += 1;
  }
  const groupCounts = { zalo: 0, fbSale: 0, fbDv: 0 };
  const groupQuery = {
    ...q, nhom: null, zline: null, triage: null, type: null, platform: null,
  };
  for (const d of all) {
    if (!passesList(d, groupQuery)) continue;
    const g = groupKey(d);
    if (g === 'zalo') groupCounts.zalo += 1;
    else if (g === 'fb-sale') groupCounts.fbSale += 1;
    else if (g === 'fb-dv') groupCounts.fbDv += 1;
  }
  const pendingGroupCounts = { zalo: 0, fbSale: 0, fbDv: 0 };
  const pendingGroupQuery = {
    ...q,
    nhom: null,
    zline: null,
    triage: null,
    type: null,
    platform: null,
    hop: 'pending',
    ops: 'pending',
    status: null,
  };
  for (const d of all) {
    if (!passesList(d, pendingGroupQuery)) continue;
    const g = groupKey(d);
    if (g === 'zalo') pendingGroupCounts.zalo += 1;
    else if (g === 'fb-sale') pendingGroupCounts.fbSale += 1;
    else if (g === 'fb-dv') pendingGroupCounts.fbDv += 1;
  }
  const folderCounts = { pending: 0, sent: 0, bought: 0, hesitant: 0, declined: 0, deleted: 0 };
  const pendingIds = [];
  for (const d of all) {
    if (q.salesChannel && (d.sales_channel || 'farm') !== q.salesChannel) continue;
    if (q.nhom && groupKey(d) !== q.nhom) continue;
    if (d.deleted_at) {
      folderCounts.deleted += 1;
      continue;
    }
    const folder = inboxStatus.inferFolder(d);
    if (folderCounts[folder] != null) folderCounts[folder] += 1;
    if (folder === 'pending') pendingIds.push(d.id);
  }
  const drafts = all
    .filter(d => passesList(d, q))
    .sort(inboxOrder.compare)
    .slice(0, 200);
  return {
    drafts,
    counts,
    triageCounts,
    platformCounts,
    groupCounts,
    pendingGroupCounts,
    folderCounts,
    pendingIds,
    storage: db.DB_ENABLED ? 'postgres' : 'memory',
  };
}

async function moveBizLine(id, line, ctx = {}) {
  await ensureReady();
  const existing = await getDraft(id);
  if (!existing) return null;
  if (line !== 'sale' && line !== 'dv') throw new DraftError(400, 'Nhóm không hợp lệ');
  if (existing.deleted_at) throw new DraftError(400, 'Tin đã xoá');
  const next = {
    ...existing,
    biz_line: line,
    biz_sticky: true,
    updated_at: new Date().toISOString(),
  };
  const saved = await saveDraft(next);
  if (!saved) return null;
  await audit.record({
    actor: ctx.actor || 'manager',
    action: 'draft.biz_line',
    entity_type: 'draft',
    entity_id: saved.id,
    before: { biz_line: existing.biz_line || null, biz_sticky: existing.biz_sticky === true },
    after: { biz_line: line, biz_sticky: true },
    meta: { ...audit.draftMeta(saved), from: existing.biz_line || null, to: line },
  });
  return decorate(saved);
}

function deletedSummary(existing, deletedAt, scope) {
  return {
    id: existing.id,
    deleted: true,
    deleted_at: deletedAt,
    channel: existing.channel || null,
    customer_user_id: existing.customer_user_id || null,
    scope: scope === 'thread' ? 'thread' : 'item',
  };
}

/**
 * Remove the draft row. The audit log stays. Nothing is sent to the customer
 * and KiotViet is not called. A tombstone stops the same source message from
 * coming back on the 20s refresh, webhook retry, or Đồng bộ tin bị sót.
 * A later message with a new source id still creates a card.
 */
async function hardDelete(id, ctx = {}) {
  await ensureReady();
  const existing = await getDraft(id);
  if (!existing) return { id, deleted: true, missing: true };
  const deletedAt = new Date().toISOString();
  const actor = ctx.actor || 'manager';
  const scope = ctx.scope === 'thread' ? 'thread' : 'item';
  if (existing.source_msg_id) {
    await tombstones.record({
      channel: existing.channel,
      sourceMsgId: existing.source_msg_id,
      deletedBy: actor,
      deletedAt,
    });
  }
  await trainingLog.deleteForDraft(existing.id);
  try { await require('./handover').forgetDraft(existing.id); } catch (_) { /* handoff table is optional */ }
  if (!db.DB_ENABLED) {
    memory.delete(existing.id);
    await persistFile();
  } else {
    await db.pool.query('DELETE FROM outbound_drafts WHERE id = $1', [existing.id]);
  }
  await audit.record({
    actor,
    action: 'draft.deleted',
    entity_type: 'draft',
    entity_id: existing.id,
    before: { approval_status: existing.approval_status, deleted_at: existing.deleted_at || null },
    after: { deleted: true },
    meta: {
      channel: existing.channel || null,
      customer_user_id: existing.customer_user_id || null,
      conversation_id: existing.customer_user_id || null,
      scope,
      deleted_at: deletedAt,
    },
  });
  return deletedSummary(existing, deletedAt, scope);
}

async function listThread(channel, customerUserId) {
  await ensureReady();
  const user = String(customerUserId || '').trim();
  const ch = channel === 'messenger' ? 'messenger' : (channel === 'zalo' ? 'zalo' : '');
  if (!user || !ch) return [];
  if (!db.DB_ENABLED) {
    return [...memory.values()].filter(d => d && d.channel === ch && d.customer_user_id === user);
  }
  const r = await db.pool.query(
    'SELECT * FROM outbound_drafts WHERE channel = $1 AND customer_user_id = $2',
    [ch, user]
  );
  return r.rows.map(fromRow);
}

async function hardDeleteThread(id, ctx = {}) {
  await ensureReady();
  const existing = await getDraft(id);
  const channel = (existing && existing.channel) || ctx.channel;
  const userId = (existing && existing.customer_user_id) || ctx.customerUserId || ctx.customer_user_id;
  const rows = userId ? await listThread(channel, userId) : [];
  const seen = new Set();
  const deleted = [];
  const targets = rows.length ? rows : (existing ? [existing] : []);
  for (const row of targets) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const out = await hardDelete(row.id, { ...ctx, scope: 'thread' });
    if (out && !out.missing) deleted.push(out);
  }
  if (!deleted.length && !existing) return null;
  return { scope: 'thread', count: deleted.length, deleted };
}

async function softDelete(id, ctx = {}) {
  await ensureReady();
  const existing = await getDraft(id);
  if (!existing) return null;
  if (existing.deleted_at) return decorate(existing);
  const next = {
    ...existing,
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const saved = await saveDraft(next);
  if (!saved) return null;
  await audit.record({
    actor: ctx.actor || 'manager',
    action: 'draft.deleted',
    entity_type: 'draft',
    entity_id: saved.id,
    before: { deleted_at: null, approval_status: existing.approval_status },
    after: { deleted_at: saved.deleted_at, approval_status: saved.approval_status },
    meta: audit.draftMeta(saved),
  });
  return decorate(saved);
}

async function restoreDraft(id, ctx = {}) {
  await ensureReady();
  const existing = await getDraft(id);
  if (!existing) return null;
  if (!existing.deleted_at) return decorate(existing);
  const next = {
    ...existing,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  };
  const saved = await saveDraft(next);
  if (!saved) return null;
  await audit.record({
    actor: ctx.actor || 'manager',
    action: 'draft.restored',
    entity_type: 'draft',
    entity_id: saved.id,
    before: { deleted_at: existing.deleted_at },
    after: { deleted_at: null, approval_status: saved.approval_status },
    meta: audit.draftMeta(saved),
  });
  return decorate(saved);
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
async function sendInvoicePicture(draft, sendFn) {
  if (!draft.qr_image_url) return null;
  let buffer = null;
  let link = draft.qr_image_url;
  try {
    const invoices = require('./invoices');
    buffer = await invoices.pngFor(draft.invoice_code);
    if (/^HD/i.test(String(draft.invoice_code || ''))) link = invoices.pageUrl(draft.invoice_code);
  } catch (err) {
    console.error('Invoice image lookup failed:', err.message);
  }
  let ok = false;
  let detail = '';
  try {
    const result = await sendFn({ buffer, url: draft.qr_image_url });
    if (result && result.ok === false) detail = result.error || '';
    else if (result) ok = true;
  } catch (err) {
    detail = err.message || '';
  }
  if (ok) return null;
  return { link, detail };
}

async function noteImageFallback(sendText, draftText, fail) {
  if (!fail) return null;
  const link = fail.link;
  if (link && !String(draftText || '').includes(link)) {
    try { await sendText(`Hoá đơn: ${link}`); } catch (_) { /* the error string still tells the manager */ }
  }
  const why = fail.detail ? `: ${String(fail.detail).slice(0, 180)}` : '';
  return `Đã gửi nội dung, chưa gửi được ảnh hoá đơn${why}.`;
}

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
      // Meta downloads payload.url itself. qr_image_url is the public
// /hd/<code>/anh?t= link on this server (token, no admin session).
const fail = await sendInvoicePicture(draft, ({ url }) => messenger.sendImage(psid, url));
      const qrError = await noteImageFallback(extra => messenger.sendText(psid, extra), text, fail);
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
      const fail = await sendInvoicePicture(draft, async ({ url }) => {
        const photo = await botService.sendPhoto(chatId, url, 'Hoá đơn');
        return photo ? { ok: true } : { ok: false, error: 'Zalo Bot không nhận ảnh' };
      });
      const qrError = await noteImageFallback(extra => botService.sendMessage(chatId, extra), text, fail);
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
    const fail = await sendInvoicePicture(draft, async ({ buffer, url }) => {
        const sent = await zaloService.sendImageMessage(uid, { buffer, url });
        if (sent) return { ok: true };
        const last = zaloService.getLastError();
        const detail = last && typeof last === 'object' ? (last.message || '') : (last || '');
        return { ok: false, error: detail || 'Zalo OA không nhận ảnh' };
      });
      const qrError = await noteImageFallback(extra => zaloService.sendTextMessage(uid, extra), text, fail);
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
  if (CONTENT_KEYS.some(key => !sameText(before[key], after[key]))) return true;
  return JSON.stringify(before.review_form || null) !== JSON.stringify(after.review_form || null);
}

async function writeDraftAudit(existing, saved, { actor, wantSend, send, learn, exampleKind }) {
  const meta = audit.draftMeta(saved);
  if (wantSend) {
    meta.learning = learn ? 'on' : 'off';
    if (exampleKind) meta.example_kind = exampleKind;
  }
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
  const learn = !(input.learn === false || input.learn === 'false' || input.learn === 0 || input.learn === '0');
  delete input.learn;
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
    let learned = false;
    let exampleKind = null;

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
      if (learn) {
        try {
          const row = await trainingLog.storeOnApprove(next, { actor, learn: true });
          learned = !!row;
          exampleKind = row && row.example_kind;
        } catch (e) {
          console.error('Training log failed:', e.message);
        }
      }
      send = await deliver(next);
      if (send) {
        send.learned = learned;
        send.learn = learn;
      }
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
        if (next.qr_image_url && next.invoice_code) {
          try {
            const invoices = require('./invoices');
            await invoices.markSent(next.invoice_code, actor);
          } catch (err) {
            console.error('Invoice sent mark failed:', err.message);
          }
        }
        if (inboxStatus.inferFolder(next) !== 'bought') {
          next.inbox_status = 'sent';
          next.inbox_status_at = next.sent_at;
          next.inbox_status_auto = true;
        }
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
    if (wantSend && send && send.sent && inboxStatus.inferFolder(existing) !== 'bought' && saved.inbox_status === 'sent') {
      await audit.record({
        actor: 'system',
        action: 'draft.inbox_status',
        entity_type: 'draft',
        entity_id: saved.id,
        before: { inbox_status: inboxStatus.inferFolder(existing) },
        after: { inbox_status: 'sent' },
        meta: { ...audit.draftMeta(saved), from: inboxStatus.inferFolder(existing), to: 'sent', auto: true },
      });
    }
    await writeDraftAudit(existing, saved, { actor, wantSend, send, learn: wantSend ? learn : undefined, exampleKind });
    await maybeClaimHandover(existing, saved, body);
    return { draft: decorate(saved), send, learned: wantSend ? learned : false, learn: wantSend ? learn : undefined };
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
  GROUPS,
  createDraft,
  listDrafts,
  getDraft,
  updateDraft,
  conversationLine,
  findBySourceMsg,
  moveBizLine,
  softDelete,
  hardDelete,
  hardDeleteThread,
  listThread,
  restoreDraft,
  setInboxStatus,
  conversationFolder,
  listChannels,
  addChannel,
  messageStats,
};
