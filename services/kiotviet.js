/**
 * KiotViet Public API (Retail).
 *
 * Auth:   POST https://id.kiotviet.vn/connect/token   (OAuth client_credentials,
 *         scope PublicApi.Access, token valid ~24h)
 * Calls:  https://public.kiotapi.com/...  with  Retailer: <shop>  +  Bearer token
 * Docs:   https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/
 *
 * Design rule: KiotViet must never break a conversation. Every function here
 * fails soft — the customer's order is already saved in our own database, and
 * a push failure becomes a message to the farm, not an error to the customer.
 */
const axios = require('axios');
const state = require('./state');

const TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
const BASE = process.env.KIOTVIET_BASE || 'https://public.kiotapi.com';
const K_TOKEN = 'kiotviet_access_token';
const K_TOKEN_EXP = 'kiotviet_token_expires_at';

let token = null;
let tokenExp = 0;            // epoch ms
let productCache = { at: 0, byCode: new Map(), byName: new Map() };
let branchId = null;

function enabled() {
  return !!(process.env.KIOTVIET_CLIENT_ID && process.env.KIOTVIET_CLIENT_SECRET && process.env.KIOTVIET_RETAILER);
}

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------
async function getToken(force = false) {
  if (!enabled()) return null;
  if (!force && token && Date.now() < tokenExp - 60_000) return token;

  if (!force && !token) {
    // Survive restarts without asking KiotViet for a new token every boot.
    const saved = await state.getMany([K_TOKEN, K_TOKEN_EXP]);
    if (saved[K_TOKEN] && Number(saved[K_TOKEN_EXP]) > Date.now() + 60_000) {
      token = saved[K_TOKEN];
      tokenExp = Number(saved[K_TOKEN_EXP]);
      return token;
    }
  }

  try {
    const body = new URLSearchParams({
      scopes: 'PublicApi.Access',
      grant_type: 'client_credentials',
      client_id: process.env.KIOTVIET_CLIENT_ID,
      client_secret: process.env.KIOTVIET_CLIENT_SECRET,
    });
    const r = await axios.post(TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    token = r.data.access_token;
    tokenExp = Date.now() + Number(r.data.expires_in || 86400) * 1000;
    await state.set(K_TOKEN, token);
    await state.set(K_TOKEN_EXP, String(tokenExp));
    console.log('🔑 KiotViet token obtained');
    return token;
  } catch (e) {
    console.error('KiotViet auth failed:', e.response?.data || e.message);
    return null;
  }
}

async function call(method, path, { params, data, retry = true } = {}) {
  const t = await getToken();
  if (!t) throw new Error('KiotViet chưa cấu hình hoặc lấy token thất bại');
  try {
    const r = await axios({
      method,
      url: `${BASE}${path}`,
      params,
      data,
      timeout: 20000,
      headers: {
        Retailer: process.env.KIOTVIET_RETAILER,
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/json',
      },
    });
    return r.data;
  } catch (e) {
    // An expired token looks like a 401 — refresh once and try again.
    if (retry && e.response?.status === 401) {
      await getToken(true);
      return call(method, path, { params, data, retry: false });
    }
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    throw new Error(`KiotViet ${method} ${path}: ${detail}`);
  }
}

// ------------------------------------------------------------------
// Reference data
// ------------------------------------------------------------------
async function getBranchId() {
  if (process.env.KIOTVIET_BRANCH_ID) return Number(process.env.KIOTVIET_BRANCH_ID);
  if (branchId) return branchId;
  const r = await call('get', '/branches', { params: { pageSize: 20 } });
  branchId = r?.data?.[0]?.id || null;
  if (branchId) console.log('🏬 KiotViet branch:', branchId, r.data[0].branchName);
  return branchId;
}

function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pull the product list so we can map our SKUs to KiotViet product ids. */
async function loadProducts(force = false) {
  if (!force && Date.now() - productCache.at < 10 * 60 * 1000 && productCache.byCode.size) {
    return productCache;
  }
  const byCode = new Map();
  const byName = new Map();
  let currentItem = 0;
  for (let page = 0; page < 20; page++) {
    const r = await call('get', '/products', { params: { pageSize: 100, currentItem } });
    const items = r?.data || [];
    for (const p of items) {
      if (p.code) byCode.set(String(p.code).toUpperCase(), p);
      if (p.name) byName.set(normName(p.name), p);
    }
    currentItem += items.length;
    if (items.length < 100 || currentItem >= (r.total || 0)) break;
  }
  productCache = { at: Date.now(), byCode, byName };
  console.log(`📦 KiotViet products loaded: ${byCode.size}`);
  return productCache;
}

/** Match by SKU first (exact), then by normalized Vietnamese name. */
async function findProduct({ sku, name }) {
  const cache = await loadProducts();
  if (sku && cache.byCode.has(String(sku).toUpperCase())) return cache.byCode.get(String(sku).toUpperCase());
  if (name && cache.byName.has(normName(name))) return cache.byName.get(normName(name));
  if (name) {
    const key = normName(name);
    for (const [k, v] of cache.byName) {
      if (k.includes(key) || key.includes(k)) return v;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Customers
// ------------------------------------------------------------------
async function findOrCreateCustomer({ name, phone }) {
  if (!phone) return null;
  try {
    const found = await call('get', '/customers', { params: { contactNumber: phone, pageSize: 1 } });
    if (found?.data?.length) return found.data[0];
  } catch (e) {
    console.warn('KiotViet customer lookup failed:', e.message);
  }
  try {
    const created = await call('post', '/customers', {
      data: { name: name || `Khách Zalo ${phone}`, contactNumber: phone },
    });
    return created?.data || created;
  } catch (e) {
    console.warn('KiotViet customer create failed:', e.message);
    return null;
  }
}

// ------------------------------------------------------------------
// Orders
// ------------------------------------------------------------------
/**
 * Push one of our orders into KiotViet as a sales order ("đơn đặt hàng"),
 * which reserves nothing and waits for the farm to confirm — safer than
 * writing an invoice straight from a chatbot.
 *
 * @returns {{ok:boolean, kiotOrderCode?:string, missing?:string[], error?:string}}
 */
async function pushOrder(order) {
  if (!enabled()) return { ok: false, error: 'KiotViet chưa cấu hình' };

  try {
    const branch = await getBranchId();
    if (!branch) return { ok: false, error: 'Không xác định được chi nhánh KiotViet' };

    const details = [];
    const missing = [];
    for (const item of order.items || []) {
      const p = await findProduct({ sku: item.sku, name: item.product_name });
      if (!p) { missing.push(item.product_name); continue; }
      details.push({
        productId: p.id,
        productCode: p.code,
        productName: p.fullName || p.name,
        quantity: Number(item.quantity),
        price: Number(item.unit_price),
      });
    }

    // Refuse to push a half-order: a wrong total in the POS is worse than none.
    if (missing.length) {
      return { ok: false, missing, error: `Chưa có trong KiotViet: ${missing.join(', ')}` };
    }
    if (!details.length) return { ok: false, error: 'Đơn không có dòng hàng hợp lệ' };

    const customer = await findOrCreateCustomer({ name: order.customerName, phone: order.phone });
    const total = details.reduce((s, d) => s + d.quantity * d.price, 0);

    const payload = {
      branchId: branch,
      purchaseDate: new Date().toISOString(),
      discount: 0,
      totalPayment: total,
      makeInvoice: false,          // order only, no invoice / no stock movement
      description: [
        `Đơn từ Zalo AI — ${order.order_number}`,
        order.address ? `Giao: ${order.address}` : null,
        order.note || null,
        `Thanh toán: ${String(order.payment || 'cod').toUpperCase()}`,
      ].filter(Boolean).join(' | '),
      orderDetails: details,
    };
    if (customer?.id) payload.customerId = customer.id;

    const created = await call('post', '/orders', { data: payload });
    const code = created?.code || created?.data?.code || created?.orderCode || null;
    console.log('🧾 KiotViet order created:', code);
    return { ok: true, kiotOrderCode: code, raw: created };
  } catch (e) {
    console.error('KiotViet pushOrder failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Cheap liveness probe for the health check. */
async function ping() {
  if (!enabled()) return { enabled: false };
  try {
    const branch = await getBranchId();
    return { enabled: true, ok: !!branch, branchId: branch };
  } catch (e) {
    return { enabled: true, ok: false, error: e.message };
  }
}

module.exports = { enabled, pushOrder, findProduct, loadProducts, ping, getToken };
