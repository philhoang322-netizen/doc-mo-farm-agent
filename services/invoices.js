/**
 * Invoices and orders created from the review inbox.
 * DATABASE_URL set → kiot_invoices (migration 030). Otherwise memory,
 * so tests and a laptop without Postgres still record the sale.
 * The public /hd/<code>?t= link is an HMAC of the code. The key is
 * INVOICE_LINK_SECRET when set, otherwise ADMIN_PASSWORD. Set the dedicated
 * secret before customers receive links: rotating ADMIN_PASSWORD must not
 * invalidate invoices already sent.
 * The link host is PUBLIC_URL, else https://${RAILWAY_PUBLIC_DOMAIN}, else
 * the Railway app. docmofarm.com is the storefront and does not serve /hd.
 */
const crypto = require('crypto');
const db = require('./database');
const audit = require('./audit');
const invoiceImage = require('./invoiceImage');
const kiotviet = require('./kiotviet');

const memory = new Map();
const images = new Map();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kiot_invoices (
    id              TEXT PRIMARY KEY,
    kiot_id         TEXT,
    code            TEXT NOT NULL,
    order_code      TEXT,
    order_kiot_id   TEXT,
    draft_id        TEXT,
    document_type   TEXT NOT NULL DEFAULT 'invoice',
    customer_code   TEXT,
    customer_name   TEXT,
    customer_phone  TEXT,
    channel         TEXT,
    items           JSONB NOT NULL DEFAULT '[]'::jsonb,
    total           INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMPTZ,
    payment_status  TEXT NOT NULL DEFAULT 'chua_tt',
    paid_at         TIMESTAMPTZ,
    amount_paid     INTEGER NOT NULL DEFAULT 0
  )`,
  `ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS delivery_address TEXT`,
  `ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS paid_by TEXT`,
  `ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS payment_method TEXT`,
  `ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS kiot_payment_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kiot_invoices_code_uidx ON kiot_invoices (code)`,
  `CREATE INDEX IF NOT EXISTS kiot_invoices_order_code_idx ON kiot_invoices (order_code)`,
  `CREATE INDEX IF NOT EXISTS kiot_invoices_phone_idx ON kiot_invoices (customer_phone)`,
  `CREATE INDEX IF NOT EXISTS kiot_invoices_created_idx ON kiot_invoices (created_at DESC)`,
];

let ready = null;

function ensure() {
  if (!db.DB_ENABLED) return Promise.resolve();
  if (!ready) {
    ready = (async () => {
      for (const sql of SCHEMA) await db.pool.query(sql);
    })().catch(err => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

function channelOf(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'messenger' || c === 'fb' || c === 'facebook') return 'fb';
  if (c === 'zalo') return 'zalo';
  return null;
}

function statusOf(amountPaid, total) {
  const paid = Math.round(Number(amountPaid) || 0);
  const sum = Math.round(Number(total) || 0);
  if (paid <= 0) return 'chua_tt';
  if (sum > 0 && paid < sum) return 'mot_phan';
  return 'da_tt';
}

function cleanCode(code) {
  const s = String(code || '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(s)) return '';
  return s;
}

function itemsOf(items) {
  return (Array.isArray(items) ? items : []).map(item => ({
    name: String(item.name || item.product_name || '').slice(0, 200),
    sku: item.sku ? String(item.sku).slice(0, 40) : null,
    quantity: Number(item.quantity) || 0,
    price: Math.round(Number(item.price) || 0),
    amount: Math.round(Number(item.amount != null ? item.amount : (Number(item.price) || 0) * (Number(item.quantity) || 0)) || 0),
  }));
}

function fromRow(row) {
  if (!row) return null;
  const items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []);
  return {
    id: row.id,
    kiot_id: row.kiot_id || null,
    code: row.code,
    order_code: row.order_code || null,
    order_kiot_id: row.order_kiot_id || null,
    draft_id: row.draft_id || null,
    document_type: row.document_type === 'order' ? 'order' : 'invoice',
    customer_code: row.customer_code || null,
    customer_name: row.customer_name || null,
    customer_phone: row.customer_phone || null,
    channel: row.channel || null,
    items,
    total: Math.round(Number(row.total) || 0),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    payment_status: row.payment_status || 'chua_tt',
    paid_at: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    amount_paid: Math.round(Number(row.amount_paid) || 0),
    delivery_address: row.delivery_address ? String(row.delivery_address).slice(0, 300) : null,
    paid_by: row.paid_by ? String(row.paid_by).slice(0, 80) : null,
    payment_method: cleanMethod(row.payment_method),
    kiot_payment_id: row.kiot_payment_id ? String(row.kiot_payment_id).slice(0, 40) : null,
  };
}

function cleanMethod(method) {
  const raw = String(method || '').toLowerCase();
  if (raw === 'cash' || raw === 'tien mat' || raw === 'tiền mặt') return 'cash';
  if (raw === 'transfer' || raw === 'chuyen khoan' || raw === 'chuyển khoản' || raw === 'ck') return 'transfer';
  if (raw === 'card' || raw === 'the' || raw === 'thẻ') return 'card';
  if (raw === 'mixed') return 'mixed';
  return null;
}

const RAILWAY_APP = 'https://doc-mo-farm-agent-production.up.railway.app';

function origin() {
  const explicit = String(process.env.PUBLIC_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const railway = String(process.env.RAILWAY_PUBLIC_DOMAIN || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (railway) return `https://${railway}`;
  return RAILWAY_APP;
}

