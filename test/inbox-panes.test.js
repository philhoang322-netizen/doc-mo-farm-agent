/**
 * Desktop inbox is three panes. Approve stays on the open conversation.
 * Synthetic fixtures only.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-panes-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
delete process.env.ADMIN_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');

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

test('approve updates the open card in place and order state is stored by draft id', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.css'), 'utf8');
  const patch = js.slice(js.indexOf('async function patch'), js.indexOf('function save('));
  const sendStart = js.indexOf('function send()');
  const send = js.slice(sendStart, sendStart + 1200);
  assert.match(js, /dmf_order_pane/);
  assert.match(js, /function paintSent/);
  assert.match(js, /data-open-id/);
  assert.match(patch, /paintSent/);
  assert.doesNotMatch(patch, /await load\(/);
  assert.doesNotMatch(patch, /queueAdvance/);
  assert.doesNotMatch(patch, /ops = next\.ops_status/);
  assert.doesNotMatch(patch, /location\.(href|assign|reload)/);
  assert.doesNotMatch(send, /location\.(href|assign|reload)/);
  assert.match(send, /patch\(payload\(\{ approval_status: 'APPROVED', send: true \}\)/);
  assert.match(css, /100dvh/);
  assert.match(css, /grid-template-columns:\s*300px minmax\(0, 1fr\)/);
  assert.match(css, /grid-template-columns:\s*minmax\(360px, 1fr\) 340px/);
  assert.match(css, /pane-side-toggle/);
  assert.match(js, /class: 'pane-side-toggle'/);
  assert.match(css, /\.pane-mid-scroll[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.detail-side \{[\s\S]*overflow:\s*auto/);
  assert.match(css, /min-width:\s*0/);
  assert.match(css, /@media \(min-width: 768px\)/);
});

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

async function login(page, base) {
  await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="password"]', 'secret');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('button[type="submit"]'),
  ]);
}

function longQuery() {
  return Array.from({ length: 12 }, (_, i) => 'Đặt thử món ' + (i + 1) + ' cho đơn giả lập.').join(' ');
}

async function seedPair() {
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Một',
    customer_phone: '0900000001',
    customer_code: 'KH-DEMO',
    customer_user_id: 'zalo_pane_one',
    customer_query: longQuery(),
    customer_intent: '[sales] đặt hàng',
    draft_reply: 'Dạ em ghi nhận đơn thử.',
    triage_level: 'hot',
    approval_status: 'PENDING_REVIEW',
  });
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Hai',
    customer_phone: '0900000002',
    customer_code: 'KH-DEMO',
    customer_user_id: 'zalo_pane_two',
    customer_query: 'Hỏi thử lịch giao.',
    draft_reply: 'Dạ em kiểm tra giúp.',
    triage_level: 'normal',
    approval_status: 'PENDING_REVIEW',
  });
}

async function openNamed(page, base, name) {
  await page.goto(base + '/admin?pollms=400&nhom=zalo&hop=pending', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.msg-card');
  await page.locator('.msg-card', { hasText: name }).locator('.msg').click();
  await page.waitForSelector('#kiot-note-detail');
  await page.evaluate(() => {
    const extra = document.querySelector('details.extra-detail');
    const fold = document.querySelector('details.kiot-fold');
    if (fold) fold.open = true;
    if (extra) extra.open = true;
  });
}

test('three panes scroll apart and Duyệt & Gửi keeps the order form', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await seedPair();
  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const navs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    page.on('dialog', dialog => dialog.accept());
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navs.push(frame.url());
    });
    await login(page, base);
    navs.length = 0;
    await openNamed(page, base, 'Khách Một');
    await page.locator('#kiot-note-detail').fill('ghi chu giu');
    await page.locator('#kiot-address-detail').fill('12 Đường Thử');
    await page.locator('textarea.kiot-quick').fill('2 SP-DEMO');
    const qty = page.locator('.kiot-qty input');
    if (await qty.count()) await qty.fill('3');

    const layout = await page.evaluate(() => {
      const list = document.querySelector('#queue');
      const mid = document.querySelector('.pane-mid');
      const side = document.querySelector('.pane-side');
      const midScroll = document.querySelector('.pane-mid-scroll');
      const boxes = [list, mid, side].map(node => {
        const b = node.getBoundingClientRect();
        return { x: b.x, w: b.width, h: b.height, r: b.right };
      });
      const overlap = (a, b) => a.x < b.r - 1 && b.x < a.r - 1;
      midScroll.scrollTop = 40;
      side.scrollTop = 80;
      return {
        width: document.documentElement.clientWidth,
        boxes,
        listOverlapMid: overlap(boxes[0], boxes[1]),
        midOverlapSide: overlap(boxes[1], boxes[2]),
        sideOverflow: getComputedStyle(side).overflowY,
        midOverflow: getComputedStyle(midScroll).overflowY,
        listOverflow: getComputedStyle(document.querySelector('.list-scroll')).overflowY,
        midTop: midScroll.scrollTop,
        sideTop: side.scrollTop,
        chipRows: new Set([...document.querySelectorAll('.pane-mid .detail-quick button')].map(btn => Math.round(btn.getBoundingClientRect().top))).size,
      };
    });
    assert.equal(layout.width, 1024);
    assert.equal(layout.listOverlapMid, false);
    assert.equal(layout.midOverlapSide, false);
    assert.equal(layout.sideOverflow, 'auto');
    assert.equal(layout.midOverflow, 'auto');
    assert.equal(layout.listOverflow, 'auto');
    assert.ok(layout.boxes[0].w >= 290 && layout.boxes[0].w <= 310, 'list width ' + layout.boxes[0].w);
    assert.ok(layout.boxes[1].w >= 360, 'middle width ' + layout.boxes[1].w);
    assert.ok(layout.boxes[2].w >= 330 && layout.boxes[2].w <= 350, 'side width ' + layout.boxes[2].w);
    assert.ok(layout.boxes.every(box => box.h > 200), 'pane heights');
    assert.ok(layout.chipRows >= 1 && layout.chipRows <= 2, 'chip rows ' + layout.chipRows);

    await page.evaluate(() => {
      document.querySelector('.pane-side').scrollTop = 120;
    });
    const afterSide = await page.evaluate(() => ({
      mid: document.querySelector('.pane-mid-scroll').scrollTop,
      side: document.querySelector('.pane-side').scrollTop,
    }));
    assert.equal(afterSide.mid, layout.midTop);
    assert.ok(afterSide.side >= 80);

    await page.locator('.msg-card', { hasText: 'Khách Hai' }).locator('.msg').click();
    await page.waitForFunction(() => {
      const head = document.querySelector('.pane-mid-head');
      return head && head.innerText.includes('Khách Hai');
    });
    const otherNote = await page.evaluate(() => {
      const note = document.getElementById('kiot-note-detail');
      return note ? note.value : '';
    });
    assert.equal(otherNote, '');
    await page.locator('.msg-card', { hasText: 'Khách Một' }).locator('.msg').click();
    await page.waitForFunction(() => {
      const note = document.getElementById('kiot-note-detail');
      return note && note.value === 'ghi chu giu';
    });
    assert.equal(await page.locator('#kiot-address-detail').inputValue(), '12 Đường Thử');
    assert.equal(await page.locator('textarea.kiot-quick').inputValue(), '2 SP-DEMO');

    const noteHandle = await page.evaluateHandle(() => document.getElementById('kiot-note-detail'));
    await drafts.createDraft({
      channel: 'zalo',
      sales_channel: 'farm',
      biz_line: 'sale',
      customer_name: 'Khách Ba',
      customer_phone: '0900000003',
      customer_code: 'KH-DEMO',
      customer_user_id: 'zalo_pane_three',
      customer_query: 'Tin mới trong lúc đang gõ đơn.',
      draft_reply: 'Dạ em xem giúp.',
      triage_level: 'normal',
      approval_status: 'PENDING_REVIEW',
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.msg-card')].some(node => node.innerText.includes('Khách Ba')));
    const afterRefresh = await page.evaluate(node => ({
      same: node && node.isConnected && node === document.getElementById('kiot-note-detail'),
      note: document.getElementById('kiot-note-detail').value,
      street: document.getElementById('kiot-address-detail').value,
      quick: document.querySelector('textarea.kiot-quick').value,
    }), noteHandle);
    assert.equal(afterRefresh.same, true);
    assert.equal(afterRefresh.note, 'ghi chu giu');
    assert.equal(afterRefresh.street, '12 Đường Thử');
    assert.equal(afterRefresh.quick, '2 SP-DEMO');
    await noteHandle.dispose();

    const beforeSend = page.url();
    const navBefore = navs.length;
    const pending = page.waitForResponse(res => res.url().includes('/admin/api/drafts/') && res.request().method() === 'PATCH');
    await page.locator('#btn-approve').click();
    const saved = await pending;
    assert.equal(saved.status(), 200);
    assert.equal(page.url(), beforeSend);
    assert.equal(navs.length, navBefore);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1);
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type), 'navigate');
    assert.equal(await page.locator('#kiot-note-detail').inputValue(), 'ghi chu giu');
    assert.equal(await page.locator('#kiot-address-detail').inputValue(), '12 Đường Thử');
    assert.equal(await page.locator('textarea.kiot-quick').inputValue(), '2 SP-DEMO');
    const stored = await page.evaluate(() => sessionStorage.getItem('dmf_order_pane') || '');
    assert.match(stored, /ghi chu giu/);
    assert.match(stored, /12 Đường Thử/);
  } finally {
    await browser.close();
    server.close();
  }
});

test('tablet keeps the order form in a drawer without reloading', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Máy Tính',
    customer_phone: '0900000008',
    customer_code: 'KH-DEMO',
    customer_user_id: 'zalo_pane_tablet',
    customer_query: 'Đặt thử trên máy tính bảng.',
    customer_intent: '[sales] đặt hàng',
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
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    page.on('dialog', dialog => dialog.accept());
    await login(page, base);
    await page.goto(base + '/admin?pollms=60000&nhom=zalo&hop=pending', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.msg-card');
    await page.locator('.msg-card', { hasText: 'Khách Máy Tính' }).locator('.msg').click();
    await page.waitForSelector('#kiot-note-detail');
    await page.locator('#kiot-note-detail').fill('ghi chu tablet');
    const closed = await page.evaluate(() => {
      const side = document.querySelector('.pane-side').getBoundingClientRect();
      const list = document.getElementById('queue').getBoundingClientRect();
      return { sideX: side.x, width: document.documentElement.clientWidth, listW: list.width };
    });
    assert.equal(closed.width, 800);
    assert.ok(closed.sideX >= closed.width - 2, 'drawer left ' + closed.sideX);
    assert.ok(closed.listW >= 180 && closed.listW <= 280, 'list ' + closed.listW);
    const url = page.url();
    await page.locator('.pane-side-toggle').click();
    const opened = await page.evaluate(() => {
      const side = document.querySelector('.pane-side').getBoundingClientRect();
      const list = document.getElementById('queue').getBoundingClientRect();
      return {
        sideX: side.x,
        sideR: side.right,
        listR: list.right,
        note: document.getElementById('kiot-note-detail').value,
        width: document.documentElement.clientWidth,
      };
    });
    assert.ok(opened.sideX > opened.listR, 'drawer left ' + opened.sideX + ' list right ' + opened.listR);
    assert.ok(opened.sideR <= opened.width + 2, 'drawer right ' + opened.sideR);
    assert.equal(opened.note, 'ghi chu tablet');
    assert.equal(page.url(), url);
    await page.locator('.pane-side-toggle').click();
    assert.equal(await page.locator('#kiot-note-detail').inputValue(), 'ghi chu tablet');
  } finally {
    await browser.close();
    server.close();
  }
});

test('mobile stays one column and approve still does not navigate', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Khách Mobile',
    customer_phone: '0900000009',
    customer_code: 'KH-DEMO',
    customer_user_id: 'zalo_pane_mobile',
    customer_query: 'Đặt thử trên điện thoại.',
    customer_intent: '[sales] đặt hàng',
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await login(page, base);
    await page.goto(base + '/admin?pollms=60000&nhom=zalo&hop=pending', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.msg-card');
    await page.locator('.msg-card', { hasText: 'Khách Mobile' }).locator('.msg').click();
    await page.waitForSelector('#kiot-note-detail');
    const hiddenList = await page.evaluate(() => getComputedStyle(document.getElementById('queue')).display);
    assert.equal(hiddenList, 'none');
    await page.locator('#kiot-note-detail').fill('ghi chu mobile');
    const url = page.url();
    const pending = page.waitForResponse(res => res.url().includes('/admin/api/drafts/') && res.request().method() === 'PATCH');
    await page.locator('#btn-approve').click();
    assert.equal((await pending).status(), 200);
    assert.equal(page.url(), url);
    assert.equal(await page.locator('#kiot-note-detail').inputValue(), 'ghi chu mobile');
  } finally {
    await browser.close();
    server.close();
  }
});
