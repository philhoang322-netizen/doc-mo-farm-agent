/**
 * Partial Viettel Post address on the inbox order form.
 * Synthetic fixtures only. Confirm stays enabled; every part stays editable.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtp-form-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
delete process.env.ADMIN_API_KEY;
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'demo-shop';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');
const kiotviet = require('../services/kiotviet');

const CATALOG = [
  { id: 1, code: 'SP-DEMO', name: 'Sản phẩm thử', price: 10000, basePrice: 10000, unit: 'gói', isActive: true, available: 20 },
];

const calls = [];
kiotviet.enabled = () => true;
kiotviet.listProductsForMatch = async () => CATALOG.map(p => ({ ...p }));
kiotviet.searchProducts = async () => CATALOG.map(p => ({ ...p }));
kiotviet.findProduct = async () => ({ ...CATALOG[0], fullName: CATALOG[0].name });
kiotviet.getOnHand = async () => ({
  ok: true, sku: 'SP-DEMO', name: 'Sản phẩm thử', available: 20, onHand: 20, reserved: 0, branchId: 1,
});
kiotviet.createSaleDocument = async (input) => {
  calls.push(input);
  return {
    ok: true,
    code: 'HD-DEMO',
    total: 10000,
    documentType: input.documentType || 'invoice',
    branchId: 1,
    customerId: 1,
    customerCode: 'KH-DEMO',
    customerName: input.customerName || 'Khách Thử',
  };
};
kiotviet.findCustomerByPhone = async () => null;

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

async function appServer() {
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

async function openOrder(page, base, who) {
  await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="password"]', 'secret');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('button[type="submit"]'),
  ]);
  await page.goto(base + '/admin?pollms=60000&nhom=fb-sale&hop=pending', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.msg-card');
  await page.locator('.msg-card', { hasText: who }).locator('.msg').click();
  await page.waitForSelector('#kiot-ward-detail');
  await page.waitForFunction(() => {
    const ward = document.getElementById('kiot-ward-detail');
    return ward && ward.value.indexOf('Không Có') !== -1;
  });
}

test('partial address stays editable and confirm stays enabled', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  calls.length = 0;
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Một',
    customer_phone: '0900000001',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_partial',
    customer_query: 'Đặt 1 sản phẩm thử',
    customer_intent: '[sales] đặt hàng',
    draft_reply: 'Dạ em ghi nhận đơn thử.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
    review_form: {
      address_line: '12 Đường Thử, Phường Không Có, Hồ Chí Minh',
    },
  });

  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await openOrder(page, base, 'Khách Một');
    const state = await page.evaluate(() => {
      const field = (id) => {
        const node = document.getElementById(id);
        const box = node.getBoundingClientRect();
        return {
          value: node.value,
          disabled: node.disabled,
          readOnly: node.readOnly,
          invalid: node.getAttribute('aria-invalid'),
          h: Math.round(box.height),
          w: Math.round(box.width),
        };
      };
      const warn = document.querySelector('.addr-warn');
      return {
        width: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        province: field('kiot-province-detail'),
        district: field('kiot-district-detail'),
        ward: field('kiot-ward-detail'),
        street: field('kiot-address-detail'),
        warn: warn && !warn.hidden ? warn.textContent : '',
      };
    });
    assert.equal(state.width, 390);
    assert.equal(state.overflow, false);
    for (const key of ['province', 'district', 'ward', 'street']) {
      assert.equal(state[key].disabled, false, key);
      assert.equal(state[key].readOnly, false, key);
      assert.ok(state[key].h >= 40, key + ' height');
      assert.ok(state[key].w >= 40, key + ' width');
    }
    assert.equal(state.province.value, 'Hồ Chí Minh');
    assert.equal(state.district.value, '');
    assert.equal(state.district.invalid, 'true');
    assert.equal(state.ward.value, 'Phường Không Có');
    assert.equal(state.ward.invalid, 'true');
    assert.equal(state.street.value, '12 Đường Thử');
    assert.match(state.warn, /Thiếu quận/);
    assert.match(state.warn, /Chưa khớp phường/);
    assert.equal(await page.locator('.addr-ids').count(), 0);
    assert.equal(await page.locator('#kiot-addr-block-detail .addr-line').count(), 0);
    assert.equal(await page.evaluate(() => document.body.innerText.includes('PROVINCE_ID') || document.body.innerText.includes('WARDS_ID')), false);

    await page.locator('#kiot-ward-detail').fill('Phường Khác');
    assert.equal(await page.locator('input[name="ward_name"]').inputValue(), 'Phường Khác');
    assert.equal(await page.locator('#kiot-ward-detail').isDisabled(), false);

    await page.locator('.kiot-line input[type="search"]').fill('thử');
    await page.waitForSelector('.kiot-hit');
    await page.locator('.kiot-hit').first().click();
    assert.equal(calls.length, 0);
    await page.locator('button', { hasText: 'Kiểm kho' }).click();
    await page.waitForFunction(() => {
      const btn = document.getElementById('kiot-create-detail');
      return btn && !btn.disabled && /Tạo đơn KiotViet/.test(btn.textContent);
    });
    assert.equal(calls.length, 0, 'stock check must not create a KiotViet document');

    const pending = page.waitForResponse(res => {
      if (!res.url().includes('/kiotviet') || res.request().method() !== 'POST') return false;
      return (res.request().postData() || '').includes('"confirm":true');
    });
    await page.locator('#kiot-create-detail').click();
    const created = await pending;
    assert.equal(created.status(), 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].address, /12 Đường Thử/);
    assert.match(calls[0].address, /Phường Khác/);
    assert.match(calls[0].address, /Hồ Chí Minh/);
  } finally {
    await browser.close();
    server.close();
  }
});

test('changing a parent resets and re-enables the child fields', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Hai',
    customer_phone: '0900000003',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_parent',
    customer_query: 'Đặt 1 sản phẩm thử',
    customer_intent: '[sales] đặt hàng',
    draft_reply: 'Dạ em ghi nhận đơn thử.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
    review_form: {
      address_line: '12 Đường Thử, Phường Không Có, Hồ Chí Minh',
    },
  });

  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await openOrder(page, base, 'Khách Hai');
    await page.locator('#kiot-district-detail').fill('Quận Thử');
    const afterDistrict = await page.evaluate(() => ({
      district: document.getElementById('kiot-district-detail').value,
      districtDisabled: document.getElementById('kiot-district-detail').disabled,
      ward: document.getElementById('kiot-ward-detail').value,
      wardDisabled: document.getElementById('kiot-ward-detail').disabled,
      districtName: document.querySelector('input[name="district_name"]').value,
    }));
    assert.equal(afterDistrict.district, 'Quận Thử');
    assert.equal(afterDistrict.districtDisabled, false);
    assert.equal(afterDistrict.districtName, 'Quận Thử');
    assert.equal(afterDistrict.ward, '');
    assert.equal(afterDistrict.wardDisabled, false);

    await page.locator('#kiot-province-detail').click();
    await page.locator('#kiot-province-detail').fill('Ha Noi');
    const hit = page.locator('#kiot-province-detail ~ .addr-hits .addr-hit', { hasText: 'Hà Nội' }).first();
    await hit.waitFor({ state: 'visible' });
    await hit.click();
    const afterProvince = await page.evaluate(() => ({
      province: document.getElementById('kiot-province-detail').value,
      district: document.getElementById('kiot-district-detail').value,
      districtDisabled: document.getElementById('kiot-district-detail').disabled,
      ward: document.getElementById('kiot-ward-detail').value,
      wardDisabled: document.getElementById('kiot-ward-detail').disabled,
      streetDisabled: document.getElementById('kiot-address-detail').disabled,
    }));
    assert.match(afterProvince.province, /Hà Nội/);
    assert.equal(afterProvince.district, '');
    assert.equal(afterProvince.ward, '');
    assert.equal(afterProvince.districtDisabled, false);
    assert.equal(afterProvince.wardDisabled, false);
    assert.equal(afterProvince.streetDisabled, false);

    await page.locator('#kiot-district-detail').fill('Quận Mới');
    assert.equal(await page.locator('#kiot-district-detail').isDisabled(), false);
    assert.equal(await page.locator('input[name="district_name"]').inputValue(), 'Quận Mới');
  } finally {
    await browser.close();
    server.close();
  }
});

async function openCard(page, base, who) {
  await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="password"]', 'secret');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('button[type="submit"]'),
  ]);
  await page.goto(base + '/admin?pollms=60000&nhom=fb-sale&hop=pending', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.msg-card');
  await page.locator('.msg-card', { hasText: who }).locator('.msg').click();
  await page.waitForSelector('#vtp-create-detail');
  await page.waitForFunction(() => window.vtpAddress && window.vtpAddress.loaded() && window.vtpOrder);
}

async function stubClipboard(context) {
  await context.addInitScript(() => {
    window.__vtpCopies = [];
    const writeText = (text) => {
      window.__vtpCopies.push(String(text));
      return Promise.resolve();
    };
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText, readText: () => Promise.resolve(window.__vtpCopies[window.__vtpCopies.length - 1] || '') },
      });
    } catch (e) { /* clipboard stays native */ }
  });
}

