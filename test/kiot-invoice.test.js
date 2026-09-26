/**
 * Invoice image, VietQR payload, create HĐ / ĐH → xuất hoá đơn,
 * send only on Duyệt & Gửi, and payment sync. KiotViet, Zalo, and
 * Messenger are mocked. Nothing is created on the real retailer.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiot-invoice-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
delete process.env.PUBLIC_URL;
delete process.env.RAILWAY_PUBLIC_DOMAIN;
delete process.env.INVOICE_LINK_SECRET;
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'nongsansachdn';
delete process.env.MESSENGER_ENABLED;
delete process.env.FB_PAGE_ACCESS_TOKEN;
delete process.env.KIOTVIET_BRANCH_ID;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const drafts = require('../services/drafts');
const audit = require('../services/audit');
const kiotviet = require('../services/kiotviet');
const invoices = require('../services/invoices');
const invoiceImage = require('../services/invoiceImage');
const emvco = require('../services/emvco');
const hitlAdmin = require('../services/hitlAdmin');
const messenger = require('../services/messenger');
const zaloService = require('../services/zaloService');

const real = {
  enabled: kiotviet.enabled,
  findProduct: kiotviet.findProduct,
  getOnHand: kiotviet.getOnHand,
  createSaleDocument: kiotviet.createSaleDocument,
  issueInvoiceFromOrder: kiotviet.issueInvoiceFromOrder,
  readInvoicePayment: kiotviet.readInvoicePayment,
  findCustomerByPhone: kiotviet.findCustomerByPhone,
  findOrCreateCustomer: kiotviet.findOrCreateCustomer,
  getCustomer: kiotviet.getCustomer,
  call: kiotviet.call,
  addInvoicePayment: kiotviet.addInvoicePayment,
  listInvoicesByCustomer: kiotviet.listInvoicesByCustomer,
  sendText: messenger.sendText,
  sendImage: messenger.sendImage,
  zaloText: zaloService.sendTextMessage,
  zaloImage: zaloService.sendImageMessage,
};

const CATALOG = [
  { id: 1, code: 'SP-XX', name: 'Xúc xích', price: 85000, basePrice: 85000, unit: 'gói', isActive: true },
];

const sent = { texts: [], images: [], zaloTexts: [], zaloImages: [] };
let createdDocs = [];
let issued = null;
let payment = null;
let paymentPosts = [];

function installMocks() {
  sent.texts = [];
  sent.images = [];
  sent.zaloTexts = [];
  sent.zaloImages = [];
  createdDocs = [];
  issued = null;
  paymentPosts = [];
  payment = { ok: true, amount_paid: 0, payment_status: 'chua_tt', kiot_status: 1 };
  kiotviet.addInvoicePayment = async (input) => {
    paymentPosts.push(input);
    payment = {
      ok: true,
      amount_paid: input.amount,
      payment_status: 'da_tt',
      payment_method: input.method === 'cash' ? 'cash' : 'transfer',
      total: 85000,
      kiot_status: 1,
    };
    return {
      ok: true,
      paymentId: '9001',
      paymentCode: 'PT0001',
      amount: input.amount,
      method: input.method === 'cash' ? 'Cash' : 'Transfer',
    };
  };
  kiotviet.enabled = () => true;
  kiotviet.findProduct = async ({ sku }) => {
    const hit = CATALOG.find(p => p.code === sku);
    return hit ? { ...hit, fullName: hit.name } : null;
  };
  kiotviet.findCustomerByPhone = async () => null;
  kiotviet.listInvoicesByCustomer = async () => [];
  kiotviet.getOnHand = async ({ sku }) => ({
    ok: true, sku, name: sku, available: 20, onHand: 20, reserved: 0, branchId: 26947,
  });
  kiotviet.createSaleDocument = async (input) => {
    createdDocs.push(input);
    const product = CATALOG.find(p => p.code === (input.lines[0] && input.lines[0].sku));
    const qty = Number(input.lines[0] && input.lines[0].quantity) || 1;
    const total = product ? product.price * qty : 0;
    const order = input.documentType === 'order';
    return {
      ok: true,
      id: order ? '55' : '77',
      code: order ? 'DH011700' : 'HD011637',
      total,
      documentType: order ? 'order' : 'invoice',
      branchId: 26947,
      customerId: input.customerId || 9,
      customerCode: input.customerCode || 'KH0009',
      customerName: input.customerName || 'Chị Lan',
    };
  };
  kiotviet.issueInvoiceFromOrder = async (input) => {
    issued = input;
    return {
      ok: true,
      id: '88',
      code: 'HD011638',
      total: 85000,
      documentType: 'invoice',
      orderId: input.orderId,
      orderCode: input.orderCode,
    };
  };
  kiotviet.readInvoicePayment = async () => payment;
  messenger.sendText = async (psid, text) => {
    sent.texts.push({ psid, text });
    return { ok: true };
  };
  messenger.sendImage = async (psid, url) => {
    sent.images.push({ psid, url });
    return sent.imageResult || { ok: true };
  };
  zaloService.sendTextMessage = async (uid, text) => {
    sent.zaloTexts.push({ uid, text });
    return { error: 0 };
  };
  zaloService.sendImageMessage = async (uid, source) => {
    sent.zaloImages.push({ uid, bytes: source && source.buffer ? source.buffer.length : 0 });
    return sent.zaloImageResult === null ? null : { error: 0 };
  };
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

function authHeaders() {
  return {
    Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

async function seedDraft(extra) {
  return drafts.createDraft({
    channel: 'messenger',
    customer_name: 'Chị Lan',
    customer_phone: '0901234567',
    customer_user_id: 'fb_test_lan',
    customer_query: '1 xuc xich',
    draft_reply: 'Dạ em ghi nhận ạ.',
    approval_status: 'PENDING_REVIEW',
    ...(extra || {}),
  });
}

before(() => installMocks());

after(() => {
  Object.assign(kiotviet, {
    enabled: real.enabled,
    findProduct: real.findProduct,
    getOnHand: real.getOnHand,
    createSaleDocument: real.createSaleDocument,
    issueInvoiceFromOrder: real.issueInvoiceFromOrder,
    readInvoicePayment: real.readInvoicePayment,
    findCustomerByPhone: real.findCustomerByPhone,
    findOrCreateCustomer: real.findOrCreateCustomer,
    getCustomer: real.getCustomer,
    call: real.call,
    addInvoicePayment: real.addInvoicePayment,
    listInvoicesByCustomer: real.listInvoicesByCustomer,
  });
  messenger.sendText = real.sendText;
  messenger.sendImage = real.sendImage;
  zaloService.sendTextMessage = real.zaloText;
  zaloService.sendImageMessage = real.zaloImage;
});

const PUBLIC_APP = 'https://doc-mo-farm-agent-production.up.railway.app';

test('invoice links use this server, not the docmofarm.com storefront', () => {
  const prev = {
    publicUrl: process.env.PUBLIC_URL,
    railway: process.env.RAILWAY_PUBLIC_DOMAIN,
  };
  try {
    delete process.env.PUBLIC_URL;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    assert.ok(invoices.imageUrl('HD011637').startsWith(`${PUBLIC_APP}/hd/HD011637/anh?t=`));
    process.env.RAILWAY_PUBLIC_DOMAIN = 'agent.example.railway.app';
    assert.ok(invoices.pageUrl('HD9').startsWith('https://agent.example.railway.app/hd/HD9?t='));
    process.env.PUBLIC_URL = 'https://inbox.example/';
    assert.ok(invoices.imageUrl('HD9').startsWith('https://inbox.example/hd/HD9/anh?t='));
    assert.equal(invoices.imageUrl('HD9').includes('docmofarm.com'), false);
  } finally {
    if (prev.publicUrl == null) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prev.publicUrl;
    if (prev.railway == null) delete process.env.RAILWAY_PUBLIC_DOMAIN;
    else process.env.RAILWAY_PUBLIC_DOMAIN = prev.railway;
  }
});

test('INVOICE_LINK_SECRET keeps sent links valid after the admin password changes', () => {
  const previousPassword = process.env.ADMIN_PASSWORD;
  try {
    delete process.env.INVOICE_LINK_SECRET;
    const fromPassword = invoices.sign('HD011637');
    assert.equal(invoices.verify('HD011637', fromPassword), true);
    process.env.INVOICE_LINK_SECRET = 'link-secret';
    const fromSecret = invoices.sign('HD011637');
    assert.notEqual(fromSecret, fromPassword);
    process.env.ADMIN_PASSWORD = 'rotated';
    assert.equal(invoices.verify('HD011637', fromSecret), true);
    assert.equal(invoices.verify('HD011637', fromPassword), false);
  } finally {
    delete process.env.INVOICE_LINK_SECRET;
    process.env.ADMIN_PASSWORD = previousPassword;
  }
});

test('CRC-16/CCITT-FALSE matches the EMV test vector and a Vietcombank VietQR', () => {
  assert.equal(emvco.crc16('123456789'), '29B1');
  const payload = emvco.buildPayload({ amount: 100000, addInfo: 'HD011637' });
  assert.equal(
    payload,
    '00020101021238540010A00000072701240006970436011010584375900208QRIBFTTA530370454061000005802VN62120808HD0116376304C4B0'
  );
  assert.equal(emvco.valid(payload), true);
  assert.equal(payload.slice(-4), 'C4B0');
  assert.match(payload, /970436/);
  assert.match(payload, /1058437590/);
  assert.match(payload, /62120808HD011637/);
  assert.equal(emvco.VCB_BIN, '970436');
  assert.equal(emvco.ACCOUNT, '1058437590');
});

test('Kiot errors become short Vietnamese messages', () => {
  assert.match(kiotviet.explainKiotError(new Error('KiotViet 401 get /token: unauthorized')), /token/);
  assert.match(kiotviet.explainKiotError(new Error('KiotViet 400 post /invoices: {"responseStatus":{"message":"Không đủ tồn kho sản phẩm"}}')), /tồn kho/);
  assert.match(kiotviet.explainKiotError(new Error('KiotViet 400 post /invoices: {"message":"purchaseDate invalid"}')), /không nhận đơn/i);
  const paid = kiotviet.paymentFromInvoice({ id: 1, code: 'HD1', total: 100000, totalPayment: 40000, status: 1 });
  assert.equal(paid.payment_status, 'mot_phan');
  assert.equal(paid.amount_paid, 40000);
  const full = kiotviet.paymentFromInvoice({ total: 100000, totalPayment: 100000 });
  assert.equal(full.payment_status, 'da_tt');
});

test('confirm creates an invoice, keeps the draft pending, and does not send', async () => {
  installMocks();
  invoices.resetForTests();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft();
    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        customer_name: 'Chị Lan',
        phone: '0901234567',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        expected_total: 85000,
        actor_name: 'Phước',
      }),
    });
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.created, true);
    assert.equal(body.code, 'HD011637');
    assert.equal(body.draft.approval_status, 'PENDING_REVIEW');
    assert.equal(body.draft.send_via, null);
    assert.match(body.draft.draft_reply, /nội dung CK: HD011637/);
    assert.match(body.draft.draft_reply, /1058 43 7590/);
    assert.ok(body.draft.draft_reply.includes(`${PUBLIC_APP}/hd/HD011637?t=`));
    assert.ok(body.draft.qr_image_url.startsWith(`${PUBLIC_APP}/hd/HD011637/anh?t=`));
    assert.equal(body.draft.qr_image_url.includes('docmofarm.com'), false);
    assert.equal(sent.texts.length, 0);
    assert.equal(sent.images.length, 0);
    const row = await invoices.getByCode('HD011637');
    assert.equal(row.kiot_id, '77');
    assert.equal(row.channel, 'fb');
    assert.equal(row.customer_phone, '0901234567');
    assert.equal(row.customer_code, 'KH0009');
    assert.equal(body.customer_code, 'KH0009');
    assert.equal(row.payment_status, 'chua_tt');
    assert.equal(row.total, 85000);
    assert.equal(row.items[0].name, 'Xúc xích');

    const token = body.draft.qr_image_url.split('t=')[1];
    const png = await fetch(`${base}/hd/HD011637/anh?t=${token}`, { headers: {} });
    assert.equal(png.status, 200);
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.equal(bytes.readUInt32BE(0), 0x89504e47);
    assert.ok(bytes.length > 2000);
    const page = await fetch(`${base}/hd/HD011637?t=${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /HD011637/);
    assert.match(html, /class="id-row"/);
    const idRow = html.slice(html.indexOf('<div class="id-row">'), html.indexOf('</div>'));
    assert.match(idRow, /Chị Lan/);
    assert.match(idRow, /KH0009/);
    assert.match(idRow, /HD011637/);
    assert.ok(idRow.indexOf('Chị Lan') < idRow.indexOf('KH0009'));
    assert.ok(idRow.indexOf('KH0009') < idRow.indexOf('HD011637'));
    assert.equal((html.match(/class="id-row"/g) || []).length, 1);
    const hidden = await fetch(`${base}/hd/HD011637?t=nope`);
    assert.equal(hidden.status, 404);

    const logs = await audit.list({ entity_id: 'HD011637', action: 'invoice.created' });
    assert.equal(logs.logs.length, 1);
  } finally {
    await stop(server);
  }
});

test('Messenger can fetch the invoice image with the token and no admin login', async () => {
  installMocks();
  invoices.resetForTests();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({ customer_user_id: 'fb_public_png' });
    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        phone: '0901234567',
        customer_name: 'Chị Lan',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        actor_name: 'Phước',
      }),
    });
    const body = await created.json();
    const imageUrl = new URL(body.draft.qr_image_url);
    assert.equal(imageUrl.origin, PUBLIC_APP);
    assert.equal(imageUrl.pathname, '/hd/HD011637/anh');
    const token = imageUrl.searchParams.get('t');
    assert.ok(token);
    const open = await fetch(`${base}/hd/HD011637/anh?t=${encodeURIComponent(token)}`);
    assert.equal(open.status, 200);
    assert.match(open.headers.get('content-type') || '', /image\/png/);
    const bytes = Buffer.from(await open.arrayBuffer());
    assert.equal(bytes.readUInt32BE(0), 0x89504e47);
    const bare = await fetch(`${base}/hd/HD011637/anh`);
    assert.equal(bare.status, 404);
    const adminOnly = await fetch(`${base}/admin/api/invoices/HD011637/anh`);
    assert.equal(adminOnly.status, 401);
  } finally {
    await stop(server);
  }
});

test('an order stays pending until Xuất hóa đơn, and still is not sent', async () => {
  installMocks();
  invoices.resetForTests();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({ channel: 'zalo', customer_user_id: 'zalo_lan' });
    const ordered = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'order',
        customer_name: 'Chị Lan',
        phone: '0901234567',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        actor_name: 'Phước',
      }),
    });
    const orderBody = await ordered.json();
    assert.equal(ordered.status, 200);
    assert.equal(orderBody.code, 'DH011700');
    assert.equal(orderBody.draft.approval_status, 'PENDING_REVIEW');
    assert.equal(orderBody.draft.qr_image_url, null);
    assert.equal(sent.zaloTexts.length, 0);
    const orderRow = await invoices.getByCode('DH011700');
    assert.equal(orderRow.document_type, 'order');
    assert.equal(orderRow.channel, 'zalo');
    assert.equal(orderRow.kiot_id, '55');

    const issuedRes = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/invoice`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ actor_name: 'Phước' }),
    });
    assert.equal(issuedRes.status, 200);
    const issuedBody = await issuedRes.json();
    assert.equal(issuedBody.code, 'HD011638');
    assert.equal(issuedBody.document, 'invoice');
    assert.equal(issuedBody.draft.approval_status, 'PENDING_REVIEW');
    assert.match(issuedBody.draft.draft_reply, /nội dung CK: HD011638/);
    assert.match(issuedBody.draft.qr_image_url, /HD011638/);
    assert.equal(issued.orderId, '55');
    assert.equal(issued.orderCode, 'DH011700');
    assert.equal(sent.zaloImages.length, 0);
    const invoiceRow = await invoices.getByCode('HD011638');
    assert.equal(invoiceRow.document_type, 'invoice');
    assert.equal(invoiceRow.order_code, 'DH011700');
    const issuedLogs = await audit.list({ action: 'invoice.issued', entity_id: 'HD011638' });
    assert.equal(issuedLogs.logs.length, 1);

    zaloService.setTokens('oa-test', 'refresh-test');
    const approved = await fetch(`${base}/admin/api/drafts/${draft.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ approval_status: 'APPROVED', send: true, actor_name: 'Phước' }),
    });
    assert.equal(approved.status, 200);
    const sentBody = await approved.json();
    assert.equal(sentBody.send.sent, true);
    assert.equal(sentBody.send.via, 'zalo_oa');
    assert.equal(sentBody.send.error, null);
    assert.equal(sent.zaloImages.length, 1);
    assert.ok(sent.zaloImages[0].bytes > 500);
    assert.equal(sent.zaloTexts.length, 1);
    assert.match(sent.zaloTexts[0].text, /HD011638/);
  } finally {
    await stop(server);
  }
});

test('Duyệt & Gửi is the only send, and a failed image falls back to the signed link', async () => {
  installMocks();
  invoices.resetForTests();
  sent.imageResult = { ok: false, error: 'Facebook từ chối ảnh' };
  process.env.MESSENGER_ENABLED = '1';
  process.env.FB_PAGE_ACCESS_TOKEN = 'test-token';
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft();
    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        phone: '0901234567',
        customer_name: 'Chị Lan',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        actor_name: 'Phước',
      }),
    });
    const made = await created.json();
    assert.equal(sent.texts.length, 0);
    await drafts.updateDraft(draft.id, { draft_reply: 'Tổng 85.000đ. VCB 1058437590.' }, { actorName: 'Phước' });
    const approved = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`.replace('/kiotviet', ''), {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ approval_status: 'APPROVED', send: true, actor_name: 'Phước' }),
    });
    assert.equal(approved.status, 200);
    const sentBody = await approved.json();
    assert.equal(sentBody.draft.approval_status, 'SENT');
    assert.equal(sentBody.send.sent, true);
    assert.match(sentBody.send.error, /chưa gửi được ảnh/);
    assert.equal(sent.images.length, 1);
    assert.ok(sent.images[0].url.startsWith(`${PUBLIC_APP}/hd/HD011637/anh?t=`));
    assert.equal(sent.images[0].url.includes('docmofarm.com'), false);
    assert.ok(sent.texts.some(row => /\/hd\/HD011637\?t=/.test(row.text)));
    const row = await invoices.getByCode('HD011637');
    assert.ok(row.sent_at);
    const logs = await audit.list({ action: 'invoice.sent', entity_id: 'HD011637' });
    assert.equal(logs.logs.length, 1);
    assert.equal(made.code, 'HD011637');
  } finally {
    sent.imageResult = null;
    delete process.env.MESSENGER_ENABLED;
    delete process.env.FB_PAGE_ACCESS_TOKEN;
    await stop(server);
  }
});

test('Hóa đơn list, manual payment, Kiot sync, and CSV', async () => {
  installMocks();
  invoices.resetForTests();
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({ customer_user_id: 'fb_pay' });
    const created = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        phone: '0901234567',
        customer_name: 'Chị Lan',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        actor_name: 'Phước',
      }),
    });
    assert.equal(created.status, 200);

    const listed = await fetch(`${base}/admin/api/invoices?q=0901234567`, { headers: authHeaders() });
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.invoices.length, 1);
    assert.equal(listBody.invoices[0].code, 'HD011637');
    assert.equal(listBody.invoices[0].payment_status, 'chua_tt');

    const marked = await fetch(`${base}/admin/api/invoices/HD011637/paid`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ status: 'da_tt', method: 'transfer' }),
    });
    assert.equal(marked.status, 200);
    const markedBody = await marked.json();
    assert.equal(markedBody.invoice.payment_status, 'da_tt');
    assert.equal(markedBody.invoice.amount_paid, 85000);
    assert.equal(markedBody.invoice.payment_method, 'transfer');
    assert.equal(markedBody.invoice.paid_by, 'manager');
    assert.equal(markedBody.invoice.kiot_payment_id, '9001');
    assert.equal(paymentPosts.length, 1);
    assert.equal(paymentPosts[0].invoiceId, '77');
    assert.equal(paymentPosts[0].amount, 85000);

    payment = { ok: true, amount_paid: 20000, payment_status: 'mot_phan', kiot_status: 1, total: 85000 };
    const partialSync = await fetch(`${base}/admin/api/invoices/HD011637/sync`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(partialSync.status, 200);
    const partialBody = await partialSync.json();
    assert.equal(partialBody.invoice.payment_status, 'mot_phan');
    assert.equal(partialBody.invoice.amount_paid, 20000);

    payment = { ok: true, amount_paid: 85000, payment_status: 'da_tt', kiot_status: 1, total: 85000 };
    const synced = await fetch(`${base}/admin/api/invoices/HD011637/sync`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(synced.status, 200);
    const syncedBody = await synced.json();
    assert.equal(syncedBody.invoice.payment_status, 'da_tt');
    assert.equal(syncedBody.invoice.amount_paid, 85000);
    const payLogs = await audit.list({ action: 'invoice.payment', entity_id: 'HD011637' });
    assert.ok(payLogs.logs.length >= 2);
    assert.equal(payLogs.logs.some(row => row.meta && row.meta.source === 'toggle'), true);

    const csv = await fetch(`${base}/admin/api/invoices.csv?q=HD011637`, { headers: authHeaders() });
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.match(text, /ma_kh/);
    assert.match(text, /HD011637/);
    assert.match(text, /KH0009/);
    assert.match(text, /da_tt/);
    assert.match(text, /Chuyển khoản/);
    assert.match(text, /paid_by/);
    const byCode = await fetch(`${base}/admin/api/invoices?q=KH0009`, { headers: authHeaders() });
    assert.equal(byCode.status, 200);
    const byCodeBody = await byCode.json();
    assert.ok(byCodeBody.invoices.some(row => row.code === 'HD011637' && row.customer_code === 'KH0009'));
    const page = await fetch(`${base}/admin/invoices`, { headers: authHeaders() });
    assert.equal(page.status, 200);
    const adminHtml = await page.text();
    assert.match(adminHtml, /Hóa đơn/);
    assert.match(adminHtml, /mã KH/);
  } finally {
    await stop(server);
  }
});

const LOCKED_VIETQR = '00020101021238540010A00000072701240006970436011010584375900208QRIBFTTA530370454061000005802VN62120808HD0116376304C4B0';

test('invoice PNG draws name, Mã KH and Mã HĐ on one row and leaves the VietQR payload unchanged', async () => {
  assert.equal(emvco.buildPayload({ amount: 100000, addInfo: 'HD011637' }), LOCKED_VIETQR);
  const sample = {
    code: 'HD011637',
    created_at: '2026-09-25T03:00:00.000Z',
    customer_name: 'Chị Lan',
    customer_phone: '0901234567',
    customer_code: 'KH000123',
    items: [{ name: 'Xúc xích heo', quantity: 1, price: 265000, amount: 265000 }],
    total: 265000,
    amount_paid: 0,
  };
  const html = invoiceImage.headerHtml(sample);
  const idRow = html.slice(html.indexOf('<div class="id-row">'), html.indexOf('</div>'));
  assert.equal((html.match(/class="id-row"/g) || []).length, 1);
  assert.match(idRow, /<span class="id-name">Chị Lan<\/span>/);
  assert.match(idRow, /title="Mã KH">KH000123</);
  assert.match(idRow, /title="Mã HĐ">HD011637</);
  assert.ok(idRow.indexOf('Chị Lan') < idRow.indexOf('KH000123'));
  assert.ok(idRow.indexOf('KH000123') < idRow.indexOf('HD011637'));
  const due = emvco.buildPayload({ amount: 265000, addInfo: 'HD011637' });
  const png = await invoiceImage.render(sample);
  const slots = invoiceImage.layoutHeader(
    require('pureimage').make(invoiceImage.WIDTH, 10).getContext('2d'),
    sample,
    invoiceImage.WIDTH,
  );
  assert.equal(slots.name.y, slots.kh.y);
  assert.equal(slots.kh.y, slots.hd.y);
  assert.ok(slots.name.x < slots.kh.x && slots.kh.x < slots.hd.x);
  assert.equal(slots.kh.text, 'KH000123');
  assert.equal(slots.hd.text, 'HD011637');
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.ok(png.length > 2000);
  assert.equal(emvco.buildPayload({ amount: 265000, addInfo: 'HD011637' }), due);
  assert.equal(emvco.buildPayload({ amount: 100000, addInfo: 'HD011637' }), LOCKED_VIETQR);
});

test('rendering backfills Mã KH from the Kiot customer', async () => {
  kiotviet.findCustomerByPhone = async (phone) => (
    phone === '0909999888' ? { id: 3, code: 'KH000123', name: 'Mai' } : null
  );
  try {
    await invoices.recordSale({
      code: 'HD099001',
      customerPhone: '0909999888',
      customerName: 'Mai',
      documentType: 'invoice',
      total: 10000,
      items: [{ name: 'Xúc xích', quantity: 1, price: 10000, amount: 10000 }],
    });
    const png = await invoices.pngFor('HD099001');
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    const row = await invoices.getByCode('HD099001');
    assert.equal(row.customer_code, 'KH000123');
    const csv = invoices.toCsv([row]);
    assert.match(csv, /ma_kh/);
    assert.match(csv, /KH000123/);
  } finally {
    kiotviet.findCustomerByPhone = async () => null;
  }
});

test('confirm is blocked when KiotViet returns no Mã KH', async () => {
  const posts = [];
  kiotviet.findOrCreateCustomer = async () => ({ id: 9, name: 'Chị Lan' });
  kiotviet.getCustomer = async () => ({ id: 9, name: 'Chị Lan' });
  kiotviet.call = async (method, path) => {
    posts.push({ method, path });
    throw new Error('should not post');
  };
  kiotviet.createSaleDocument = real.createSaleDocument;
  const before = (await invoices.search({})).map(row => row.code);
  const server = await appServer();
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const draft = await seedDraft({ customer_user_id: 'fb_no_makh' });
    const res = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        customer_name: 'Chị Lan',
        phone: '0907777666',
        lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
        actor_name: 'Phước',
      }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.created, false);
    assert.equal(body.error, kiotviet.MISSING_CUSTOMER_CODE);
    assert.match(body.error, /chọn hoặc tạo khách/i);
    const order = await kiotviet.createSaleDocument({
      documentType: 'order',
      customerName: 'Chị Lan',
      phone: '0907777666',
      lines: [{ sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 }],
    });
    assert.equal(order.ok, false);
    assert.equal(order.error, kiotviet.MISSING_CUSTOMER_CODE);
    assert.equal(posts.length, 0);
    assert.deepEqual((await invoices.search({})).map(row => row.code), before);
    const still = await drafts.getDraft(draft.id);
    assert.equal(still.approval_status, 'PENDING_REVIEW');
    assert.equal(still.invoice_code || null, null);
  } finally {
    kiotviet.call = real.call;
    kiotviet.findOrCreateCustomer = real.findOrCreateCustomer;
    kiotviet.getCustomer = real.getCustomer;
    installMocks();
    await stop(server);
  }
});
