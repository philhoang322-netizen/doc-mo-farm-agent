/**
 * Invoice preview, then Duyệt, then one tap sends the image.
 * Preview never calls KiotViet create. Synthetic fixtures only.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-preview-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
delete process.env.ADMIN_API_KEY;
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'demo-shop';
delete process.env.MESSENGER_ENABLED;
delete process.env.FB_PAGE_ACCESS_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const QRCode = require('qrcode');

const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');
const kiotviet = require('../services/kiotviet');
const invoiceImage = require('../services/invoiceImage');
const emvco = require('../services/emvco');
const messenger = require('../services/messenger');

const CATALOG = [
  { id: 1, code: 'SP-DEMO', name: 'Sản phẩm thử', price: 10000, basePrice: 10000, unit: 'gói', isActive: true, available: 20, fullName: 'Sản phẩm thử' },
];

const creates = [];
const realMessenger = { sendImage: messenger.sendImage, sendText: messenger.sendText };
let imageSends = [];
let textSends = [];

kiotviet.enabled = () => true;
kiotviet.listProductsForMatch = async () => CATALOG.map(p => ({ ...p }));
kiotviet.searchProducts = async () => CATALOG.map(p => ({ ...p }));
kiotviet.findProduct = async () => ({ ...CATALOG[0] });
kiotviet.getOnHand = async () => ({
  ok: true, sku: 'SP-DEMO', name: 'Sản phẩm thử', available: 20, onHand: 20, reserved: 0, branchId: 1,
});
kiotviet.createSaleDocument = async (input) => {
  creates.push(input);
  const qty = (input.lines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  return {
    ok: true,
    code: 'HD000068',
    total: 10000 * (qty || 1),
    documentType: input.documentType || 'invoice',
    branchId: 1,
    customerId: 1,
    customerCode: input.customerCode || 'KH-DEMO',
    customerName: input.customerName || 'Khách Xem',
  };
};
kiotviet.findCustomerByPhone = async () => null;

function authHeaders() {
  return {
    Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.get('/admin', (req, res, next) => {
    Promise.resolve(hitlAdmin.page(req, res)).catch(next);
  });
  hitlAdmin.mount(app);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function seedDraft(extra) {
  return drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Xem',
    customer_phone: '0900000021',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_preview',
    customer_query: 'Đặt 1 sản phẩm thử',
    customer_intent: '[sales] đặt hàng',
    draft_reply: 'Dạ em ghi nhận đơn thử.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
    ...(extra || {}),
  });
}

function installSend(imageFn, textFn) {
  imageSends = [];
  textSends = [];
  process.env.MESSENGER_ENABLED = '1';
  process.env.FB_PAGE_ACCESS_TOKEN = 'test-token';
  messenger.sendImage = async (psid, url) => {
    imageSends.push({ psid, url });
    return imageFn ? imageFn(psid, url) : { ok: true, message_id: 'img-1' };
  };
  messenger.sendText = async (psid, text) => {
    textSends.push({ psid, text });
    return textFn ? textFn(psid, text) : { ok: true, message_id: 'txt-1' };
  };
}

test('a preview image shows Mã HĐ chờ tạo and a VCB QR that is not a document code', async () => {
  const row = {
    pending: true,
    customer_name: 'Khách Xem',
    customer_code: 'KH-DEMO',
    customer_phone: '0900000021',
    items: [{ name: 'Sản phẩm thử', quantity: 1, price: 10000, amount: 10000 }],
    total: 10000,
    amount_paid: 0,
    created_at: '2026-09-26T06:29:00.000Z',
  };
  const html = invoiceImage.pageHtml(row, '');
  assert.match(html, /Mã HĐ: chờ tạo/);
  assert.match(html, /Khách Xem/);
  assert.match(html, /KH-DEMO/);
  assert.match(html, /Chưa TT/);
  assert.match(html, /nội dung CK: chờ tạo/);
  assert.equal(/HD\d|DH\d/.test(html), false);
  const paid = invoiceImage.pageHtml({ ...row, amount_paid: 10000 }, '');
  assert.match(paid, /Đã TT/);
  const seen = [];
  const orig = QRCode.toBuffer;
  QRCode.toBuffer = async (payload, opts) => {
    seen.push(String(payload));
    return orig.call(QRCode, payload, opts);
  };
  try {
    const png = await invoiceImage.render(row);
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    assert.equal(seen.length, 1);
    assert.equal(emvco.readAddInfo(seen[0]), 'chờ tạo');
    assert.equal(/^(HD|DH)/.test(emvco.readAddInfo(seen[0])), false);
    assert.equal(emvco.valid(seen[0]), true);
    const slots = invoiceImage.layoutHeader(
      require('pureimage').make(invoiceImage.WIDTH, 10).getContext('2d'),
      row,
      invoiceImage.WIDTH,
    );
    assert.equal(slots.hd.text, 'Mã HĐ: chờ tạo');
    assert.equal(slots.kh.text, 'KH-DEMO');
    assert.equal(slots.name.font, '22px NotoBold');
    assert.equal(slots.kh.font, slots.hd.font);
    assert.equal(slots.name.y, slots.kh.y);
    assert.equal(slots.kh.y, slots.hd.y);
  } finally {
    QRCode.toBuffer = orig;
  }
});

test('preview does not create, Duyệt creates once, and Gửi khách hàng sends the real code once', async () => {
  creates.length = 0;
  const server = await appServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const draft = await seedDraft();
  const seen = [];
  const orig = QRCode.toBuffer;
  QRCode.toBuffer = async (payload, opts) => {
    seen.push(String(payload));
    return orig.call(QRCode, payload, opts);
  };
  try {
    const open = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: [{ name: 'Sản phẩm thử', quantity: 1, price: 10000 }] }),
    });
    assert.equal(open.status, 401);
    assert.equal(creates.length, 0);

    const preview = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/preview`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        customer_name: 'Khách Xem',
        customer_code: 'KH-DEMO',
        phone: '0900000021',
        address: '12 Đường Thử, Hồ Chí Minh',
        payment: 'chua_tt',
        lines: [{ name: 'Sản phẩm thử', sku: 'SP-DEMO', quantity: 1, price: 10000 }],
      }),
    });
    assert.equal(preview.status, 200);
    const body = await preview.json();
    assert.equal(body.created, false);
    assert.equal(body.pending, true);
    assert.equal(body.code_label, 'Mã HĐ: chờ tạo');
    assert.equal(body.payment_label, 'Chưa TT');
    assert.equal(body.code, undefined);
    assert.match(body.image, /^data:image\/png;base64,/);
    assert.equal(creates.length, 0);
    assert.equal(emvco.readAddInfo(seen[seen.length - 1]), 'chờ tạo');

    const again = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/preview`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        customer_name: 'Khách Xem',
        customer_code: 'KH-DEMO',
        payment: 'da_tt',
        lines: [{ name: 'Sản phẩm thử', sku: 'SP-DEMO', quantity: 2, price: 10000 }],
      }),
    });
    const againBody = await again.json();
    assert.equal(againBody.created, false);
    assert.equal(againBody.payment_label, 'Đã TT');
    assert.equal(creates.length, 0);

    const approved = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirm: true,
        document: 'invoice',
        customer_name: 'Khách Xem',
        phone: '0900000021',
        lines: [{ sku: 'SP-DEMO', product_name: 'Sản phẩm thử', quantity: 1 }],
        actor_name: 'Phước',
      }),
    });
    assert.equal(approved.status, 200);
    const made = await approved.json();
    assert.equal(made.created, true);
    assert.equal(made.code, 'HD000068');
    assert.equal(creates.length, 1);
    assert.match(made.draft.qr_image_url, /HD000068/);
    assert.match(made.draft.review_form.invoice_page_url, /HD000068/);

    installSend(() => ({ ok: false, error: 'This message is sent outside of allowed window' }));
    const blocked = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    assert.equal(blocked.status, 200);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.ok, false);
    assert.equal(blockedBody.sent, false);
    assert.match(blockedBody.error, /outside of allowed window/);
    assert.match(blockedBody.image_url, /HD000068/);
    assert.match(blockedBody.page_url, /HD000068/);
    assert.equal(imageSends.length, 1);
    const still = await drafts.getDraft(draft.id);
    assert.equal(still.review_form.invoice_image_sent_at, null);
    assert.equal(still.approval_status, 'PENDING_REVIEW');

    let held;
    const gate = new Promise(resolve => { held = resolve; });
    let started = 0;
    installSend(async () => {
      started += 1;
      await gate;
      return { ok: true, message_id: 'img-1' };
    });
    const first = fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    const second = fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    const wait = Date.now();
    while (started < 1 && Date.now() - wait < 3000) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(started, 1);
    held();
    const [left, right] = await Promise.all([first, second]);
    const leftBody = await left.json();
    const rightBody = await right.json();
    const bodies = [leftBody, rightBody];
    assert.equal(bodies.filter(item => item.sent).length, 1);
    assert.equal(bodies.filter(item => item.already).length, 1);
    assert.equal(imageSends.length, 1);
    assert.match(imageSends[0].url, /HD000068/);
    assert.equal(textSends.length, 1);
    assert.match(textSends[0].text, /HD000068/);
    assert.equal(creates.length, 1);

    const wiped = await fetch(`${base}/admin/api/drafts/${draft.id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ review_form: { address_line: '12 Đường Thử' } }),
    });
    assert.equal(wiped.status, 200);
    const kept = await drafts.getDraft(draft.id);
    assert.ok(kept.review_form.invoice_image_sent_at);
    const third = await fetch(`${base}/admin/api/drafts/${draft.id}/kiotviet/send`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{}',
    });
    const thirdBody = await third.json();
    assert.equal(thirdBody.already, true);
    assert.equal(thirdBody.sent, false);
    assert.equal(imageSends.length, 1);
  } finally {
    QRCode.toBuffer = orig;
    messenger.sendImage = realMessenger.sendImage;
    messenger.sendText = realMessenger.sendText;
    delete process.env.MESSENGER_ENABLED;
    delete process.env.FB_PAGE_ACCESS_TOKEN;
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});

function loadPlaywright() {
  try { return require('playwright-core'); } catch (_) {}
  try { return require('/tmp/node_modules/playwright-core'); } catch (_) {}
  return null;
}

function chromePath() {
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/local/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(candidate => fs.existsSync(candidate)) || '';
}

const playwright = loadPlaywright();
const chrome = chromePath();

test('the order form previews at 390 and shows Gửi khách hàng at 1024', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  creates.length = 0;
  installSend();
  await seedDraft({
    customer_name: 'Khách Ảnh',
    customer_phone: '0900000022',
    customer_user_id: 'fb_demo_preview_ui',
  });
  const server = await appServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="password"]', 'secret');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('button[type="submit"]'),
    ]);
    await page.goto(base + '/admin?pollms=60000&nhom=fb-sale&hop=pending', { waitUntil: 'domcontentloaded' });
    await page.locator('.msg-card', { hasText: 'Khách Ảnh' }).locator('.msg').click();
    await page.waitForSelector('#kiot-preview-detail');
    await page.locator('#kiot-phone-detail').fill('0900000022');
    await page.locator('.kiot-line input[type="search"]').fill('thử');
    await page.waitForSelector('.kiot-line .kiot-hit');
    await page.locator('.kiot-line .kiot-hit').first().click();
    await page.locator('#kiot-preview-detail').click();
    await page.waitForFunction(() => {
      const img = document.querySelector('.kiot-preview img');
      const note = document.querySelector('.kiot-preview-note');
      return img && img.complete && img.naturalWidth > 0 && note && /Mã HĐ: chờ tạo/.test(note.textContent);
    });
    assert.equal(creates.length, 0);
    const note = await page.locator('.kiot-preview-note').innerText();
    assert.match(note, /Mã HĐ: chờ tạo/);
    assert.match(note, /Chưa TT/);
    assert.equal(/HD\d|DH\d/.test(note), false);
    await page.locator('.kiot-preview').screenshot({ path: '/opt/cursor/artifacts/preview-390.png' });

    await page.locator('.kiot-preview button', { hasText: 'Sửa' }).click();
    await page.waitForSelector('.kiot-preview', { state: 'hidden' });
    await page.locator('.kiot-qty input').fill('2');
    await page.locator('#kiot-pay-row, .kiot-pay').locator('button', { hasText: 'Đã TT' }).click();
    await page.locator('#kiot-preview-detail').click();
    await page.waitForFunction(() => {
      const note = document.querySelector('.kiot-preview-note');
      return note && /Đã TT/.test(note.textContent) && /Mã HĐ: chờ tạo/.test(note.textContent);
    });
    assert.equal(creates.length, 0);

    await page.locator('#kiot-approve-detail').click();
    await page.waitForSelector('#kiot-send-detail');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].documentType, 'invoice');
    const locked = await page.evaluate(() => ({
      name: document.getElementById('kiot-name-detail').disabled,
      qty: document.querySelector('.kiot-qty input').disabled,
      note: document.querySelector('.kiot-lock-note').textContent,
      send: document.getElementById('kiot-send-detail').textContent,
      code: document.querySelector('.kiot-created .id-code[title="Mã HĐ"]').textContent,
    }));
    assert.equal(locked.name, true);
    assert.equal(locked.qty, true);
    assert.match(locked.note, /KiotViet/);
    assert.equal(locked.send, 'Gửi khách hàng');
    assert.equal(locked.code, 'HD000068');
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.locator('.kiot-created').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const img = document.querySelector('.kiot-created img');
      return img && img.complete && img.naturalWidth > 0;
    });
    await page.locator('.kiot-created').screenshot({ path: '/opt/cursor/artifacts/final-send-1024.png' });

    await page.locator('#kiot-send-detail').click();
    await page.waitForFunction(() => document.getElementById('kiot-send-detail').textContent === 'Đã gửi');
    await page.evaluate(() => {
      const btn = document.getElementById('kiot-send-detail');
      btn.click();
    });
    assert.equal(imageSends.length, 1);
    assert.match(imageSends[0].url, /HD000068/);
    assert.equal(textSends.length, 1);
    assert.match(textSends[0].text, /HD000068/);
    assert.equal(creates.length, 1);
    const sent = await page.locator('#kiot-send-detail').isDisabled();
    assert.equal(sent, true);
  } finally {
    messenger.sendImage = realMessenger.sendImage;
    messenger.sendText = realMessenger.sendText;
    delete process.env.MESSENGER_ENABLED;
    delete process.env.FB_PAGE_ACCESS_TOKEN;
    await browser.close();
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
