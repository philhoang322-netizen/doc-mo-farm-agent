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
 *
 * Stock: getOnHand() reads live inventories (onHand − reserved) for
 * KIOTVIET_RETAILER. services/stockGate.js compares that to STOCK_LOW_THRESHOLD
 * (default 5) before an order is confirmed. The 10-minute product cache is
 * only used to resolve a name to an id — never as the quantity we sell against.
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
    try { require('./healthWatch').noteFailure('kiotviet', 'auth'); } catch (_) {}
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
    try { require('./healthWatch').noteSuccess('kiotviet'); } catch (_) {}
    return r.data;
  } catch (e) {
    // An expired token looks like a 401 — refresh once and try again.
    if (retry && e.response?.status === 401) {
      await getToken(true);
      return call(method, path, { params, data, retry: false });
    }
    const status = e.response?.status;
    const code = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' ? 'timeout'
      : status === 401 ? 'auth'
      : status >= 500 ? 'upstream'
      : null;
    if (code) {
      try { require('./healthWatch').noteFailure('kiotviet', code); } catch (_) {}
    }
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    throw new Error(`KiotViet ${status || 'error'} ${method} ${path}: ${detail}`);
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
/** Lookup only. Does not create a KiotViet customer. */
async function findCustomerByPhone(phone) {
  if (!phone || !enabled()) return null;
  const found = await call('get', '/customers', { params: { contactNumber: phone, pageSize: 1 } });
  return found?.data?.[0] || null;
}

/** Recent invoices for one KiotViet customer id. Newest first when the API sorts. */
async function listInvoicesByCustomer(customerId, pageSize = 10) {
  if (!customerId || !enabled()) return [];
  const size = Math.min(20, Math.max(1, Number(pageSize) || 10));
  const found = await call('get', '/invoices', {
    params: {
      customerIds: customerId,
      pageSize: size,
      orderBy: 'purchaseDate',
      orderDirection: 'Desc',
    },
  });
  return found?.data || [];
}

function cleanCustomerCode(value) {
  const code = String(value || '').trim();
  return code ? code.slice(0, 40) : '';
}

const MISSING_CUSTOMER_CODE = 'Chưa có mã khách KiotViet (Mã KH). Hãy chọn hoặc tạo khách trên KiotViet rồi xác nhận lại.';

async function getCustomer(id) {
  if (!id || !enabled()) return null;
  const raw = await call('get', `/customers/${encodeURIComponent(id)}`);
  return unwrapDoc(raw);
}

/**
 * Mã KH must come from the Kiot customer. A code already on the object wins.
 * Otherwise we read GET /customers/{id}. A hinted code is only a fallback when
 * that read fails (network), not when Kiot returns a customer with no code.
 */
async function ensureSaleCustomerCode(customer, hintedCode) {
  const hinted = cleanCustomerCode(hintedCode);
  const onHand = cleanCustomerCode(customer && customer.code);
  if (onHand) return onHand;
  const id = customer && customer.id;
  if (id) {
    try {
      const fresh = await module.exports.getCustomer(id);
      const fetched = cleanCustomerCode(fresh && fresh.code);
      if (fetched) return fetched;
      if (fresh) return '';
    } catch (e) {
      console.warn('KiotViet customer code lookup failed:', e.message);
    }
  }
  return hinted;
}

async function findOrCreateCustomer({ name, phone, comments, customerId, customerCode }) {
  const existingId = Number(customerId);
  if (Number.isFinite(existingId) && existingId > 0) {
    const hinted = cleanCustomerCode(customerCode);
    if (!hinted) {
      try {
        const fresh = await module.exports.getCustomer(existingId);
        if (fresh) return fresh;
      } catch (e) {
        console.warn('KiotViet customer lookup failed:', e.message);
      }
    }
    return {
      id: existingId,
      code: hinted || null,
      name: name ? String(name).trim().slice(0, 200) : null,
    };
  }
  if (!phone) return null;
  try {
    const found = await call('get', '/customers', { params: { contactNumber: phone, pageSize: 1 } });
    if (found?.data?.length) return found.data[0];
  } catch (e) {
    console.warn('KiotViet customer lookup failed:', e.message);
  }
  try {
    const data = { name: name || `Khách Zalo ${phone}`, contactNumber: phone };
    const note = String(comments || '').trim();
    if (note) data.comments = note.slice(0, 500);
    const created = await call('post', '/customers', { data });
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

function unwrapProduct(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.id || body.code) return body;
  if (body.data && !Array.isArray(body.data) && (body.data.id || body.data.code)) return body.data;
  if (Array.isArray(body.data) && (body.data[0]?.id || body.data[0]?.code)) return body.data[0];
  return null;
}

function qtyField(row, keys) {
  if (!row) return 0;
  for (const key of keys) {
    if (row[key] == null || row[key] === '') continue;
    const n = Number(row[key]);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Sellable quantity at one branch: physical on-hand minus already reserved.
 * Accepts both onHand (product detail) and onhand (productOnHands).
 * No inventory rows → null (unknown, not zero). A chosen branch with no row → 0.
 *
 * @returns {{onHand:number, reserved:number, available:number}|null}
 */
function sellableFromInventories(inventories, branchId) {
  const rows = Array.isArray(inventories) ? inventories : [];
  if (!rows.length) return null;
  const scoped = branchId
    ? rows.filter(r => Number(r.branchId) === Number(branchId))
    : rows;
  if (branchId && !scoped.length) return { onHand: 0, reserved: 0, available: 0 };
  let onHand = 0;
  let reserved = 0;
  for (const row of scoped) {
    onHand += qtyField(row, ['onHand', 'onhand', 'OnHand']);
    reserved += qtyField(row, ['reserved', 'Reserved']);
  }
  return { onHand, reserved, available: Math.max(0, onHand - reserved) };
}

/**
 * Live on-hand for one SKU. Prefers GET /products/code/{sku}, which returns
 * inventories.onHand per branch, then GET /products/{id}, then /productOnHands.
 *
 * @returns {Promise<{ok:boolean, sku?:string, name?:string, productId?:number,
 *   branchId?:number, onHand?:number, reserved?:number, available?:number,
 *   reason?:string, error?:string}>}
 */
async function getOnHand({ sku, name, branchId: branchOverride } = {}) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  const code = sku ? String(sku).trim() : '';
  try {
    const branch = branchOverride != null && Number(branchOverride) > 0
      ? Number(branchOverride)
      : await getBranchId();
    let product = null;
    if (code) {
      try {
        product = unwrapProduct(await call('get', `/products/code/${encodeURIComponent(code)}`));
      } catch (_) {
        product = null;
      }
    }
    if (!product) product = await findProduct({ sku: code, name });
    if (!product) {
      return { ok: false, reason: 'not_found', sku: code || null, name: name || null };
    }

    let inventories = product.inventories;
    if (!Array.isArray(inventories) && product.id) {
      try {
        const detail = unwrapProduct(await call('get', `/products/${product.id}`));
        if (detail) {
          product = { ...product, ...detail };
          inventories = detail.inventories;
        }
      } catch (e) {
        return {
          ok: false,
          reason: 'lookup_failed',
          error: e.message,
          sku: product.code || code || null,
          name: product.fullName || product.name || name || null,
          productId: product.id,
          branchId: branch,
        };
      }
    }
    if (!Array.isArray(inventories) && (product.code || code)) {
      const hands = await findProductOnHands(product.code || code, branch);
      if (hands) {
        product = { ...product, ...hands };
        inventories = hands.inventories;
      }
    }

    const qty = sellableFromInventories(inventories, branch);
    if (!qty) {
      return {
        ok: false,
        reason: 'no_inventory',
        sku: product.code || code || null,
        name: product.fullName || product.name || name || null,
        productId: product.id || null,
        branchId: branch,
      };
    }
    return {
      ok: true,
      sku: product.code || code || null,
      name: product.fullName || product.name || name || null,
      productId: product.id || null,
      branchId: branch,
      ...qty,
    };
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', error: e.message, sku: code || null, name: name || null };
  }
}

/** Page /productOnHands until this code shows up. Stock-only payload uses onhand. */
async function findProductOnHands(code, branchId) {
  const want = String(code || '').toUpperCase();
  if (!want) return null;
  let currentItem = 0;
  for (let page = 0; page < 20; page++) {
    const params = { pageSize: 100, currentItem };
    if (branchId) params.branchIds = branchId;
    const r = await call('get', '/productOnHands', { params });
    const items = r?.data || [];
    const hit = items.find(p => String(p.code || '').toUpperCase() === want);
    if (hit) return hit;
    currentItem += items.length;
    if (!items.length || items.length < 100 || currentItem >= (r.total || 0)) break;
  }
  return null;
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

/** Spoken names that should hit a catalog SKU when the farm has one. */
function aliasFor(text) {
  const key = normName(text);
  if (!key || !key.includes('heotrang')) return null;
  let sku = null;
  let name = 'Heo trắng';
  try {
    const catalog = require('./catalog');
    const row = (catalog.rows() || []).find(p => normName(p.name_vi).includes('heotrang'));
    if (row) {
      sku = row.sku || null;
      name = row.name_vi || name;
    }
  } catch (_) { /* catalog is optional for a name search */ }
  return { sku, name };
}

function productPrice(p) {
  const n = Number(p && (p.basePrice != null ? p.basePrice : p.price));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function publicProduct(p) {
  const qty = sellableFromInventories(p && p.inventories, saleBranchId());
  const available = qty ? qty.available : (p && p.available != null ? Number(p.available) : null);
  return {
    id: p.id,
    code: p.code || null,
    name: p.fullName || p.name || null,
    price: productPrice(p),
    unit: p.unit || null,
    available: Number.isFinite(available) ? available : null,
  };
}

/** Accent-insensitive name or code match. "xúc xích" matches "xuc xich". */
function rankProducts(products, query, limit = 8) {
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  const want = Math.min(30, Math.max(1, Number(limit) || 8));
  const upper = q.toUpperCase();
  const queryKey = normName(q);
  const hits = [];
  const seen = new Set();
  for (const raw of products || []) {
    if (!raw) continue;
    const code = String(raw.code || '').toUpperCase();
    const nameKey = normName(raw.name || raw.fullName || '');
    const codeHit = code.includes(upper);
    const nameHit = queryKey && nameKey.includes(queryKey);
    if (!codeHit && !nameHit) continue;
    const key = String(raw.id != null ? raw.id : code || nameKey);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(raw);
    if (hits.length >= want) break;
  }
  return hits;
}

/**
 * Search the live product list by code or name. "heo trắng" uses aliasFor
 * so a catalog SKU wins when the farm has mapped that name.
 */
async function searchProducts(query, limit = 8) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const cache = await loadProducts();
  const alias = aliasFor(q);
  const want = Math.min(30, Math.max(1, Number(limit) || 8));
  const shaped = [...cache.byCode.values()].map(publicProduct);
  const hits = [];
  const seen = new Set();
  if (alias && alias.sku) {
    const sku = String(alias.sku).toUpperCase();
    const aliased = shaped.find(p => String(p.code || '').toUpperCase() === sku);
    if (aliased) {
      hits.push(aliased);
      seen.add(aliased.id);
    }
  }
  const aliasKey = alias ? normName(alias.name) : '';
  const ranked = rankProducts(shaped, q, want);
  const extra = aliasKey
    ? rankProducts(shaped, alias.name, want)
    : [];
  for (const p of ranked.concat(extra)) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    hits.push(p);
    if (hits.length >= want) break;
  }
  return hits;
}

/**
 * Admin sales use this branch for stock reads. KIOTVIET_BRANCH_ID wins;
 * otherwise the farm branch. Invoice and order creation does not trust this
 * number until GET /branches confirms it — see resolveSaleBranch.
 */
const DEFAULT_SALE_BRANCH_ID = 26947;

const DIRECTORY_TTL_MS = 60 * 60 * 1000;
let userDirectory = { at: 0, rows: null };
let branchDirectory = { at: 0, rows: null };

function clearSaleDirectoryCache() {
  userDirectory = { at: 0, rows: null };
  branchDirectory = { at: 0, rows: null };
}

function positiveId(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function directoryRows(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return null;
}

function envIdLabel(raw, id) {
  if (id) return String(id);
  if (raw != null && String(raw).trim() !== '') return 'invalid';
  return 'unset';
}

async function listUsers() {
  if (userDirectory.rows && Date.now() - userDirectory.at < DIRECTORY_TTL_MS) {
    return userDirectory.rows;
  }
  const body = await module.exports.call('get', '/users', {
    params: { pageSize: 100, currentItem: 0 },
  });
  const rows = directoryRows(body);
  if (!rows) throw new Error('KiotViet /users không trả danh sách');
  userDirectory = { at: Date.now(), rows };
  return rows;
}

async function listBranches() {
  if (branchDirectory.rows && Date.now() - branchDirectory.at < DIRECTORY_TTL_MS) {
    return branchDirectory.rows;
  }
  const body = await module.exports.call('get', '/branches', {
    params: { pageSize: 20, currentItem: 0 },
  });
  const rows = directoryRows(body);
  if (!rows) throw new Error('KiotViet /branches không trả danh sách');
  branchDirectory = { at: Date.now(), rows };
  return rows;
}

function userIdOf(row) {
  if (!row || typeof row !== 'object') return null;
  return positiveId(row.id != null ? row.id : row.userId);
}

function branchIdOf(row) {
  if (!row || typeof row !== 'object') return null;
  return positiveId(row.id);
}

function firstPositive(rows, pick) {
  for (const row of rows || []) {
    const id = pick(row);
    if (id) return id;
  }
  return null;
}

function directoryHas(rows, wanted, pick) {
  if (!wanted) return false;
  return (rows || []).some(row => pick(row) === wanted);
}

/**
 * Seller for POST /invoices and POST /orders.
 * KIOTVIET_SOLD_BY_ID is used only when GET /users still lists that id.
 * Otherwise the first user is the fallback. soldById is optional on those
 * posts, so a failed or empty /users response omits the field instead of
 * sending an id we could not check.
 */
const BRANCH_UNKNOWN_ERROR = 'Không xác định được chi nhánh KiotViet. Kiểm tra kết nối rồi thử lại.';

async function resolveSoldBy() {
  const raw = process.env.KIOTVIET_SOLD_BY_ID;
  const wanted = positiveId(raw);
  let rows;
  try {
    rows = await module.exports.listUsers();
  } catch (_) {
    console.log('KiotViet seller omitted');
    return { soldById: null, source: 'omitted', error: null };
  }
  if (wanted && directoryHas(rows, wanted, userIdOf)) {
    return { soldById: wanted, source: 'env', error: null };
  }
  const fallback = firstPositive(rows, userIdOf);
  if (!fallback) {
    console.log('KiotViet seller omitted');
    return { soldById: null, source: 'omitted', error: null };
  }
  console.log(`KiotViet seller fallback id=${fallback} env=${envIdLabel(raw, wanted)}`);
  return { soldById: fallback, source: 'fallback', error: null };
}

/** KIOTVIET_BRANCH_ID must be in GET /branches. Otherwise the first branch. */
async function resolveSaleBranch() {
  const raw = process.env.KIOTVIET_BRANCH_ID;
  const wanted = positiveId(raw);
  let rows;
  try {
    rows = await module.exports.listBranches();
  } catch (_) {
    return { branchId: null, source: 'error', error: BRANCH_UNKNOWN_ERROR };
  }
  if (wanted && directoryHas(rows, wanted, branchIdOf)) {
    return { branchId: wanted, source: 'env', error: null };
  }
  const fallback = firstPositive(rows, branchIdOf);
  if (!fallback) {
    return { branchId: null, source: 'error', error: BRANCH_UNKNOWN_ERROR };
  }
  console.log(`KiotViet branch fallback id=${fallback} env=${envIdLabel(raw, wanted)}`);
  return { branchId: fallback, source: 'fallback', error: null };
}

function saleBranchId() {
  const raw = process.env.KIOTVIET_BRANCH_ID;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_SALE_BRANCH_ID;
}

function moneyAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function documentId(created) {
  if (!created || typeof created !== 'object') return null;
  const id = created.id || created.invoiceId || created.orderId
    || (created.data && (created.data.id || created.data.invoiceId || created.data.orderId));
  if (id == null || id === '') return null;
  return String(id).slice(0, 40);
}

function unwrapDoc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.id || raw.code) return raw;
  if (raw.data && !Array.isArray(raw.data) && (raw.data.id || raw.data.code)) return raw.data;
  return null;
}

function explainKiotError(err) {
  const raw = String((err && err.message) || err || '');
  let embedded = '';
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      embedded = String(
        (parsed.responseStatus && (parsed.responseStatus.message || parsed.responseStatus.error))
        || parsed.message
        || parsed.error
        || ''
      );
    } catch (_) { embedded = ''; }
  }
  const blob = `${raw} ${embedded}`.toLowerCase();
  if (/token thất bại|invalid_token|unauthorized|chưa cấu hình hoặc lấy token|\b401\b/.test(blob)) {
    return 'KiotViet từ chối đăng nhập (token). Kiểm tra kết nối rồi thử lại.';
  }
  if (/timeout|timed out|econnaborted|etimedout/.test(blob)) {
    return 'KiotViet không phản hồi kịp. Thử lại sau.';
  }
  if (/hết hàng|het hang|tồn kho|ton kho|out of stock|insufficient|không đủ tồn|khong du ton|not enough/.test(blob)) {
    return 'Không đủ tồn kho trên KiotViet. Giảm số lượng hoặc kiểm tra kho.';
  }
  const detail = (embedded || raw.replace(/^KiotViet\s+\S+\s+\w+\s+\S+:\s*/, '')).replace(/\s+/g, ' ').trim().slice(0, 180);
  if (/\b400\b|validation|invalid|không hợp lệ|khong hop le/.test(blob)) {
    return detail ? `KiotViet không nhận đơn: ${detail}` : 'KiotViet không nhận đơn. Kiểm tra lại dữ liệu.';
  }
  return detail ? `KiotViet báo lỗi: ${detail}` : 'KiotViet báo lỗi. Thử lại sau.';
}

