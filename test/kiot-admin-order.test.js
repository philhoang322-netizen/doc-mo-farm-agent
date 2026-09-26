/**
 * Admin KiotViet sale from a HITL draft. KiotViet is mocked.
 * Nothing is created unless confirm is true, and the draft is not sent.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiot-admin-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'nongsansachdn';
delete process.env.KIOTVIET_BRANCH_ID;
process.env.STOCK_LOW_THRESHOLD = '5';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const drafts = require('../services/drafts');
const audit = require('../services/audit');
const kiotviet = require('../services/kiotviet');
const hitlAdmin = require('../services/hitlAdmin');

const real = {
  enabled: kiotviet.enabled,
  findProduct: kiotviet.findProduct,
  getOnHand: kiotviet.getOnHand,
  createSaleDocument: kiotviet.createSaleDocument,
  listProductsForMatch: kiotviet.listProductsForMatch,
  searchProducts: kiotviet.searchProducts,
  findCustomerByPhone: kiotviet.findCustomerByPhone,
};

const CATALOG = [
  { id: 1, code: 'SP-XX', name: 'Xúc xích', price: 85000, basePrice: 85000, unit: 'gói', isActive: true, available: 20 },
  { id: 2, code: 'SP-NN', name: 'Nước nghệ lên men', price: 95000, basePrice: 95000, unit: 'chai', isActive: true, available: 12 },
  { id: 3, code: 'SP-BR', name: 'Ba rọi heo', price: 180000, basePrice: 180000, unit: 'kg', isActive: true, available: 8 },
];

let calls = [];

function installMocks(stock) {
  calls = [];
  kiotviet.enabled = () => true;
  kiotviet.listProductsForMatch = async () => CATALOG.map(p => ({ ...p }));
  kiotviet.searchProducts = async (q) => {
    const n = String(q || '').toLowerCase();
    return CATALOG.filter(p => p.name.toLowerCase().includes(n) || p.code.toLowerCase().includes(n));
  };
  kiotviet.findProduct = async ({ sku }) => {
    const hit = CATALOG.find(p => String(p.code).toUpperCase() === String(sku || '').toUpperCase());
    return hit ? { ...hit, fullName: hit.name } : null;
  };
  kiotviet.getOnHand = async ({ sku }) => {
    const hit = CATALOG.find(p => p.code === sku);
    const available = stock && Object.prototype.hasOwnProperty.call(stock, sku) ? stock[sku] : (hit ? hit.available : 0);
    return {
      ok: true,
      sku,
      name: hit ? hit.name : sku,
      available,
      onHand: available,
      reserved: 0,
      branchId: 26947,
    };
  };
  kiotviet.createSaleDocument = async (input) => {
    calls.push(input);
    const code = input.documentType === 'order' ? 'DH011700' : 'HD011700';
    const sub = (input.lines || []).reduce((sum, line) => {
      const product = CATALOG.find(p => p.code === line.sku);
      return sum + (product ? product.price * Number(line.quantity) : 0);
    }, 0);
    const total = Math.max(0, sub - Number(input.discount || 0) + Number(input.shippingFee || 0));
    return {
      ok: true,
      code,
      total,
      documentType: input.documentType || 'invoice',
      branchId: 26947,
      customerId: input.customerId || null,
      customerCode: input.customerCode || 'KH000123',
      customerName: input.customerName || null,
    };
  };
  kiotviet.findCustomerByPhone = async () => null;
}

function appServer() {
  const app = express();
  app.use(express.json());
  hitlAdmin.mount(app);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stop(server) {
  await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
}

function authHeaders(extra) {
  return {
    Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

async function seedDraft(extra) {
  return drafts.createDraft({
    channel: 'messenger',
    customer_name: 'Chị Lan',
    customer_phone: '0901234567',
    customer_user_id: 'fb_test_lan',
    customer_query: '1 xuc xich, 2 nuoc nghe len men',
    customer_intent: '[sales] đặt 1 xúc xích và 2 nước nghệ',
    draft_reply: 'Dạ em ghi nhận mình lấy xúc xích và nước nghệ ạ.',
    approval_status: 'PENDING_REVIEW',
    review_form: {
      address_detail: '12 Nguyễn Xí',
      ward_name: 'Phường 26',
      district_name: 'Bình Thạnh',
      province_name: 'TP. Hồ Chí Minh',
    },
    ...(extra || {}),
  });
}

before(() => {
  installMocks();
});

after(() => {
  kiotviet.enabled = real.enabled;
  kiotviet.findProduct = real.findProduct;
  kiotviet.getOnHand = real.getOnHand;
  kiotviet.createSaleDocument = real.createSaleDocument;
  kiotviet.listProductsForMatch = real.listProductsForMatch;
  kiotviet.searchProducts = real.searchProducts;
  kiotviet.findCustomerByPhone = real.findCustomerByPhone;
  delete process.env.KIOTVIET_BRANCH_ID;
});

test('sale branch defaults to 26947 and KIOTVIET_BRANCH_ID overrides it', () => {
  delete process.env.KIOTVIET_BRANCH_ID;
  assert.equal(kiotviet.saleBranchId(), 26947);
  process.env.KIOTVIET_BRANCH_ID = '42';
  assert.equal(kiotviet.saleBranchId(), 42);
  delete process.env.KIOTVIET_BRANCH_ID;
});

test('quick entry and create endpoints require admin auth and do not create on their own', async () => {
  installMocks();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft();
    const open = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, lines: [{ sku: 'SP-XX', quantity: 1 }] }),
    });
    assert.equal(open.status, 401);
    assert.equal(calls.length, 0);

    const quick = await fetch(`${base}/admin/api/kiotviet/quick-entry`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: '1 xuc xich, 0.5kg ba roi' }),
    });
    assert.equal(quick.status, 200);
    const filled = await quick.json();
    assert.equal(filled.created, false);
    assert.equal(filled.lines[0].status, 'matched');
    assert.equal(filled.lines[0].sku, 'SP-XX');
    assert.equal(filled.lines[1].sku, 'SP-BR');
    assert.equal(filled.lines[1].quantity, 0.5);
    assert.equal(filled.lines[0].price, 85000);
    assert.ok(filled.lines[0].stock);
    assert.equal(calls.length, 0);

    const preview = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: false,
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
      }),
    });
    assert.equal(preview.status, 200);
    const quoted = await preview.json();
    assert.equal(quoted.created, false);
    assert.equal(quoted.total, 85000);
    assert.equal(calls.length, 0);
  } finally {
    await stop(server);
  }
});

test('confirm creates an invoice, prefills the reply, and does not send it', async () => {
  installMocks();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft();
    const pre = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, { headers: authHeaders() });
    assert.equal(pre.status, 200);
    const prefill = await pre.json();
    assert.match(prefill.quick_text, /xuc xich/i);
    assert.match(prefill.address, /Nguyễn Xí/);

    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        customer_name: 'Chị Lan',
        phone: '0901234567',
        address: '12 Nguyễn Xí',
        discount: 0,
        shipping_fee: 15000,
        lines: [
          { sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 },
          { sku: 'SP-NN', product_name: 'Nước nghệ lên men', quantity: 2 },
        ],
        actor_name: 'Hoàng Công Phước',
        expected_total: 85000 + 95000 * 2 + 15000,
      }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.created, true);
    assert.equal(body.code, 'HD011700');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].documentType, 'invoice');
    assert.equal(body.draft.approval_status, 'PENDING_REVIEW');
    assert.equal(body.draft.send_via, null);
    assert.match(body.draft.draft_reply, /HD011700/);
    assert.match(body.draft.draft_reply, /HTX Nong Trai Doc Mo/);
    assert.match(body.draft.draft_reply, /1058 43 7590/);
    assert.equal(body.draft.invoice_code, 'HD011700');
    assert.equal(body.draft.review_form.kiot_code, 'HD011700');

    const again = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        phone: '0901234567',
        lines: [{ sku: 'SP-XX', quantity: 1, product_name: 'Xúc xích' }],
      }),
    });
    assert.equal(again.status, 409);
    assert.equal(calls.length, 1);

    const logs = await audit.list({ entity_id: draft.id, action: 'kiotviet.created' });
    assert.equal(logs.logs.length, 1);
    assert.equal(logs.logs[0].actor, 'manager:Hoàng Công Phước');
    assert.match(JSON.stringify(logs.logs[0].before), /xúc xích và nước nghệ|ghi nhận/i);
    assert.equal(logs.logs[0].meta.kiot_code, 'HD011700');
  } finally {
    await stop(server);
  }
});

test('confirm stores the new Kiot customer code on the conversation header', async () => {
  installMocks();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({ customer_user_id: 'fb_kiot_code', customer_phone: '0907776666' });
    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        customer_name: 'Chị Lan',
        phone: '0907776666',
        kiot_customer_id: 7,
        kiot_customer_code: 'KH000123',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        expected_total: 85000,
      }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.created, true);
    assert.equal(body.customer_code, 'KH000123');
    assert.equal(calls[0].customerId, 7);
    assert.equal(calls[0].customerCode, 'KH000123');
    assert.equal(body.draft.customer_code, 'KH000123');

    const list = await fetch(`${base}/admin/api/drafts?kenh=farm`, { headers: authHeaders() });
    const rows = await list.json();
    const row = rows.drafts.find(item => item.id === draft.id);
    assert.ok(row);
    assert.equal(row.channel_names[0].text, 'Tên Kiot: Chị Lan · Mã KH: KH000123');
  } finally {
    await stop(server);
  }
});

test('order toggle posts an order and out-of-stock blocks creation', async () => {
  installMocks();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({ channel: 'zalo', customer_user_id: 'zalo_lan_2', customer_query: '1 ba rọi' });
    const ordered = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'order',
        phone: '0901234567',
        customer_name: 'Chị Lan',
        lines: [{ sku: 'SP-BR', product_name: 'Ba rọi heo', quantity: 1 }],
      }),
    });
    assert.equal(ordered.status, 200);
    const orderBody = await ordered.json();
    assert.equal(orderBody.code, 'DH011700');
    assert.equal(calls[0].documentType, 'order');
    assert.equal(orderBody.draft.approval_status, 'PENDING_REVIEW');

    installMocks({ 'SP-XX': 0 });
    const other = await seedDraft({ customer_user_id: 'fb_stock', customer_phone: '0909999999' });
    const blocked = await fetch(`${base}/admin/api/drafts/${other.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        phone: '0909999999',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
      }),
    });
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json();
    assert.match(blockedBody.error, /tồn|hết|không đủ/i);
    assert.equal(calls.length, 0);
  } finally {
    await stop(server);
  }
});

test('a partial or empty address still creates, and preview does not', async () => {
  installMocks();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({
      customer_user_id: 'fb_partial_addr',
      customer_phone: '0900000001',
      customer_name: 'Khách Thử',
      review_form: {
        address_detail: '12 Đường Thử',
        province_name: 'Hồ Chí Minh',
        address_line: '12 Đường Thử, Hồ Chí Minh',
      },
    });
    const preview = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: false,
        phone: '0900000001',
        address: '12 Đường Thử, Hồ Chí Minh',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
      }),
    });
    assert.equal(preview.status, 200);
    const quoted = await preview.json();
    assert.equal(quoted.created, false);
    assert.equal(quoted.can_confirm, true);
    assert.equal(calls.length, 0);

    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        phone: '0900000001',
        customer_name: 'Khách Thử',
        address: '12 Đường Thử, Hồ Chí Minh',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        expected_total: quoted.total,
      }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.created, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].address, '12 Đường Thử, Hồ Chí Minh');

    const bare = await seedDraft({
      customer_user_id: 'fb_no_addr',
      customer_phone: '0900000002',
      customer_name: 'Khách Thử',
      review_form: {},
    });
    const noAddress = await fetch(`${base}/admin/api/drafts/${bare.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        phone: '0900000002',
        customer_name: 'Khách Thử',
        address: '',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        expected_total: 85000,
      }),
    });
    assert.equal(noAddress.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].address, '');
  } finally {
    await stop(server);
  }
});