function buttonBox(page) {
  return page.evaluate(() => {
    const kiot = document.getElementById('kiot-create-detail');
    const vtp = document.getElementById('vtp-create-detail');
    const kb = kiot.getBoundingClientRect();
    const vb = vtp.getBoundingClientRect();
    const actions = document.querySelector('.kiot-actions');
    return {
      width: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      kiotText: kiot.textContent.trim(),
      vtpText: vtp.textContent.trim(),
      kiotDisabled: kiot.disabled,
      vtpDisabled: vtp.disabled,
      sameRow: Math.abs(kb.top - vb.top) < 8,
      kiotH: Math.round(kb.height),
      vtpH: Math.round(vb.height),
      kiotW: Math.round(kb.width),
      vtpW: Math.round(vb.width),
      actionText: actions ? actions.innerText.replace(/\s+/g, ' ').trim() : '',
      districtInvalid: document.getElementById('kiot-district-detail').getAttribute('aria-invalid'),
      copies: window.__vtpCopies ? window.__vtpCopies.slice() : [],
      toast: document.getElementById('toast') && !document.getElementById('toast').hidden
        ? document.getElementById('toast').textContent.trim()
        : '',
    };
  });
}

test('partial address keeps Kiot enabled and VTP highlights without copying', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  calls.length = 0;
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Ba',
    customer_phone: '0900000004',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_buttons',
    customer_query: 'Đặt 1 sản phẩm thử',
    customer_intent: '[sales] đặt hàng',
    draft_reply: 'Dạ em ghi nhận đơn thử.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
    review_form: {
      address_line: '12 Đường Thử, Phường Không Có, Hồ Chí Minh',
    },
  });
  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    await stubClipboard(context);
    const page = await context.newPage();
    await openCard(page, base, 'Khách Ba');
    await page.waitForFunction(() => {
      const ward = document.getElementById('kiot-ward-detail');
      return ward && ward.value.indexOf('Không Có') !== -1;
    });
    await page.locator('.kiot-line input[type="search"]').fill('thử');
    await page.waitForSelector('.kiot-hit');
    await page.locator('.kiot-hit').first().click();
    await page.locator('button', { hasText: 'Kiểm kho' }).click();
    await page.waitForFunction(() => {
      const btn = document.getElementById('kiot-create-detail');
      return btn && !btn.disabled;
    });
    await page.locator('#vtp-create-detail').click();
    await page.locator('.kiot-lead').click();
    const box = await buttonBox(page);
    assert.equal(box.width, 390);
    assert.equal(box.overflow, false);
    assert.equal(box.kiotText, 'Tạo đơn KiotViet');
    assert.equal(box.vtpText, 'Tạo đơn VTP');
    assert.equal(box.kiotDisabled, false);
    assert.equal(box.vtpDisabled, false);
    assert.equal(box.sameRow, true);
    assert.ok(box.kiotH >= 44, 'kiot tap ' + box.kiotH);
    assert.ok(box.vtpH >= 44, 'vtp tap ' + box.vtpH);
    assert.ok(box.kiotW >= 120, 'kiot width ' + box.kiotW);
    assert.ok(box.vtpW >= 100, 'vtp width ' + box.vtpW);
    assert.equal(box.actionText, 'Kiểm kho và xem lại Tạo đơn KiotViet Tạo đơn VTP');
    assert.equal(box.districtInvalid, 'true');
    assert.deepEqual(box.copies, []);
    assert.equal(box.toast, '');
    assert.equal(calls.length, 0);
  } finally {
    await browser.close();
    server.close();
  }
});