function documentCode(created) {
  if (!created || typeof created !== 'object') return null;
  const code = created.code || created.orderCode || created.invoiceCode
    || (created.data && (created.data.code || created.data.orderCode || created.data.invoiceCode));
  return code ? String(code).slice(0, 40) : null;
}

function documentTotal(created, fallback) {
  const raw = created && (created.total != null ? created.total : (created.data && created.data.total));
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return fallback;
}

/**
 * Build the Public API body for an invoice (HĐ) or an order (Đặt hàng).
 * Invoice totalPayment stays 0 so KiotViet does not mark it paid; the
 * customer transfers after the manager sends the draft.
 */
function salePayload({
  kind, branchId, soldById, customerId, customerName, phone, address,
  discount, shippingFee, description, details,
}) {
  const ship = moneyAmount(shippingFee);
  const off = moneyAmount(discount);
  const seller = positiveId(soldById);
  const delivery = (address || ship)
    ? {
      receiver: customerName || undefined,
      contactNumber: phone || undefined,
      address: address || undefined,
      price: ship,
    }
    : null;
  if (kind === 'order') {
    const payload = {
      branchId,
      purchaseDate: new Date().toISOString(),
      discount: off,
      description: description || '',
      method: 'Transfer',
      totalPayment: 0,
      makeInvoice: false,
      orderDetails: details,
      customerId,
    };
    if (seller) payload.soldById = seller;
    if (delivery) payload.orderDelivery = delivery;
    return payload;
  }
  const payload = {
    branchId,
    purchaseDate: new Date().toISOString(),
    discount: off,
    totalPayment: 0,
    method: 'Transfer',
    usingCod: false,
    description: description || '',
    invoiceDetails: details,
    customerId,
  };
  if (seller) payload.soldById = seller;
  if (delivery) payload.delivery = delivery;
  return payload;
}