function linkSecret() {
  const dedicated = String(process.env.INVOICE_LINK_SECRET || '').trim();
  if (dedicated) return dedicated;
  return String(process.env.ADMIN_PASSWORD || '');
}

function sign(code) {
  return crypto.createHmac('sha256', linkSecret()).update(`hd:${code}`).digest('base64url');
}

function verify(code, token) {
  const clean = cleanCode(code);
  if (!clean || !token || !linkSecret()) return false;
  const expected = sign(clean);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function pageUrl(code) {
  const clean = cleanCode(code);
  if (!clean) return '';
  return `${origin()}/hd/${encodeURIComponent(clean)}?t=${sign(clean)}`;
}

function imageUrl(code) {
  const clean = cleanCode(code);
  if (!clean) return '';
  return `${origin()}/hd/${encodeURIComponent(clean)}/anh?t=${sign(clean)}`;
}

async function getByCode(code) {
  const clean = cleanCode(code);
  if (!clean) return null;
  await ensure();
  if (!db.DB_ENABLED) {
    for (const row of memory.values()) {
      if (row.code === clean || row.order_code === clean) return { ...row, items: itemsOf(row.items) };
    }
    return null;
  }
  const r = await db.pool.query(
    `SELECT * FROM kiot_invoices WHERE code = $1 OR order_code = $1 ORDER BY created_at DESC LIMIT 1`,
    [clean]
  );
  return fromRow(r.rows[0]);
}

async function save(row) {
  await ensure();
  const next = {
    ...row,
    items: itemsOf(row.items),
    total: Math.round(Number(row.total) || 0),
    amount_paid: Math.round(Number(row.amount_paid) || 0),
  };
  next.payment_status = statusOf(next.amount_paid, next.total);
  next.payment_method = cleanMethod(next.payment_method);
  next.paid_by = next.paid_by ? String(next.paid_by).slice(0, 80) : null;
  next.kiot_payment_id = next.kiot_payment_id ? String(next.kiot_payment_id).slice(0, 40) : null;
  if (next.payment_status === 'chua_tt') {
    next.paid_at = null;
    next.paid_by = null;
    next.payment_method = null;
  } else if (!next.paid_at) next.paid_at = new Date().toISOString();
  if (!db.DB_ENABLED) {
    memory.set(next.id, next);
    images.delete(next.code);
    if (next.order_code) images.delete(next.order_code);
    return { ...next, items: itemsOf(next.items) };
  }
  await db.pool.query(
    `INSERT INTO kiot_invoices (
       id, kiot_id, code, order_code, order_kiot_id, draft_id, document_type,
       customer_code, customer_name, customer_phone, channel, items, total,
       created_at, sent_at, payment_status, paid_at, amount_paid, delivery_address,
       paid_by, payment_method, kiot_payment_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
     )
     ON CONFLICT (id) DO UPDATE SET
       kiot_id = EXCLUDED.kiot_id,
       code = EXCLUDED.code,
       order_code = EXCLUDED.order_code,
       order_kiot_id = EXCLUDED.order_kiot_id,
       draft_id = EXCLUDED.draft_id,
       document_type = EXCLUDED.document_type,
       customer_code = EXCLUDED.customer_code,
       customer_name = EXCLUDED.customer_name,
       customer_phone = EXCLUDED.customer_phone,
       channel = EXCLUDED.channel,
       items = EXCLUDED.items,
       total = EXCLUDED.total,
       sent_at = EXCLUDED.sent_at,
       payment_status = EXCLUDED.payment_status,
       paid_at = EXCLUDED.paid_at,
       amount_paid = EXCLUDED.amount_paid,
       delivery_address = EXCLUDED.delivery_address,
       paid_by = EXCLUDED.paid_by,
       payment_method = EXCLUDED.payment_method,
       kiot_payment_id = EXCLUDED.kiot_payment_id`,
    [
      next.id, next.kiot_id, next.code, next.order_code, next.order_kiot_id, next.draft_id,
      next.document_type, next.customer_code, next.customer_name, next.customer_phone,
      next.channel, JSON.stringify(next.items), next.total, next.created_at, next.sent_at,
      next.payment_status, next.paid_at, next.amount_paid, next.delivery_address,
      next.paid_by, next.payment_method, next.kiot_payment_id,
    ]
  );
  images.delete(next.code);
  return getByCode(next.code);
}

function blankSale(input) {
  const now = new Date().toISOString();
  const kind = input.documentType === 'order' ? 'order' : 'invoice';
  const row = {
    id: crypto.randomUUID(),
    kiot_id: input.kiotId ? String(input.kiotId).slice(0, 40) : null,
    code: cleanCode(input.code),
    order_code: kind === 'order' ? cleanCode(input.code) : (cleanCode(input.orderCode) || null),
    order_kiot_id: input.orderKiotId
      ? String(input.orderKiotId).slice(0, 40)
      : (kind === 'order' && input.kiotId ? String(input.kiotId).slice(0, 40) : null),
    draft_id: input.draftId ? String(input.draftId).slice(0, 80) : null,
    document_type: kind,
    customer_code: input.customerCode ? String(input.customerCode).slice(0, 40) : null,
    customer_name: input.customerName ? String(input.customerName).slice(0, 200) : null,
    customer_phone: input.customerPhone ? String(input.customerPhone).slice(0, 40) : null,
    channel: channelOf(input.channel),
    items: itemsOf(input.items),
    total: Math.round(Number(input.total) || 0),
    created_at: now,
    sent_at: null,
    payment_status: 'chua_tt',
    paid_at: null,
    amount_paid: 0,
    delivery_address: input.deliveryAddress ? String(input.deliveryAddress).slice(0, 300) : null,
    paid_by: null,
    payment_method: null,
    kiot_payment_id: null,
  };
  if (kind === 'invoice' && input.paymentStatus === 'da_tt') {
    row.amount_paid = row.total;
    row.paid_at = input.paidAt || now;
    row.paid_by = input.paidBy ? String(input.paidBy).slice(0, 80) : null;
    row.payment_method = cleanMethod(input.paymentMethod) || 'transfer';
    if (input.kiotPaymentIncluded) row.kiot_payment_id = 'included';
  }
  return row;
}

async function recordSale(input, actor) {
  const row = blankSale(input);
  if (!row.code) throw new Error('Thiếu mã chứng từ');
  const saved = await save(row);
  try {
    await audit.record({
      actor: actor || 'manager',
      action: 'invoice.created',
      entity_type: 'invoice',
      entity_id: saved.code,
      after: {
        code: saved.code,
        document_type: saved.document_type,
        total: saved.total,
        draft_id: saved.draft_id,
        payment_status: saved.payment_status,
      },
      meta: { code: saved.code, draft_id: saved.draft_id, document: saved.document_type },
    });
  } catch (err) {
    console.error('Invoice create audit failed:', err.message);
  }
  return saved;
}

async function markIssued(orderCode, issued, actor) {
  const existing = await getByCode(orderCode);
  const previous = existing ? existing.code : null;
  const row = existing || blankSale({
    code: issued.code,
    documentType: 'invoice',
    draftId: issued.draftId,
    customerName: issued.customerName,
    customerPhone: issued.customerPhone,
    customerCode: issued.customerCode,
    channel: issued.channel,
    items: issued.items,
    total: issued.total,
  });
  row.order_code = row.order_code || cleanCode(orderCode);
  row.order_kiot_id = row.order_kiot_id || row.kiot_id;
  row.code = cleanCode(issued.code);
  row.kiot_id = issued.id ? String(issued.id).slice(0, 40) : row.kiot_id;
  row.document_type = 'invoice';
  if (issued.total != null) row.total = Math.round(Number(issued.total) || 0);
  if (issued.items) row.items = itemsOf(issued.items);
  if (issued.customerCode) row.customer_code = String(issued.customerCode).slice(0, 40);
  if (issued.paid) {
    row.amount_paid = Math.round(Number(issued.total != null ? issued.total : row.total) || 0);
    row.payment_method = cleanMethod(issued.paymentMethod) || row.payment_method || 'transfer';
    if (!row.paid_by && issued.paidBy) row.paid_by = String(issued.paidBy).slice(0, 80);
    if (!row.kiot_payment_id) row.kiot_payment_id = 'included';
  }
  const saved = await save(row);
  try {
    await audit.record({
      actor: actor || 'manager',
      action: 'invoice.issued',
      entity_type: 'invoice',
      entity_id: saved.code,
      before: { code: previous, document_type: 'order' },
      after: { code: saved.code, document_type: 'invoice', total: saved.total, kiot_id: saved.kiot_id },
      meta: { code: saved.code, order_code: saved.order_code, draft_id: saved.draft_id },
    });
  } catch (err) {
    console.error('Invoice issue audit failed:', err.message);
  }
  return saved;
}

async function markSent(code, actor) {
  const row = await getByCode(code);
  if (!row || row.sent_at || row.document_type !== 'invoice') return row;
  row.sent_at = new Date().toISOString();
  const saved = await save(row);
  try {
    await audit.record({
      actor: actor || 'manager',
      action: 'invoice.sent',
      entity_type: 'invoice',
      entity_id: saved.code,
      before: { sent_at: null },
      after: { sent_at: saved.sent_at },
      meta: { code: saved.code, draft_id: saved.draft_id },
    });
  } catch (err) {
    console.error('Invoice sent audit failed:', err.message);
  }
  return saved;
}

async function setPayment(code, amountPaid, actor, source) {
  const row = await getByCode(code);
  if (!row) return null;
  const paid = Math.max(0, Math.round(Number(amountPaid) || 0));
  const before = { payment_status: row.payment_status, amount_paid: row.amount_paid, paid_at: row.paid_at };
  row.amount_paid = paid;
  row.payment_status = statusOf(paid, row.total);
  row.paid_at = row.payment_status === 'chua_tt' ? null : (row.paid_at || new Date().toISOString());
  const saved = await save(row);
  if (before.payment_status !== saved.payment_status || before.amount_paid !== saved.amount_paid) {
    try {
      await audit.record({
        actor: actor || 'manager',
        action: 'invoice.payment',
        entity_type: 'invoice',
        entity_id: saved.code,
        before,
        after: { payment_status: saved.payment_status, amount_paid: saved.amount_paid, paid_at: saved.paid_at },
        meta: { code: saved.code, source: source || 'manual', draft_id: saved.draft_id },
      });
    } catch (err) {
      console.error('Invoice payment audit failed:', err.message);
    }
  }
  return saved;
}

/**
 * Mirror a KiotViet read onto the local cache. The read wins.
 * Audit only when meta.audit is set (a write, not a list refresh).
 */
async function applyRemote(code, remote, actor, meta) {
  const row = await getByCode(code);
  if (!row || !remote) return row;
  const before = {
    payment_status: row.payment_status,
    amount_paid: row.amount_paid,
    paid_at: row.paid_at,
    paid_by: row.paid_by || null,
    payment_method: row.payment_method || null,
  };
  row.amount_paid = Math.max(0, Math.round(Number(remote.amount_paid) || 0));
  row.payment_method = row.amount_paid > 0 ? (cleanMethod(remote.payment_method) || row.payment_method) : null;
  if (row.amount_paid <= 0) {
    row.paid_at = null;
    row.paid_by = null;
  } else {
    row.paid_at = row.paid_at || new Date().toISOString();
    if (actor) row.paid_by = actor;
  }
  if (remote.id && row.document_type === 'invoice') row.kiot_id = String(remote.id).slice(0, 40);
  const saved = await save(row);
  if (meta && meta.audit && (before.payment_status !== saved.payment_status || before.amount_paid !== saved.amount_paid || before.payment_method !== saved.payment_method)) {
    try {
      await audit.record({
        actor: actor || 'manager',
        action: 'invoice.payment',
        entity_type: 'invoice',
        entity_id: saved.code,
        before,
        after: {
          payment_status: saved.payment_status,
          amount_paid: saved.amount_paid,
          paid_at: saved.paid_at,
          paid_by: saved.paid_by,
          payment_method: saved.payment_method,
        },
        meta: {
          code: saved.code,
          source: meta.source || 'kiotviet',
          draft_id: saved.draft_id,
          kiot: meta.kiot || null,
        },
      });
    } catch (err) {
      console.error('Invoice payment audit failed:', err.message);
    }
  }
  return saved;
}

/**
 * Pay the remaining balance on an invoice that already exists in KiotViet.
 * POST /payments, then GET the invoice and store that read.
 * There is no public call to void one payment or to change its method.
 */
async function setPaymentStatus(code, { status, method, actor } = {}) {
  const row = await getByCode(code);
  if (!row) return null;
  if (status !== 'da_tt') {
    return { invoice: row, kiot: null, error: 'KiotViet không có API xoá một phiếu thu' };
  }
  if (row.document_type !== 'invoice' || !row.kiot_id) {
    return { invoice: row, kiot: null, error: 'Chưa có hoá đơn KiotViet' };
  }
  if (row.payment_status === 'da_tt') return { invoice: row, kiot: null };
  const methodName = cleanMethod(method);
  if (methodName !== 'cash' && methodName !== 'transfer') {
    return { invoice: row, kiot: null, error: 'Chọn Tiền mặt hoặc CK' };
  }
  const due = Math.max(0, row.total - row.amount_paid);
  const kiot = await kiotviet.addInvoicePayment({
    invoiceId: row.kiot_id,
    amount: due,
    method: methodName,
  });
  if (!kiot || !kiot.ok) {
    return { invoice: row, kiot: kiot || null, error: (kiot && kiot.error) || 'Không thu được trên KiotViet' };
  }
  if (!row.kiot_payment_id) row.kiot_payment_id = kiot.paymentId || kiot.paymentCode || 'posted';
  await save(row);
  const remote = await kiotviet.readInvoicePayment({ id: row.kiot_id, code: row.code });
  const read = remote && remote.ok ? remote : {
    amount_paid: Math.min(row.total, row.amount_paid + due),
    payment_method: methodName,
  };
  if (!read.payment_method) read.payment_method = methodName;
  const saved = await applyRemote(code, read, actor, {
    audit: true,
    source: 'toggle',
    kiot: { paymentId: kiot.paymentId || null, paymentCode: kiot.paymentCode || null, method: kiot.method || null, amount: kiot.amount },
  });
  return { invoice: saved, kiot };
}

async function refreshFromKiot(rows) {
  if (!kiotviet.enabled()) return rows;
  const out = [];
  for (const row of rows || []) {
    if (!row || row.document_type !== 'invoice' || !(row.kiot_id || row.code)) {
      out.push(row);
      continue;
    }
    try {
      const remote = await kiotviet.readInvoicePayment({ id: row.kiot_id, code: row.code });
      if (remote && remote.ok) {
        out.push(await applyRemote(row.code, remote, null, null) || row);
        continue;
      }
    } catch (err) {
      console.warn('Invoice payment refresh skipped:', err.message);
    }
    out.push(row);
  }
  return out;
}

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
}