test('a complete address copies the VTP order and shows the toast', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  calls.length = 0;
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Bốn',
    customer_phone: '0900000005',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_vtp_copy',
    customer_query: 'Đặt 1 sản phẩm thử',
    customer_intent: '[sales] đặt hàng',
    draft_reply: 'Dạ em ghi nhận đơn thử.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
    review_form: {
      address_detail: '12 Đường Thử',
      province_id: '2',
      province_name: 'Hồ Chí Minh',
      district_id: '51',
      district_name: 'Bình Thạnh',
      ward_id: '884',
      ward_name: 'Phường 26',
      address_line: '12 Đường Thử, Phường 26, Bình Thạnh, Hồ Chí Minh',
    },
  });
  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    await stubClipboard(context);
    const page = await context.newPage();
    await openCard(page, base, 'Khách Bốn');
    await page.waitForFunction(() => {
      const province = document.getElementById('kiot-province-detail');
      const ward = document.getElementById('kiot-ward-detail');
      return province && /Hồ Chí Minh/.test(province.value) && ward && /Phường 26/.test(ward.value);
    });
    await page.locator('#kiot-note-detail').fill('giao thử');
    await page.locator('.kiot-line input[type="search"]').fill('thử');
    await page.waitForSelector('.kiot-hit');
    await page.locator('.kiot-hit').first().click();
    await page.locator('#vtp-create-detail').click();
    await page.waitForFunction(() => {
      const toast = document.getElementById('toast');
      return toast && !toast.hidden && /Đã chép đơn VTP/.test(toast.textContent);
    });
    const copied = await page.evaluate(() => (window.__vtpCopies || [])[0] || '');
    assert.match(copied, /Người nhận: Khách Bốn/);
    assert.match(copied, /SĐT: 0900000005/);
    assert.match(copied, /Địa chỉ: 12 Đường Thử, Phường 26, Quận Bình Thạnh, Hồ Chí Minh/);
    assert.match(copied, /Hàng: Sản phẩm thử × 1/);
    assert.match(copied, /COD: 10000/);
    assert.match(copied, /Ghi chú: giao thử/);
    assert.equal(calls.length, 0, 'VTP copy must not create a KiotViet document');
    const toast = await page.locator('#toast').innerText();
    assert.match(toast, /Đã chép đơn VTP/);
  } finally {
    await browser.close();
    server.close();
  }
});