/**
 * Create one invoice or one order from lines the manager already confirmed.
 * Does not run from the chatbot. pushOrder stays order-only.
 *
 * @returns {Promise<{ok:boolean, id?:string, code?:string, total?:number, documentType?:string,
 *   branchId?:number, error?:string, missing?:string[]}>}
 */
async function createSaleDocument({
  documentType = 'invoice',
  customerName,
  phone,
  address,
  note,
  discount = 0,
  shippingFee = 0,
  lines = [],
  description,
  customerComment,
  customerId,
  customerCode,
} = {}) {
  if (!enabled()) return { ok: false, error: 'KiotViet chưa cấu hình' };
  const kind = documentType === 'order' ? 'order' : 'invoice';
  try {
    const details = [];
    const missing = [];
    const find = module.exports.findProduct;
    for (const item of lines || []) {
      const alias = aliasFor(item.product_name || item.name);
      const sku = item.sku || (alias && alias.sku) || '';
      const p = sku
        ? await find({ sku })
        : await find({ name: item.product_name || item.name || (alias && alias.name) });
      if (!p) {
        missing.push(item.product_name || item.sku || 'sản phẩm');
        continue;
      }
      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { ok: false, error: 'Số lượng không hợp lệ' };
      }
      details.push({
        productId: p.id,
        productCode: p.code,
        productName: p.fullName || p.name,
        quantity: qty,
        price: productPrice(p),
      });
    }
    if (missing.length) {
      return { ok: false, missing, error: `Chưa có trong KiotViet: ${missing.join(', ')}` };
    }
    if (!details.length) return { ok: false, error: 'Đơn không có dòng hàng hợp lệ' };

    const customer = await module.exports.findOrCreateCustomer({
      name: customerName,
      phone,
      comments: customerComment,
      customerId,
      customerCode,
    });
    if (!customer || !customer.id) {
      return { ok: false, error: 'Không tạo được khách KiotViet theo số điện thoại' };
    }
    const saleCustomerCode = await module.exports.ensureSaleCustomerCode(customer, customerCode);
    if (!saleCustomerCode) {
      return { ok: false, error: MISSING_CUSTOMER_CODE };
    }

    const subtotal = details.reduce((s, d) => s + d.quantity * d.price, 0);
    const off = moneyAmount(discount);
    const ship = moneyAmount(shippingFee);
    if (off > subtotal) return { ok: false, error: 'Giảm giá lớn hơn tiền hàng' };
    const total = Math.max(0, Math.round(subtotal - off + ship));
    const desc = String(description || [
      note || null,
      address ? `Giao: ${address}` : null,
    ].filter(Boolean).join(' | ')).slice(0, 500);

    const seller = await module.exports.resolveSoldBy();
    if (seller.error) return { ok: false, error: seller.error };
    const pickedBranch = await module.exports.resolveSaleBranch();
    if (pickedBranch.error) return { ok: false, error: pickedBranch.error };
    const branch = pickedBranch.branchId;

    const payload = salePayload({
      kind,
      branchId: branch,
      soldById: seller.soldById,
      customerId: customer.id,
      customerName,
      phone,
      address,
      discount: off,
      shippingFee: ship,
      description: desc,
      details,
    });
    const path = kind === 'order' ? '/orders' : '/invoices';
    const created = await module.exports.call('post', path, { data: payload });
    const code = documentCode(created);
    if (!code) {
      return { ok: false, error: 'KiotViet không trả mã chứng từ. Kiểm tra trên KiotViet trước khi tạo lại.' };
    }
    const charged = documentTotal(created, total);
    console.log('🧾 KiotViet', kind, 'created:', code);
    return {
      ok: true,
      id: documentId(created),
      code,
      total: charged,
      documentType: kind,
      branchId: branch,
      customerId: customer.id,
      customerCode: saleCustomerCode,
      customerName: customer.name || customerName || null,
    };
  } catch (e) {
    console.error('KiotViet createSaleDocument failed:', e.message);
    return { ok: false, error: explainKiotError(e) };
  }
}