async function search({ q, from, to, payment } = {}) {
  await ensure();
  const query = String(q || '').trim().toLowerCase().slice(0, 80);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : '';
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : '';
  const want = payment === 'da_tt' || payment === 'chua_tt' || payment === 'cash' || payment === 'transfer'
    ? payment
    : '';
  let rows;
  if (!db.DB_ENABLED) {
    rows = [...memory.values()].map(row => ({ ...row, items: itemsOf(row.items) }));
  } else {
    const r = await db.pool.query('SELECT * FROM kiot_invoices ORDER BY created_at DESC LIMIT 500');
    rows = r.rows.map(fromRow);
  }
  return rows
    .filter(row => {
      if (query) {
        const hay = [row.code, row.order_code, row.customer_name, row.customer_phone, row.customer_code]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(query)) return false;
      }
      const day = dayKey(row.created_at);
      if (start && day < start) return false;
      if (end && day > end) return false;
      if (want === 'da_tt' && row.payment_status !== 'da_tt') return false;
      if (want === 'chua_tt' && row.payment_status === 'da_tt') return false;
      if (want === 'cash' && !(row.payment_status === 'da_tt' && row.payment_method === 'cash')) return false;
      if (want === 'transfer' && !(row.payment_status === 'da_tt' && row.payment_method === 'transfer')) return false;
      return true;
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function toCsv(rows) {
  const header = ['code', 'loai', 'ma_kh', 'khach', 'sdt', 'kenh', 'tong', 'da_thu', 'trang_thai', 'paid_at', 'paid_by', 'method', 'tao_luc', 'gui_luc'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.code,
      row.document_type,
      row.customer_code,
      row.customer_name,
      row.customer_phone,
      row.channel,
      row.total,
      row.amount_paid,
      row.payment_status,
      row.paid_at,
      row.paid_by,
      row.payment_method === 'cash' ? 'Tiền mặt' : (row.payment_method === 'transfer' ? 'Chuyển khoản' : (row.payment_method === 'card' ? 'Thẻ' : (row.payment_method === 'mixed' ? 'Nhiều cách' : ''))),
      row.created_at,
      row.sent_at,
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

/** Older rows stored before Mã KH was required. Read the Kiot customer by phone and keep the code. */
async function backfillCustomerCode(row) {
  if (!row || row.customer_code) return row;
  const phone = String(row.customer_phone || '').trim();
  if (!phone) return row;
  let customer = null;
  try {
    customer = await kiotviet.findCustomerByPhone(phone);
  } catch (err) {
    console.warn('Invoice Mã KH backfill skipped:', err.message);
    return row;
  }
  const code = customer && customer.code ? String(customer.code).trim().slice(0, 40) : '';
  if (!code) return row;
  return save({ ...row, customer_code: code, items: itemsOf(row.items) });
}

async function hydrateCustomerCodes(rows) {
  const out = [];
  for (const row of rows || []) out.push(await backfillCustomerCode(row));
  return out;
}

async function pngFor(code) {
  let row = await getByCode(code);
  if (!row || row.document_type !== 'invoice') return null;
  row = await backfillCustomerCode(row);
  const cached = images.get(row.code);
  const stamp = `${row.payment_status}|${row.payment_method || ''}|${row.amount_paid}|${row.total}|${row.customer_name}|${row.customer_code || ''}|${row.delivery_address || ''}|${JSON.stringify(row.items || [])}`;
  if (cached && cached.stamp === stamp) return cached.buffer;
  const buffer = await invoiceImage.render({
    ...row,
    link: pageUrl(row.code),
  });
  images.set(row.code, { stamp, buffer });
  return buffer;
}

function present(row) {
  if (!row) return null;
  return {
    ...row,
    page_url: row.document_type === 'invoice' ? pageUrl(row.code) : null,
    image_url: row.document_type === 'invoice' ? imageUrl(row.code) : null,
  };
}

function resetForTests() {
  memory.clear();
  images.clear();
}

module.exports = {
  channelOf,
  statusOf,
  sign,
  verify,
  pageUrl,
  imageUrl,
  getByCode,
  recordSale,
  markIssued,
  markSent,
  setPayment,
  setPaymentStatus,
  applyRemote,
  refreshFromKiot,
  cleanMethod,
  search,
  toCsv,
  backfillCustomerCode,
  hydrateCustomerCodes,
  pngFor,
  present,
  resetForTests,
};