test('an empty order form prefills Hồ Chí Minh and keeps a parsed province', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Trống',
    customer_phone: '0900000016',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_default_province',
    customer_query: '',
    customer_intent: '',
    draft_reply: 'Dạ em ghi nhận.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
  });
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Hà Nội',
    customer_phone: '0900000017',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_hanoi',
    customer_query: '12 Đường Thử, Hà Nội',
    customer_intent: '',
    draft_reply: 'Dạ em ghi nhận.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
  });
  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    page.on('dialog', dialog => dialog.accept());
    await openCard(page, base, 'Khách Trống');
    await page.waitForFunction(() => {
      const province = document.getElementById('kiot-province-detail');
      return province && province.value === 'Hồ Chí Minh';
    });
    const blank = await page.evaluate(() => {
      const province = document.getElementById('kiot-province-detail');
      const warn = document.querySelector('#kiot-addr-block-detail .addr-warn');
      return {
        province: province.value,
        id: document.querySelector('#kiot-addr-block-detail input[name="province_id"]').value,
        disabled: province.disabled,
        readOnly: province.readOnly,
        warn: warn && !warn.hidden ? warn.textContent : '',
        create: document.getElementById('kiot-create-detail').textContent,
      };
    });
    assert.equal(blank.province, 'Hồ Chí Minh');
    assert.equal(blank.id, '2');
    assert.equal(blank.disabled, false);
    assert.equal(blank.readOnly, false);
    assert.match(blank.warn, /quận/);
    assert.match(blank.warn, /phường/);
    assert.equal(/tỉnh/.test(blank.warn), false);
    assert.match(blank.create, /Tạo đơn KiotViet/);
    await page.evaluate(() => {
      const input = document.getElementById('kiot-district-detail');
      input.blur();
      input.focus();
    });
    await page.waitForSelector('#kiot-district-detail ~ .addr-hits .addr-hit', { state: 'visible' });
    const districts = await page.locator('#kiot-district-detail ~ .addr-hits .addr-hit').allTextContents();
    assert.ok(districts.includes('Quận 6'), districts.join('|'));
    assert.ok(districts.includes('Quận 5'), districts.join('|'));
    assert.equal(districts.some(text => /Hoàng Mai|Ba Đình/.test(text)), false);

    await page.locator('#kiot-province-detail').fill('Dong Nai');
    await page.locator('#kiot-province-detail ~ .addr-hits .addr-hit', { hasText: 'Đồng Nai' }).first().click();
    await page.waitForFunction(() => document.getElementById('kiot-province-detail').value === 'Đồng Nai');
    const stored = await page.evaluate(() => sessionStorage.getItem('dmf_order_pane') || localStorage.getItem('dmf_order_pane') || '');
    assert.match(stored, /Đồng Nai/);

    await page.locator('.msg-card', { hasText: 'Khách Hà Nội' }).locator('.msg').click();
    await page.waitForFunction(() => {
      const province = document.getElementById('kiot-province-detail');
      return province && province.value === 'Hà Nội';
    });
    const parsed = await page.evaluate(() => ({
      province: document.getElementById('kiot-province-detail').value,
      id: document.querySelector('#kiot-addr-block-detail input[name="province_id"]').value,
      street: document.getElementById('kiot-address-detail').value,
    }));
    assert.equal(parsed.province, 'Hà Nội');
    assert.equal(parsed.id, '1');
    assert.match(parsed.street, /12 Đường Thử/);

    await page.locator('.msg-card', { hasText: 'Khách Trống' }).locator('.msg').click();
    await page.waitForFunction(() => {
      const province = document.getElementById('kiot-province-detail');
      return province && province.value === 'Đồng Nai';
    });
  } finally {
    await browser.close();
    server.close();
  }
});