async function fetchSaleDoc(collection, { id, code } = {}) {
  if (id) {
    const raw = await call('get', `/${collection}/${encodeURIComponent(id)}`);
    const doc = unwrapDoc(raw);
    if (doc) return doc;
  }
  if (!code) return null;
  const found = await call('get', `/${collection}`, { params: { pageSize: 50, code } });
  const rows = Array.isArray(found) ? found : ((found && found.data) || []);
  const hit = rows.find(row => String(row.code) === String(code));
  if (hit) return hit;
  try {
    const raw = await call('get', `/${collection}/code/${encodeURIComponent(code)}`);
    return unwrapDoc(raw);
  } catch (_) {
    return null;
  }
}

function paymentFromInvoice(doc) {
  const total = Math.round(Number(doc && doc.total) || 0);
  const paidRaw = doc && (doc.totalPayment != null ? doc.totalPayment : doc.totalPaid);
  const paid = Math.max(0, Math.round(Number(paidRaw) || 0));
  let payment_status = 'chua_tt';
  if (paid > 0 && total > 0 && paid < total) payment_status = 'mot_phan';
  else if (paid > 0 && (total === 0 || paid >= total)) payment_status = 'da_tt';
  return {
    payment_status,
    amount_paid: paid,
    total,
    kiot_status: doc && doc.status != null ? doc.status : null,
    id: doc && doc.id != null ? String(doc.id) : null,
    code: doc && doc.code ? String(doc.code) : null,
  };
}

