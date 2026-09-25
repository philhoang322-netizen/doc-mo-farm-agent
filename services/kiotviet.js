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
/** Lookup only. Does not create a KiotViet customer. */
async function findCustomerByPhone(phone) {
  if (!phone || !enabled()) return null;
  const found = await call('get', '/customers', { params: { contactNumber: phone, pageSize: 1 } });
  return found?.data?.[0] || null;
}

async function findOrCreateCustomer({ name, phone, comments, customerId, customerCode }) {
  const existingId = Number(customerId);
  if (Number.isFinite(existingId) && existingId > 0) {
    return {
      id: existingId,
      code: customerCode ? String(customerCode).trim().slice(0, 40) : null,
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
  return {
    id: p.id,
    code: p.code || null,
    name: p.fullName || p.name || null,
    price: productPrice(p),
    unit: p.unit || null,
  };
}

/**
 * Search the live product list by code or name. "heo trắng" uses aliasFor
 * so a catalog SKU wins when the farm has mapped that name.
 */
async function searchProducts(query, limit = 12) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const cache = await loadProducts();
  const alias = aliasFor(q);
  const want = Math.min(30, Math.max(1, Number(limit) || 12));
  const hits = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    hits.push(publicProduct(p));
  };
  if (alias && alias.sku && cache.byCode.has(String(alias.sku).toUpperCase())) {
    push(cache.byCode.get(String(alias.sku).toUpperCase()));
  }
  const upper = q.toUpperCase();
  const queryKey = normName(q);
  const aliasKey = alias ? normName(alias.name) : '';
  for (const p of cache.byCode.values()) {
    const code = String(p.code || '').toUpperCase();
    const nameKey = normName(p.fullName || p.name);
    const codeHit = upper.length >= 2 && code.includes(upper);
    const nameHit = queryKey.length >= 2 && nameKey.includes(queryKey);
    const aliasHit = aliasKey.length >= 2 && nameKey.includes(aliasKey);
    if (codeHit || nameHit || aliasHit) push(p);
    if (hits.length >= want) break;
  }
  return hits;
}

/** Admin sales use this branch. KIOTVIET_BRANCH_ID wins; otherwise the farm branch. */
const DEFAULT_SALE_BRANCH_ID = 26947;

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
  kind, branchId, customerId, customerName, phone, address,
  discount, shippingFee, description, details,
}) {
  const ship = moneyAmount(shippingFee);
  const off = moneyAmount(discount);
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
  if (delivery) payload.delivery = delivery;
  return payload;
}

/**
 * Create one invoice or one order from lines the manager already confirmed.
 * Does not run from the chatbot. pushOrder stays order-only.
 *
 * @returns {Promise<{ok:boolean, code?:string, total?:number, documentType?:string,
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
    const branch = saleBranchId();
    const details = [];
    const missing = [];
    for (const item of lines || []) {
      const alias = aliasFor(item.product_name || item.name);
      const sku = item.sku || (alias && alias.sku) || '';
      const p = sku
        ? await findProduct({ sku })
        : await findProduct({ name: item.product_name || item.name || (alias && alias.name) });
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

    const customer = await findOrCreateCustomer({
      name: customerName,
      phone,
      comments: customerComment,
      customerId,
      customerCode,
    });
    if (!customer || !customer.id) {
      return { ok: false, error: 'Không tạo được khách KiotViet theo số điện thoại' };
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

    const payload = salePayload({
      kind,
      branchId: branch,
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
    const created = await call('post', path, { data: payload });
    const code = documentCode(created);
    if (!code) {
      return { ok: false, error: 'KiotViet không trả mã chứng từ. Kiểm tra trên KiotViet trước khi tạo lại.' };
    }
    const charged = documentTotal(created, total);
    console.log('🧾 KiotViet', kind, 'created:', code);
    return {
      ok: true,
      code,
      total: charged,
      documentType: kind,
      branchId: branch,
      customerId: customer.id,
      customerCode: customer.code || customerCode || null,
      customerName: customer.name || customerName || null,
    };
  } catch (e) {
    console.error('KiotViet createSaleDocument failed:', e.message);
    return { ok: false, error: e.message };
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
  searchProducts, aliasFor, saleBranchId, salePayload, createSaleDocument,
  listProductsForMatch, findCustomerByPhone, findOrCreateCustomer, DEFAULT_SALE_BRANCH_ID,
};
