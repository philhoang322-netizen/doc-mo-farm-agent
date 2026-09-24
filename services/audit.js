/**
 * Append-only audit trail for the HITL and order path.
 *
 * DATABASE_URL set → Postgres table audit_logs (migration 014).
 * Otherwise an in-memory list. That list is wiped on restart; it exists
 * so local runs and tests can still inspect the chain. Production should
 * set DATABASE_URL.
 *
 * Rows are never updated or deleted. Snapshots are redacted before write:
 * token, password, secret, and authorization fields become "[redacted]".
 */
const crypto = require('crypto');
const db = require('./database');

const MEMORY_CAP = 5000;

const SECRET_KEY = /password|passwd|secret|token|authorization|api[_-]?key|cookie|credential|client_secret|access_key|refresh/i;
const BEARER = /bearer\s+[a-z0-9\-._~+/]+=*/gi;
const SECRET_ASSIGN = /(access_token|refresh_token|client_secret|password|api_key|authorization)(["']?\s*[:=]\s*["']?)[^"',\s&]+/gi;

const ACTION_RE = /^[a-z][a-z0-9_.]{0,79}$/;
const ENTITY_RE = /^[a-z][a-z0-9_]{0,39}$/;

class AuditError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const memory = [];
let memorySeq = 0;
let ready = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq          BIGSERIAL NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor        TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 120),
    action       TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
    entity_type  TEXT NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 40),
    entity_id    TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 200),
    before       JSONB,
    after        JSONB,
    meta         JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_at ON audit_logs (at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_conversation ON audit_logs ((meta->>'conversation_id'), at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_order ON audit_logs ((meta->>'order_number'), at DESC)`,
  `CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'audit_logs is append-only';
   END;
   $$`,
  `DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs`,
  `CREATE TRIGGER audit_logs_no_update
     BEFORE UPDATE ON audit_logs
     FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation()`,
  `DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs`,
  `CREATE TRIGGER audit_logs_no_delete
     BEFORE DELETE ON audit_logs
     FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation()`,
];

function storageMode() {
  return db.DB_ENABLED ? 'postgres' : 'memory';
}

function cleanName(name) {
  if (name == null) return '';
  return String(name).replace(/[\u0000-\u001f:]/g, '').trim().slice(0, 80);
}

function managerActor(name) {
  const n = cleanName(name);
  return n ? `manager:${n}` : 'manager';
}

function staffActor(name) {
  const n = cleanName(name);
  return n ? `staff:${n}` : 'staff';
}

function orderStatusAction(status) {
  return status === 'confirmed' ? 'order.confirmed' : 'order.status_changed';
}

function summarize(text, max = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').replace(/\0/g, '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function redactString(value) {
  const s = String(value).replace(/\0/g, '');
  const clipped = s.length > 4000 ? `${s.slice(0, 3999)}…` : s;
  return clipped
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_ASSIGN, '$1$2[redacted]');
}

function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 40).map(v => redact(v, depth + 1));
  if (typeof value !== 'object') return null;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) out[key] = '[redacted]';
    else out[key] = redact(inner, depth + 1);
  }
  return out;
}

function clipId(value, label) {
  const s = String(value ?? '').replace(/\0/g, '').trim();
  if (!s) throw new AuditError(400, `Thiếu ${label}`);
  if (s.length > 200) return s.slice(0, 200);
  return s;
}

function buildRow(entry) {
  if (!entry || typeof entry !== 'object') throw new AuditError(400, 'Thiếu dòng nhật ký');
  const action = String(entry.action || '').trim();
  const entityType = String(entry.entity_type || '').trim();
  if (!ACTION_RE.test(action)) throw new AuditError(400, 'action không hợp lệ');
  if (!ENTITY_RE.test(entityType)) throw new AuditError(400, 'entity_type không hợp lệ');
  const actor = String(entry.actor || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
  if (!actor) throw new AuditError(400, 'Thiếu actor');
  const now = new Date().toISOString();
  memorySeq += 1;
  return {
    id: crypto.randomUUID(),
    seq: memorySeq,
    at: now,
    actor,
    action,
    entity_type: entityType,
    entity_id: clipId(entry.entity_id, 'entity_id'),
    before: entry.before == null ? null : redact(entry.before),
    after: entry.after == null ? null : redact(entry.after),
    meta: redact(entry.meta && typeof entry.meta === 'object' ? entry.meta : {}),
  };
}

function toIso(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function asObject(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (typeof value === 'object') return value;
  return null;
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: Number(row.seq) || 0,
    at: toIso(row.at),
    actor: row.actor,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    before: asObject(row.before),
    after: asObject(row.after),
    meta: asObject(row.meta) || {},
  };
}

async function ensureReady() {
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

/**
 * Write one row. Failures are swallowed so a logging outage cannot block
 * a customer reply or an approval. Returns the stored row, or null.
 */
async function record(entry) {
  try {
    const row = buildRow(entry);
    await ensureReady();
    if (!db.DB_ENABLED) {
      const stored = JSON.parse(JSON.stringify(row));
      memory.push(stored);
      if (memory.length > MEMORY_CAP) memory.splice(0, memory.length - MEMORY_CAP);
      return stored;
    }
    const r = await db.pool.query(
      `INSERT INTO audit_logs (id, at, actor, action, entity_type, entity_id, before, after, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
       RETURNING *`,
      [
        row.id,
        row.at,
        row.actor,
        row.action,
        row.entity_type,
        row.entity_id,
        row.before == null ? null : JSON.stringify(row.before),
        row.after == null ? null : JSON.stringify(row.after),
        JSON.stringify(row.meta || {}),
      ]
    );
    return fromRow(r.rows[0]);
  } catch (e) {
    console.warn('audit log write failed:', e.message);
    return null;
  }
}

function parseTime(value, endOfDay) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(s) && Number.isNaN(new Date(s).getTime())) {
    throw new AuditError(400, 'Ngày không hợp lệ');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const iso = endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
    return new Date(iso);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new AuditError(400, 'Ngày không hợp lệ');
  return d;
}

function parseLimit(value) {
  if (value == null || value === '') return 100;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new AuditError(400, 'limit từ 1 đến 200');
  }
  return n;
}

function queryFrom(input = {}) {
  const conversation = input.conversation ? String(input.conversation).trim().slice(0, 200) : '';
  const order = input.order ? String(input.order).trim().slice(0, 200) : '';
  const entityId = input.entityId || input.entity_id
    ? String(input.entityId || input.entity_id).trim().slice(0, 200)
    : '';
  const entityType = input.entityType || input.entity_type
    ? String(input.entityType || input.entity_type).trim()
    : '';
  const action = input.action ? String(input.action).trim() : '';
  if (entityType && !ENTITY_RE.test(entityType)) throw new AuditError(400, 'entity_type không hợp lệ');
  if (action && !ACTION_RE.test(action)) throw new AuditError(400, 'action không hợp lệ');
  const from = parseTime(input.from, false);
  const to = parseTime(input.to, true);
  if (from && to && from.getTime() > to.getTime()) {
    throw new AuditError(400, 'Khoảng ngày không hợp lệ');
  }
  const limit = parseLimit(input.limit);
  const chronological = !!(conversation || order || entityId);
  return { conversation, order, entityId, entityType, action, from, to, limit, chronological };
}

function matches(row, q) {
  if (q.conversation) {
    const meta = row.meta || {};
    const after = row.after || {};
    const hit = row.entity_id === q.conversation
      || meta.conversation_id === q.conversation
      || meta.customer_user_id === q.conversation
      || after.customer_user_id === q.conversation;
    if (!hit) return false;
  }
  if (q.order) {
    const meta = row.meta || {};
    const hit = meta.order_number === q.order || (row.entity_type === 'order' && row.entity_id === q.order);
    if (!hit) return false;
  }
  if (q.entityId && row.entity_id !== q.entityId) return false;
  if (q.entityType && row.entity_type !== q.entityType) return false;
  if (q.action && row.action !== q.action) return false;
  const at = new Date(row.at).getTime();
  if (q.from && at < q.from.getTime()) return false;
  if (q.to && at > q.to.getTime()) return false;
  return true;
}

function buildListQuery(q) {
  const where = [];
  const params = [];
  const bind = (sql, values) => {
    let i = 0;
    where.push(sql.replace(/\$\?/g, () => {
      params.push(values[i]);
      i += 1;
      return `$${params.length}`;
    }));
  };
  if (q.conversation) {
    bind(
      `(entity_id = $? OR meta->>'conversation_id' = $? OR meta->>'customer_user_id' = $? OR COALESCE(after->>'customer_user_id','') = $?)`,
      [q.conversation, q.conversation, q.conversation, q.conversation]
    );
  }
  if (q.order) {
    bind(
      `((entity_type = 'order' AND entity_id = $?) OR meta->>'order_number' = $?)`,
      [q.order, q.order]
    );
  }
  if (q.entityId) bind('entity_id = $?', [q.entityId]);
  if (q.entityType) bind('entity_type = $?', [q.entityType]);
  if (q.action) bind('action = $?', [q.action]);
  if (q.from) bind('at >= $?', [q.from.toISOString()]);
  if (q.to) bind('at <= $?', [q.to.toISOString()]);
  params.push(q.limit);
  const sql = `
    SELECT * FROM audit_logs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY at ${q.chronological ? 'ASC' : 'DESC'}, seq ${q.chronological ? 'ASC' : 'DESC'}
    LIMIT $${params.length}`;
  return { sql, params };
}

async function list(input = {}) {
  const q = queryFrom(input);
  await ensureReady();
  if (!db.DB_ENABLED) {
    const rows = memory.filter(row => matches(row, q));
    rows.sort((a, b) => {
      if (a.at !== b.at) {
        const olderFirst = a.at < b.at ? -1 : 1;
        return q.chronological ? olderFirst : -olderFirst;
      }
      const olderSeq = (a.seq || 0) - (b.seq || 0);
      return q.chronological ? olderSeq : -olderSeq;
    });
    return {
      logs: rows.slice(0, q.limit).map(row => ({
        ...row,
        before: row.before,
        after: row.after,
        meta: { ...(row.meta || {}) },
      })),
      storage: 'memory',
    };
  }

  const { sql, params } = buildListQuery(q);
  const r = await db.pool.query(sql, params);
  return { logs: r.rows.map(fromRow), storage: 'postgres' };
}

function draftMeta(draft, extra = {}) {
  const conversation = draft && draft.customer_user_id ? draft.customer_user_id : null;
  const orderNumber = orderNumberFromDraft(draft);
  return {
    conversation_id: conversation,
    customer_user_id: conversation,
    channel: draft ? draft.channel : null,
    approval_status: draft ? draft.approval_status : null,
    order_number: orderNumber,
    ...extra,
  };
}

function orderNumberFromDraft(draft) {
  if (!draft) return null;
  if (draft.invoice_code) return String(draft.invoice_code).slice(0, 80);
  const m = String(draft.kiot_summary || '').match(/Đơn\s+([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function draftSnapshot(draft) {
  if (!draft) return null;
  return {
    channel: draft.channel,
    customer_name: draft.customer_name,
    customer_phone: draft.customer_phone,
    customer_user_id: draft.customer_user_id,
    customer_intent: draft.customer_intent,
    assigned_department: draft.assigned_department,
    ticket_status: draft.ticket_status,
    draft_reply: draft.draft_reply,
    approval_status: draft.approval_status,
    kiot_summary: draft.kiot_summary,
    invoice_code: draft.invoice_code,
    customer_code: draft.customer_code,
    qr_image_url: draft.qr_image_url,
    triage_level: draft.triage_level || null,
    triage_label: draft.triage_label || null,
  };
}

function orderSnapshot(order, kiot) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  const snap = {
    order_number: order && order.order_number ? String(order.order_number) : null,
    total: order ? order.total ?? order.total_amount ?? null : null,
    payment: order ? order.payment || order.payment_method || null : null,
    customer_name: order ? order.customerName || order.customer_name || null : null,
    phone: order ? order.phone || null : null,
    address: order ? order.address || order.delivery_address || null : null,
    items: items.slice(0, 40).map(item => ({
      sku: item.sku || null,
      product_name: item.product_name || item.name || null,
      quantity: item.quantity,
      unit_price: item.unit_price ?? item.price ?? null,
    })),
  };
  if (kiot) {
    snap.kiot_ok = !!kiot.ok;
    snap.kiot_order_code = kiot.kiotOrderCode || null;
    snap.blocked = !!kiot.blocked;
    snap.error = kiot.error ? summarize(kiot.error, 500) : null;
  }
  return snap;
}

module.exports = {
  AuditError,
  storageMode,
  cleanName,
  managerActor,
  staffActor,
  orderStatusAction,
  summarize,
  redact,
  record,
  list,
  draftMeta,
  draftSnapshot,
  orderSnapshot,
  orderNumberFromDraft,
  buildListQuery,
  queryFrom,
};
