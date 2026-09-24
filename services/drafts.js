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

const STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SENT'];
const STATUS_SET = new Set(STATUSES);

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
    reviewed_at: null,
    sent_at: null,
    send_error: null,
    send_via: null,
    send_hook: null,
  };
}

function toIso(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function fromRow(row) {
  if (!row) return null;
  return {
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
    reviewed_at: toIso(row.reviewed_at),
    sent_at: toIso(row.sent_at),
    send_error: row.send_error || null,
    send_via: row.send_via || null,
    send_hook: row.send_hook || null,
  };
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
    reviewed_at         TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    send_error          TEXT,
    send_via            TEXT,
    send_hook           TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_drafts_status_created
    ON outbound_drafts (approval_status, created_at DESC);
`;

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    if (db.DB_ENABLED) {
      // Separate statements: node-pg rejects multi-command prepared queries.
      for (const sql of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
        await db.pool.query(sql);
      }
      return;
    }
    await loadFile();
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
      if (row && row.id) memory.set(row.id, row);
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
  await fs.promises.writeFile(tmp, JSON.stringify([...memory.values()]));
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
  };
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
       qr_image_url, reviewed_at, sent_at, send_error, send_via, send_hook
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     ) RETURNING *`,
    [
      draft.id, draft.created_at, draft.updated_at, draft.channel,
      draft.customer_name, draft.customer_phone, draft.customer_user_id,
      draft.customer_intent, draft.assigned_department, draft.ticket_status,
      draft.draft_reply, draft.approval_status, draft.kiot_summary,
      draft.invoice_code, draft.customer_code, draft.qr_image_url,
      draft.reviewed_at, draft.sent_at, draft.send_error, draft.send_via,
      draft.send_hook,
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
       customer_code=$13, qr_image_url=$14, reviewed_at=$15, sent_at=$16,
       send_error=$17, send_via=$18, send_hook=$19, updated_at=$20
     WHERE id=$1
     RETURNING *`,
    [
      draft.id, draft.channel, draft.customer_name, draft.customer_phone,
      draft.customer_user_id, draft.customer_intent, draft.assigned_department,
      draft.ticket_status, draft.draft_reply, draft.approval_status,
      draft.kiot_summary, draft.invoice_code, draft.customer_code,
      draft.qr_image_url, draft.reviewed_at, draft.sent_at, draft.send_error,
      draft.send_via, draft.send_hook, draft.updated_at,
    ]
  );
  return fromRow(r.rows[0]);
}

async function createDraft(body, ctx = {}) {
  await ensureReady();
  const fields = fieldsFrom(body, { requireReply: true });
  const draft = await insertDraft(blankDraft(fields));
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
  if (!db.DB_ENABLED) return memory.get(id) || null;
  const r = await db.pool.query('SELECT * FROM outbound_drafts WHERE id=$1', [id]);
  return fromRow(r.rows[0]);
}

async function listDrafts(status) {
  await ensureReady();
  if (status && !STATUS_SET.has(status)) {
    throw new DraftError(400, 'status không hợp lệ');
  }
  if (!db.DB_ENABLED) {
    const all = [...memory.values()];
    const counts = emptyCounts();
    for (const d of all) counts[d.approval_status] = (counts[d.approval_status] || 0) + 1;
    const drafts = (status ? all.filter(d => d.approval_status === status) : all)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 200)
      .map(d => ({ ...d }));
    return { drafts, counts, storage: 'memory' };
  }
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = 'WHERE approval_status = $1';
  }
  const [rows, countRows] = await Promise.all([
    db.pool.query(
      `SELECT * FROM outbound_drafts ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    ),
    db.pool.query('SELECT approval_status, COUNT(*)::int AS n FROM outbound_drafts GROUP BY 1'),
  ]);
  const counts = emptyCounts();
  for (const row of countRows.rows) counts[row.approval_status] = row.n;
  return { drafts: rows.rows.map(fromRow), counts, storage: 'postgres' };
}

function emptyCounts() {
  return { PENDING_REVIEW: 0, APPROVED: 0, REJECTED: 0, SENT: 0 };
}

function isUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
}

/**
 * SEND HOOK — the only place an approved HITL draft is delivered.
 * Webhook handlers do not call this, and a failure here must not affect them.
 *
 *   zalo + customer_user_id "bot_<chatId>" → zaloBotService.sendMessage
 *   zalo + any other user id                → zaloService.sendTextMessage (OA)
 *   messenger                               → not implemented
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

  if (draft.channel === 'messenger') {
    return {
      ok: false,
      sent: false,
      via: null,
      hook: 'services/drafts.js deliver() messenger',
      error: 'Repo chưa có hàm gửi Messenger. Bản nháp giữ ở APPROVED. Gắn gửi trong services/drafts.js → deliver().',
    };
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
      send = await deliver(next);
      if (send.sent) {
        next.approval_status = 'SENT';
        next.sent_at = new Date().toISOString();
        next.send_via = send.via;
      } else {
        next.approval_status = 'APPROVED';
        next.send_via = null;
        next.sent_at = null;
      }
      next.send_hook = send.hook || null;
      next.send_error = send.error || null;
    } else if (Object.prototype.hasOwnProperty.call(input, 'approval_status')) {
      next.approval_status = input.approval_status;
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
    return { draft: saved, send };
  });
}

module.exports = {
  STATUSES,
  DraftError,
  storageMode,
  createDraft,
  listDrafts,
  getDraft,
  updateDraft,
};