/** Read one Kiot invoice and map totalPayment onto our payment status. */
async function readInvoicePayment({ id, code } = {}) {
  if (!enabled()) return { ok: false, error: 'KiotViet chưa cấu hình' };
  try {
    const doc = await fetchSaleDoc('invoices', { id, code });
    if (!doc) return { ok: false, error: 'Không thấy hoá đơn trên KiotViet' };
    return { ok: true, ...paymentFromInvoice(doc) };
  } catch (e) {
    return { ok: false, error: explainKiotError(e) };
  }
}

/**
 * Turn a confirmed order (ĐH) into an invoice (HĐ). Separate from create:
 * the manager presses Xuất hóa đơn. totalPayment stays 0.
 */
async function issueInvoiceFromOrder({ orderId, orderCode } = {}) {
  if (!enabled()) return { ok: false, error: 'KiotViet chưa cấu hình' };
  try {
    const order = await fetchSaleDoc('orders', { id: orderId, code: orderCode });
    if (!order || !(order.id || orderId)) {
      return { ok: false, error: 'Không thấy đơn đặt hàng trên KiotViet' };
    }
    const id = order.id || orderId;
    const details = (order.orderDetails || []).map(d => ({
      productId: d.productId,
      productCode: d.productCode,
      productName: d.productName,
      quantity: d.quantity,
      price: d.price,
      discount: d.discount || 0,
    })).filter(d => d.productId && Number(d.quantity) > 0);
    if (!details.length) {
      return { ok: false, error: 'Đơn đặt hàng không có dòng hàng để xuất hoá đơn' };
    }
    let customerCode = cleanCustomerCode(order.customerCode);
    if (!customerCode && order.customerId) {
      try {
        const fresh = await module.exports.getCustomer(order.customerId);
        customerCode = cleanCustomerCode(fresh && fresh.code);
      } catch (e) {
        console.warn('KiotViet customer code lookup failed:', e.message);
      }
    }
    if (!customerCode) {
      return { ok: false, error: MISSING_CUSTOMER_CODE };
    }
    const seller = await module.exports.resolveSoldBy();
    if (seller.error) return { ok: false, error: seller.error };
    let branch = positiveId(order.branchId);
    if (!branch) {
      const pickedBranch = await module.exports.resolveSaleBranch();
      if (pickedBranch.error) return { ok: false, error: pickedBranch.error };
      branch = pickedBranch.branchId;
    }
    const payload = {
      branchId: branch,
      orderId: id,
      purchaseDate: new Date().toISOString(),
      customerId: order.customerId,
      discount: moneyAmount(order.discount),
      totalPayment: 0,
      method: 'Transfer',
      description: order.description || '',
      invoiceDetails: details,
    };
    if (seller.soldById) payload.soldById = seller.soldById;
    const created = await module.exports.call('post', '/invoices', { data: payload });
    const code = documentCode(created);
    if (!code) {
      return { ok: false, error: 'KiotViet không trả mã hoá đơn. Kiểm tra trên KiotViet trước khi xuất lại.' };
    }
    return {
      ok: true,
      id: documentId(created),
      code,
      total: documentTotal(created, moneyAmount(order.total)),
      documentType: 'invoice',
      orderId: String(id),
      orderCode: order.code || orderCode || null,
      customerId: order.customerId || null,
      customerCode,
      customerName: order.customerName || null,
    };
  } catch (e) {
    console.error('KiotViet issueInvoiceFromOrder failed:', e.message);
    return { ok: false, error: explainKiotError(e) };
  }
}