async function loginInbox(page, base) {
  await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="password"]', 'secret');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('button[type="submit"]'),
  ]);
  await page.goto(base + '/admin?pollms=60000&nhom=fb-sale&hop=pending', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.msg-card');
}

function holdCatalog(page) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return page.route('**/vtp-units.json', async route => {
    await gate;
    await route.continue();
  }).then(() => release);
}

test('a late catalog still prefills Hồ Chí Minh and keeps a typed province', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Trễ',
    customer_phone: '0900000018',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_late_catalog',
    customer_query: '',
    customer_intent: '',
    draft_reply: 'Dạ em ghi nhận.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
  });
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Giữ',
    customer_phone: '0900000019',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_keep_province',
    customer_query: '',
    customer_intent: '',
    draft_reply: 'Dạ em ghi nhận.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
  });
  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.on('dialog', dialog => dialog.accept());
    const release = await holdCatalog(page);
    await loginInbox(page, base);
    const src = await page.locator('script[src*="vtp-address.js"]').getAttribute('src');
    assert.match(src, /vtp-address\.js\?v=/);
    const reviewSrc = await page.locator('script[src*="review.js"]').getAttribute('src');
    assert.match(reviewSrc, /review\.js\?v=/);
    await page.locator('.msg-card', { hasText: 'Khách Trễ' }).locator('.msg').click();
    await page.waitForSelector('#kiot-province-detail');
    assert.equal(await page.inputValue('#kiot-province-detail'), '');
    release();
    await page.waitForFunction(() => {
      const province = document.getElementById('kiot-province-detail');
      return province && province.value === 'Hồ Chí Minh';
    });
    const filled = await page.evaluate(() => ({
      province: document.getElementById('kiot-province-detail').value,
      id: document.querySelector('#kiot-addr-block-detail input[name="province_id"]').value,
      disabled: document.getElementById('kiot-province-detail').disabled,
    }));
    assert.equal(filled.province, 'Hồ Chí Minh');
    assert.equal(filled.id, '2');
    assert.equal(filled.disabled, false);

    const kept = await browser.newPage({ viewport: { width: 390, height: 800 } });
    kept.on('dialog', dialog => dialog.accept());
    const releaseKept = await holdCatalog(kept);
    await loginInbox(kept, base);
    await kept.locator('.msg-card', { hasText: 'Khách Giữ' }).locator('.msg').click();
    await kept.waitForSelector('#kiot-province-detail');
    await kept.fill('#kiot-province-detail', 'Hà Nội');
    releaseKept();
    await kept.waitForTimeout(400);
    const typed = await kept.inputValue('#kiot-province-detail');
    assert.equal(typed, 'Hà Nội');
    await kept.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('quick entry suggests a product from the cache and the 1024 header stays intact', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  const prevList = kiotviet.listProductsForMatch;
  kiotviet.listProductsForMatch = async () => ([
    { id: 2, code: 'NN-DEMO', name: 'Nước nghệ thử', price: 20000, unit: 'chai', available: 8, isActive: true },
    { id: 1, code: 'SP-DEMO', name: 'Sản phẩm thử', price: 10000, unit: 'gói', available: 20, isActive: true },
  ]);
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Tên Dài Để Thử Cột Giờ',
    customer_phone: '0900000021',
    customer_code: 'KH-DEMO',
    customer_user_id: 'fb_demo_suggest',
    customer_query: '',
    customer_intent: '',
    draft_reply: 'Dạ em ghi nhận.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
  });
  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const shotDir = '/opt/cursor/artifacts';
  fs.mkdirSync(shotDir, { recursive: true });
  try {
    const phone = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
    phone.on('dialog', dialog => dialog.accept());
    const calls = { catalog: 0, search: 0 };
    phone.on('request', req => {
      const url = req.url();
      if (url.includes('catalog=1')) calls.catalog += 1;
      if (url.includes('/kiotviet/products?q=')) calls.search += 1;
    });
    await loginInbox(phone, base);
    await phone.locator('.msg-card', { hasText: 'Khách Tên Dài' }).locator('.msg').click();
    await phone.waitForSelector('#kiot-province-detail');
    await phone.waitForFunction(() => document.getElementById('kiot-province-detail').value === 'Hồ Chí Minh');
    await phone.fill('.kiot-quick', 'nuoc nghe');
    await phone.waitForSelector('.kiot-suggest .kiot-hit');
    const suggestion = await phone.locator('.kiot-suggest .kiot-hit').first().innerText();
    assert.match(suggestion, /Nước nghệ thử/);
    assert.match(suggestion, /NN-DEMO/);
    assert.match(suggestion, /Còn Kho 8/);
    assert.equal(calls.search, 0);
    assert.ok(calls.catalog >= 1);
    await phone.locator('.kiot-suggest').scrollIntoViewIfNeeded();
    await phone.screenshot({ path: shotDir + '/suggest-390.png' });
    await phone.locator('.kiot-suggest .kiot-hit').first().click();
    await phone.waitForFunction(() => {
      const code = document.querySelector('.kiot-line .kiot-code');
      const qty = document.querySelector('.kiot-qty input');
      return code && code.textContent.includes('NN-DEMO') && qty && qty.value === '1';
    });
    const added = await phone.evaluate(() => ({
      name: document.querySelector('.kiot-line strong').textContent,
      code: document.querySelector('.kiot-line .kiot-code').textContent,
      qty: document.querySelector('.kiot-qty input').value,
      price: document.querySelector('.kiot-unit').textContent,
      stock: document.querySelector('.kiot-stock').textContent,
    }));
    assert.equal(added.name, 'Nước nghệ thử');
    assert.match(added.code, /NN-DEMO/);
    assert.equal(added.qty, '1');
    assert.match(added.price, /20/);
    assert.match(added.stock, /8/);
    await phone.fill('.kiot-quick', 'san pham');
    await phone.getByRole('button', { name: 'Tra sản phẩm' }).click();
    await phone.waitForSelector('.kiot-suggest .kiot-hit');
    const fromButton = await phone.locator('.kiot-suggest .kiot-hit').first().innerText();
    assert.match(fromButton, /Sản phẩm thử/);
    assert.match(fromButton, /SP-DEMO/);
    await phone.close();

    const desk = await browser.newPage({ viewport: { width: 1024, height: 1100 }, deviceScaleFactor: 1 });
    desk.on('dialog', dialog => dialog.accept());
    await loginInbox(desk, base);
    await desk.locator('.msg-card', { hasText: 'Khách Tên Dài' }).locator('.msg').click();
    await desk.waitForFunction(() => document.getElementById('kiot-province-detail').value === 'Hồ Chí Minh');
    await desk.fill('.kiot-quick', 'nuoc nghe');
    await desk.waitForSelector('.kiot-suggest .kiot-hit');
    await desk.evaluate(() => {
      const side = document.querySelector('.pane-side');
      if (side) side.scrollTop = 0;
    });
    await desk.screenshot({ path: shotDir + '/form-hcm-suggest-1024.png' });
    const fit = await desk.evaluate(() => {
      const when = document.querySelector('.pane-mid .id-when');
      const chip = document.querySelector('.msg-card.selected .tag-fb');
      const pane = document.querySelector('.pane-mid');
      const list = document.querySelector('.list');
      function clipped(el) {
        if (!el) return true;
        if (el.scrollWidth > el.clientWidth + 1) return true;
        const a = el.getBoundingClientRect();
        let node = el.parentElement;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          const overflow = style.overflowX + style.overflow;
          if (/hidden|clip|auto|scroll/.test(overflow)) {
            const b = node.getBoundingClientRect();
            if (a.right > b.right + 1 || a.left < b.left - 1) return true;
          }
          node = node.parentElement;
        }
        return false;
      }
      return {
        when: when ? when.textContent : '',
        whenOk: !clipped(when) && !!pane,
        chip: chip ? chip.textContent : '',
        chipOk: !clipped(chip) && !!list,
        province: document.getElementById('kiot-province-detail').value,
      };
    });
    assert.equal(fit.province, 'Hồ Chí Minh');
    assert.match(fit.when, /\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}/);
    assert.equal(fit.whenOk, true, JSON.stringify(fit));
    assert.equal(fit.chip, 'FB / Messenger');
    assert.equal(fit.chipOk, true, JSON.stringify(fit));
    await desk.screenshot({ path: shotDir + '/header-chip-1024.png' });
    await desk.close();
  } finally {
    kiotviet.listProductsForMatch = prevList;
    await browser.close();
    server.close();
  }
});
