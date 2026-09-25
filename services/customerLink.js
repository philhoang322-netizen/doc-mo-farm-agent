/**
 * One customer profile keyed by phone. A Zalo user id, a Facebook PSID,
 * and a KiotViet customer id hang off that number.
 *
 * DATABASE_URL set → Postgres customer_links (migration 026). Otherwise a
 * JSON file next to the drafts file. Linking never sends a customer reply.
 */
const fs = require('fs');
const path = require('path');
const db = require('./database');
const kiotviet = require('./kiotviet');
const pii = require('./pii');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customer_links (
    phone              TEXT PRIMARY KEY,
    name               TEXT,
    zalo_user_id       TEXT,
    facebook_psid      TEXT,
    kiot_customer_id   TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_customer_links_zalo ON customer_links (zalo_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_links_psid ON customer_links (facebook_psid)`,
];

const PHONE_RE = /(?:\+?84|0)[\s.\-]*[35789](?:[\s.\-]*\d){8,9}/g;

let ready = null;
const historyCache = new Map();

function filePath() {
  if (process.env.CUSTOMER_LINKS_PATH) return process.env.CUSTOMER_LINKS_PATH;
  if (process.env.DRAFTS_JSON_PATH) {
    return path.join(path.dirname(process.env.DRAFTS_JSON_PATH), 'customer_links.json');
  }
  return path.join(require('os').tmpdir(), `dmf-customer-links-${process.pid}.json`);
}

function cacheMs() {
  const n = Number(process.env.CUSTOMER_HISTORY_CACHE_MIN);
  const min = Number.isFinite(n) && n >= 0 ? n : 15;
  return min * 60 * 1000;
}

function phonesIn(text) {
  const found = [];
  const s = String(text || '');
  PHONE_RE.lastIndex = 0;
  let match;
  while ((match = PHONE_RE.exec(s))) {
    const phone = db.normalizePhone(match[0]);
    if (phone && !found.includes(phone)) found.push(phone);
  }
  return found;
}

function blank(phone) {
  return {
    phone,
    name: null,
    zalo_user_id: null,
    facebook_psid: null,
    kiot_customer_id: null,
    updated_at: new Date().toISOString(),
  };
}

function fromDb(row) {
  if (!row) return null;
  return {
    phone: row.phone,
    name: row.name || null,
    zalo_user_id: row.zalo_user_id || null,
    facebook_psid: row.facebook_psid || null,
    kiot_customer_id: row.kiot_customer_id || null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function readFile() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(data.profiles) ? data.profiles : [];
  } catch {
    return [];
  }
}

function writeFile(profiles) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify({ profiles }));
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

async function listAll() {
  await ensureReady();
  if (!db.DB_ENABLED) return readFile().map(fromDb);
  const r = await db.pool.query('SELECT * FROM customer_links');
  return r.rows.map(fromDb);
}

async function getByPhone(phone) {
  const p = db.normalizePhone(phone);
  if (!p) return null;
  await ensureReady();
  if (!db.DB_ENABLED) return readFile().map(fromDb).find(row => row.phone === p) || null;
  const r = await db.pool.query('SELECT * FROM customer_links WHERE phone = $1', [p]);
  return fromDb(r.rows[0]);
}

async function upsert(row) {
  const next = {
    ...blank(row.phone),
    ...row,
    phone: row.phone,
    updated_at: new Date().toISOString(),
  };
  await ensureReady();
  if (!db.DB_ENABLED) {
    const profiles = readFile().filter(item => item.phone !== next.phone);
    profiles.push(next);
    writeFile(profiles);
    return fromDb(next);
  }
  const r = await db.pool.query(
    `INSERT INTO customer_links (phone, name, zalo_user_id, facebook_psid, kiot_customer_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       zalo_user_id = EXCLUDED.zalo_user_id,
       facebook_psid = EXCLUDED.facebook_psid,
       kiot_customer_id = EXCLUDED.kiot_customer_id,
       updated_at = NOW()
     RETURNING *`,
    [next.phone, next.name, next.zalo_user_id, next.facebook_psid, next.kiot_customer_id]
  );
  return fromDb(r.rows[0]);
}

function psidOf(userId) {
  return String(userId || '').replace(/^fb_/, '').trim();
}

function channelOf(channel, userId) {
  if (channel === 'messenger' || String(userId || '').startsWith('fb_')) return 'messenger';
  if (channel === 'zalo' || channel === 'oa' || channel === 'bot') return 'zalo';
  return null;
}

async function detach(field, value, keepPhone) {
  if (!value) return;
  const rows = await listAll();
  for (const row of rows) {
    if (row.phone === keepPhone || row[field] !== value) continue;
    row[field] = null;
    await upsert(row);
  }
}

async function findByExternal(userId) {
  const raw = String(userId || '').trim();
  if (!raw) return null;
  const psid = psidOf(raw);
  const rows = await listAll();
  return rows.find(row =>
    row.zalo_user_id === raw || row.facebook_psid === psid || row.facebook_psid === raw
  ) || null;
}

/**
 * Attach a channel id and/or a KiotViet customer to a phone. A channel id
 * moves off any other phone so one Zalo id or PSID belongs to one profile.
 */
async function note({ phone, name, channel, userId, kiotCustomerId }) {
  const p = db.normalizePhone(phone);
  if (!p) return null;
  const row = (await getByPhone(p)) || blank(p);
  const label = String(name || '').trim().slice(0, 120);
  if (label) row.name = label;
  const kind = channelOf(channel, userId);
  if (kind === 'zalo' && userId) {
    const id = String(userId).slice(0, 200);
    await detach('zalo_user_id', id, p);
    row.zalo_user_id = id;
  }
  if (kind === 'messenger' && userId) {
    const id = psidOf(userId).slice(0, 200);
    if (id) {
      await detach('facebook_psid', id, p);
      row.facebook_psid = id;
    }
  }
  if (kiotCustomerId) row.kiot_customer_id = String(kiotCustomerId).slice(0, 40);
  const saved = await upsert(row);
  if (db.DB_ENABLED && userId && kind) {
    try {
      const key = kind === 'messenger' ? `fb_${saved.facebook_psid}` : saved.zalo_user_id;
      const customer = await db.getOrCreateCustomer(key, saved.name);
      if (customer) await db.setPhoneAndMerge(customer.id, p);
    } catch (err) {
      console.error('Customer identity sync skipped:', err.message);
    }
  }
  return saved;
}

async function unlink({ phone, channel }) {
  const row = await getByPhone(phone);
  if (!row) return null;
  if (channel === 'zalo') row.zalo_user_id = null;
  else if (channel === 'messenger') row.facebook_psid = null;
  else if (channel === 'kiot') row.kiot_customer_id = null;
  else return null;
  return upsert(row);
}

async function forDraft(draft) {
  if (!draft) return null;
  const phone = db.normalizePhone(draft.customer_phone);
  if (phone) {
    const byPhone = await getByPhone(phone);
    if (byPhone) return byPhone;
  }
  if (draft.customer_user_id) {
    const byId = await findByExternal(draft.customer_user_id);
    if (byId) return byId;
  }
  if (!phone) return null;
  return {
    ...blank(phone),
    name: draft.customer_name || null,
  };
}

function present(row) {
  if (!row || !row.phone) return null;
  const channels = [];
  if (row.zalo_user_id) channels.push('zalo');
  if (row.facebook_psid) channels.push('messenger');
  if (row.kiot_customer_id) channels.push('kiot');
  return {
    phone: row.phone,
    name: row.name || null,
    channels,
  };
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function dayOf(value) {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(0, 10);
}

function cancelled(inv) {
  return Number(inv && inv.status) === 2;
}

function summarizeInvoices(invoices, kiotId) {
  const rows = (invoices || []).filter(inv => inv && !cancelled(inv));
  rows.sort((a, b) => Date.parse(b.purchaseDate || 0) - Date.parse(a.purchaseDate || 0));
  const orders = rows.slice(0, 3).map(inv => ({
    code: String(inv.code || '').slice(0, 40),
    date: dayOf(inv.purchaseDate),
    total: money(inv.total),
    unpaid: money(inv.totalPayment) < money(inv.total),
  }));
  return {
    available: true,
    kiot_customer_id: kiotId ? String(kiotId) : null,
    orders,
    total_spent: rows.reduce((sum, inv) => sum + money(inv.total), 0),
    last_purchase: dayOf(rows[0] && rows[0].purchaseDate),
    unpaid_count: rows.filter(inv => money(inv.totalPayment) < money(inv.total)).length,
  };
}

function publicHistory(history) {
  const h = history || {};
  return {
    available: h.available === true,
    reason: h.available ? null : (h.reason || 'error'),
    orders: h.orders || [],
    total_spent: h.total_spent || 0,
    last_purchase: h.last_purchase || null,
    unpaid_count: h.unpaid_count || 0,
  };
}

async function purchaseHistory(phone) {
  const p = db.normalizePhone(phone);
  if (!p) return { available: false, reason: 'no_phone' };
  const hit = historyCache.get(p);
  if (hit && Date.now() - hit.at < cacheMs()) return hit.value;
  let value;
  try {
    if (!kiotviet.enabled()) {
      value = { available: false, reason: 'unconfigured' };
    } else if (typeof kiotviet.findCustomerByPhone !== 'function') {
      value = { available: false, reason: 'unconfigured' };
    } else {
      const customer = await kiotviet.findCustomerByPhone(p);
      if (!customer || !customer.id) {
        value = summarizeInvoices([], null);
      } else {
        const invoices = typeof kiotviet.listInvoicesByCustomer === 'function'
          ? await kiotviet.listInvoicesByCustomer(customer.id)
          : [];
        value = summarizeInvoices(invoices, customer.id);
      }
    }
  } catch (err) {
    console.error('KiotViet history skipped:', err.message);
    value = { available: false, reason: 'error' };
  }
  historyCache.set(p, { at: Date.now(), value });
  return value;
}

async function viewForDraft(draft) {
  let row = await forDraft(draft);
  const phone = (row && row.phone) || db.normalizePhone(draft && draft.customer_phone);
  if (!row && phone) row = { ...blank(phone), name: (draft && draft.customer_name) || null };
  const history = phone ? await purchaseHistory(phone) : { available: false, reason: 'no_phone' };
  if (history && history.kiot_customer_id && row && !row.kiot_customer_id) {
    row = await note({
      phone: row.phone,
      name: row.name,
      kiotCustomerId: history.kiot_customer_id,
    }) || row;
  }
  return { profile: present(row), history: publicHistory(history) };
}

function safeLine(history) {
  if (!history || history.available !== true) return '';
  if (!history.total_spent && !(history.orders || []).length) return '';
  const recent = (history.orders || []).map(order =>
    `${order.date || 'ngày không rõ'} ${order.total}đ${order.unpaid ? ' (chưa thanh toán)' : ''}`
  ).join('; ');
  const raw = [
    'Lịch sử mua trên KiotViet (đã bỏ tên và số điện thoại):',
    `tổng ${history.total_spent}đ,`,
    history.last_purchase ? `mua lần cuối ${history.last_purchase},` : '',
    `hóa đơn chưa thanh toán: ${history.unpaid_count}.`,
    recent ? `Gần nhất: ${recent}.` : '',
  ].filter(Boolean).join(' ');
  const masked = pii.maskText(raw);
  if (/\d{9,}/.test(masked)) return '';
  return '\n' + masked;
}

async function promptContext({ externalId, name, knownPhone, text, channel } = {}) {
  const heard = phonesIn(text)[0] || null;
  const phone = heard || db.normalizePhone(knownPhone);
  const kind = channelOf(channel, externalId);
  if (phone && (heard || externalId)) {
    await note({
      phone,
      name,
      channel: kind,
      userId: externalId,
    });
  }
  let usePhone = phone;
  if (!usePhone && externalId) {
    const row = await findByExternal(externalId);
    usePhone = row && row.phone;
  }
  if (!usePhone) return '';
  return safeLine(await purchaseHistory(usePhone));
}

function clearCache() {
  historyCache.clear();
}

module.exports = {
  phonesIn,
  note,
  unlink,
  forDraft,
  viewForDraft,
  promptContext,
  purchaseHistory,
  clearCache,
  filePath,
  present,
};