function matchableProduct(p) {
  const qty = sellableFromInventories(p && p.inventories, saleBranchId());
  return {
    id: p.id,
    code: p.code || '',
    name: p.fullName || p.name || '',
    price: productPrice(p),
    unit: p.unit || '',
    isActive: p.isActive !== false && p.allowsSale !== false,
    available: qty ? qty.available : null,
  };
}

/** Cached catalog (10 minutes, see loadProducts) shaped for quick-entry matching. */
async function listProductsForMatch() {
  const cache = await loadProducts();
  return [...cache.byCode.values()].map(matchableProduct);
}

module.exports = {
  enabled, pushOrder, findProduct, loadProducts, ping, getToken,
  getOnHand, sellableFromInventories,
  searchProducts, rankProducts, aliasFor, saleBranchId, salePayload, createSaleDocument,
  listProductsForMatch, findCustomerByPhone, findOrCreateCustomer, getCustomer,
  ensureSaleCustomerCode, listInvoicesByCustomer,
  explainKiotError, paymentFromInvoice, readInvoicePayment, issueInvoiceFromOrder,
  cleanCustomerCode, MISSING_CUSTOMER_CODE, call,
  DEFAULT_SALE_BRANCH_ID,
  listUsers, listBranches, resolveSoldBy, resolveSaleBranch, clearSaleDirectoryCache,
  BRANCH_UNKNOWN_ERROR,
};
