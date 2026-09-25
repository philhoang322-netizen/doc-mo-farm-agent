/**
 * Feature parity with the inbox at 5c99fe6 (main before the phone redesign).
 * A later layout pass must keep these controls and API triggers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'admin', 'review.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'admin', 'review.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'admin', 'review.js'), 'utf8');
const refresh = fs.readFileSync(path.join(root, 'public', 'admin', 'inbox-refresh.js'), 'utf8');

const htmlBits = [
  'id="product-name"',
  'id="app-version"',
  'id="actor-name"',
  'id="users-link"',
  'href="/admin/audit"',
  'href="/admin/users"',
  'href="/admin/roster"',
  'Nhật ký',
  'Người dùng',
  'Ca trực',
  'Đăng xuất',
  'id="storage"',
  'id="health-banner"',
  'id="updated-at"',
  'id="new-indicator"',
  'id="search-toggle"',
  'aria-controls="inbox-search"',
  'id="inbox-search"',
  'id="refresh-now"',
  'id="sync-missed"',
  'Đồng bộ tin bị sót',
  'Làm mới',
  'id="channel-settings-toggle"',
  'Cài đặt kênh',
  'id="channel-panel"',
  'id="channels"',
  'id="add-channel"',
  'id="group-tabs"',
  'data-nhom="zalo"',
  'data-nhom="fb-sale"',
  'data-nhom="fb-dv"',
  'Zalo OA',
  'FB-Sale',
  'FB-DV',
  'id="hot-chip"',
  'id="filter-toggle"',
  'id="filter-panel"',
  'data-triage="hot"',
  'data-triage="urgent"',
  'data-triage="normal"',
  'id="types"',
  'data-type="follower"',
  'data-type="zns"',
  'data-type="broadcast"',
  'id="legacy-ops"',
  'data-ops="sending"',
  'data-ops="queued"',
  'data-ops="failure"',
  'id="zalo-line"',
  'data-zline="sale"',
  'data-zline="dv"',
  'id="folder-nav"',
  'data-folder="pending"',
  'data-folder="sent"',
  'data-folder="bought"',
  'data-folder="hesitant"',
  'data-folder="declined"',
  'data-folder="deleted"',
  'Chờ xử lý',
  'Đã gửi',
  'Đã mua',
  'Do dự',
  'Từ chối',
  'Đã xóa',
  'id="active-filters"',
  'id="list"',
  'id="detail"',
  'id="queue"',
  'id="stats-day"',
  'id="stats-template"',
  'id="create-form"',
  'Thống kê',
  'Tạo tin',
  'Đưa vào chờ xử lý',
  'id="toast"',
  'id="undo-toasts"',
  'inbox-refresh.js',
  'inbox-order.js',
  'kiot-picker.js',
];

const jsBits = [
  "side.appendChild(customerPanel(d))",
  'Hồ sơ khách',
  "text: 'Gắn'",
  "text: 'bỏ'",
  '/admin/api/customers/link',
  '/admin/api/customers/unlink',
  "/customer'",
  'Cho AI học từ câu trả lời này',
  'learn-check',
  "text: 'Duyệt & Gửi'",
  "id = 'btn-approve'",
  'class: \'card-reply\'',
  'class: \'card-actions\'',
  'data-draft-id',
  'class: \'msg-names\'',
  'class: \'name-row\'',
  'class: \'msg-time\'',
  'class: \'msg-sent\'',
  'class: \'reply-error\'',
  "text: 'Xóa'",
  "label: 'Hoàn tác'",
  '/delete',
  '/restore',
  "text: 'Tạo đơn KiotViet'",
  'Xác nhận tạo hoá đơn',
  'Xác nhận tạo đơn đặt hàng',
  "text: 'Kiểm kho và xem lại'",
  "text: 'Điền vào đơn'",
  "text: 'Thêm dòng'",
  '/admin/api/kiotviet/products',
  '/admin/api/kiotviet/quick-entry',
  '/admin/api/kiotviet/customer',
  '/kiotviet',
  'Do dự',
  "'Từ chối'",
  'Đã mua',
  'Trả về Chờ xử lý',
  'Chuyển qua Sale',
  'Chuyển qua DV',
  'Gắn Sale',
  'Gắn DV',
  'class: \'detail-quick\'',
  'statusActions(d)',
  'lineActions(d',
  'Lưu',
  'Từ chối bản nháp',
  'Đưa về chờ xử lý',
  '/admin/api/drafts',
  '/admin/api/channels',
  '/admin/api/stats',
  '/admin/api/inbox/sync',
  '/admin/api/health',
  '/admin/api/session',
  '/folder',
  '/biz-line',
  'me.canSend',
  'me.canDelete',
  'me.canKiot',
  'me.canManageUsers',
  'setInterval',
  'Xóa lọc',
  'Xem tin chờ xử lý',
  'Không tải được hộp thư',
  'Gợi ý: Từ chối',
  'Khách chưa có tên',
  "text: 'Thử lại'",
];

test('inbox keeps every pre-redesign control and API trigger', () => {
  const blob = html + '\n' + js;
  for (const bit of htmlBits) assert.match(html, new RegExp(bit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const bit of jsBits) assert.match(js, new RegExp(bit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(blob, /button\.linkish|class: 'linkish'|className = 'linkish'/);
  const keydown = js.slice(js.indexOf("document.addEventListener('keydown'"));
  assert.match(keydown, /ev\.key === 'j'/);
  assert.match(keydown, /ev\.key === 'Escape'/);
  assert.doesNotMatch(keydown.slice(0, 1200), /\bsend\(|\bapprove\(/);
  assert.match(refresh, /Có /);
  assert.match(refresh, /tin mới/);

  const detail = js.slice(js.indexOf('function renderDetail'), js.indexOf('function blockField'));
  assert.match(detail, /side\.appendChild\(customerPanel\(d\)\)/);
  assert.match(detail, /class: 'detail-quick'/);
  assert.match(detail, /Từ chối bản nháp/);
  assert.match(detail, /Đưa về chờ xử lý/);
  assert.match(detail, /s\.kiotOpen \|\| wantsOrder\(d\)/);
  assert.match(detail, /fold\.open && !fold\.querySelector\('\.kiot-panel'\)\) fold\.appendChild\(kiotPanel\(d\)\)/);
  assert.match(js, /function wantsOrder\(d\)/);
  assert.match(js, /kiotOpen: wantsOrder\(d\)/);
  assert.match(js, /triage_level === 'hot'/);
  assert.doesNotMatch(js, /adoptDraftField\('customer_phone'/);
  assert.doesNotMatch(js, /approveCard/);
  const phoneLine = js.slice(js.indexOf("const phoneInput = kiotInput('SĐT tra KiotViet'"), js.indexOf("const phoneInput = kiotInput('SĐT tra KiotViet'") + 200);
  assert.match(phoneLine, /kiot-phone-/);
  assert.match(js, /SĐT lưu vào tin/);
  assert.match(js, /Tìm: /);
  assert.match(js, /id="hot-list"|getElementById\('hot-list'\)/);
  assert.match(html, /id="hot-list"/);
  assert.match(css, /body\.inbox \.detail-quick \{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /flex-shrink:\s*0/);
  assert.match(css, /show-detail #search-toggle \{\s*display:\s*none/);
  assert.doesNotMatch(phoneLine, /name:\s*'customer_phone'|disabled:\s*true/);
  assert.match(js, /\/admin\/api\/drafts\/' \+ encodeURIComponent\(d\.id\) \+ '\/customer'/);
  assert.match(js, /Cần xem/);
  assert.match(js, /data\.storage !== 'postgres'/);
  assert.match(js, /function setSearch/);
  assert.match(css, /body\.inbox \.msg-card \.tags \{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /max-height:\s*40px/);
  assert.match(css, /tag-prev/);
  assert.match(css, /search-open:not\(\.show-detail\) \.inbox-search/);
  assert.match(css, /health-chip\.bad/);
  assert.match(css, /#app-menu:not\(\[hidden\]\) #storage:not\(\[hidden\]\)/);
});

function loadPlaywright() {
  try { return require('playwright-core'); } catch (_) {}
  try { return require('/tmp/node_modules/playwright-core'); } catch (_) {}
  return null;
}

const playwright = loadPlaywright();
const chrome = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(candidate => fs.existsSync(candidate)) || '';

test('quick-row hit boxes, brand, and search chip fit the phone', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  process.env.DATABASE_URL = '';
  process.env.ADMIN_PASSWORD = 'secret';
  process.env.NODE_ENV = 'test';
  process.env.DRAFTS_JSON_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-parity-')), 'drafts.json');
  delete process.env.ADMIN_API_KEY;
  const express = require('express');
  const drafts = require('../services/drafts');
  const hitlAdmin = require('../services/hitlAdmin');
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_name: 'Nguyễn Lan',
    customer_user_id: 'zalo_lan',
    customer_phone: '0901234567',
    customer_query: 'Còn nước gừng không anh?',
    draft_reply: 'Dạ còn ạ.',
    triage_level: 'normal',
    biz_line: 'sale',
  });
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_name: 'Trần Bích',
    customer_user_id: 'zalo_bich',
    customer_query: 'Em muốn đặt hàng',
    draft_reply: 'Dạ em lên đơn.',
    triage_level: 'hot',
    biz_line: 'sale',
  });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.get('/admin', (req, res, next) => Promise.resolve(hitlAdmin.page(req, res)).catch(next));
  hitlAdmin.mount(app);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="password"]', 'secret');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('button[type="submit"]'),
    ]);
    await page.goto(base + '/admin?pollms=60000&nhom=zalo&hop=pending', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.msg-card');

    async function brandBox() {
      return page.evaluate(() => {
        const h1 = document.querySelector('#app-bar h1');
        const ver = document.querySelector('#app-version');
        return {
          scroll: h1.scrollWidth,
          client: h1.clientWidth,
          truncated: h1.scrollWidth > h1.clientWidth + 1,
          version: ver ? getComputedStyle(ver).display : 'missing',
          search: getComputedStyle(document.getElementById('search-toggle')).display,
          text: h1.innerText.replace(/\s+/g, ' ').trim(),
        };
      });
    }
    async function setAlert(on) {
      await page.evaluate(bad => {
        const toggle = document.getElementById('health-toggle');
        const label = toggle.querySelector('.health-label');
        toggle.classList.toggle('bad', bad);
        if (label) label.textContent = bad ? 'Cần xem' : '';
        toggle.setAttribute('aria-label', bad ? 'Kênh cần xem' : 'Kênh ổn');
      }, on);
    }
    const brands = {};
    for (const width of [390, 402]) {
      await page.setViewportSize({ width, height: 874 });
      await setAlert(false);
      brands['list-' + width] = await brandBox();
      await setAlert(true);
      brands['list-alert-' + width] = await brandBox();
      await page.locator('.msg-card', { hasText: 'Nguyễn Lan' }).locator('.msg').click();
      await page.waitForSelector('#detail .detail-quick');
      brands['detail-' + width] = await brandBox();
      await setAlert(false);
      brands['detail-ok-' + width] = await brandBox();
      await page.click('#detail-back');
      await page.waitForSelector('#queue .msg', { state: 'visible' });
    }

    await page.setViewportSize({ width: 402, height: 874 });
    await setAlert(true);
    await page.locator('.msg-card', { hasText: 'Nguyễn Lan' }).locator('.msg').click();
    await page.waitForSelector('#detail .detail-quick button');
    const quick = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#detail .detail-quick button')];
      const boxes = buttons.map(btn => {
        const box = btn.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(btn);
        const label = range.getBoundingClientRect().width;
        return {
          text: btn.textContent.replace(/\s+/g, ' ').trim(),
          w: box.width,
          h: box.height,
          label,
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          disabled: btn.disabled,
        };
      });
      const overlap = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const x = a.left < b.right - 1 && b.left < a.right - 1;
          const y = a.top < b.bottom - 1 && b.top < a.bottom - 1;
          if (x && y) overlap.push(a.text + ' / ' + b.text);
        }
      }
      const lines = new Set(boxes.map(box => Math.round(box.top / 8))).size;
      return { boxes, overlap, lines, wrap: getComputedStyle(document.querySelector('#detail .detail-quick')).flexWrap };
    });

    await page.click('#detail-back');
    await page.waitForSelector('#search-toggle', { state: 'visible' });
    await page.click('#search-toggle');
    await page.fill('#inbox-search', 'Lan');
    await page.keyboard.press('Escape');
    const searchChip = await page.evaluate(() => {
      const box = document.getElementById('active-filters');
      const toggle = document.getElementById('search-toggle');
      return {
        hidden: box.hidden,
        text: box.innerText.replace(/\s+/g, ' ').trim(),
        active: toggle.classList.contains('is-active'),
        open: document.body.classList.contains('search-open'),
      };
    });
    await page.locator('#active-filters .active-chip', { hasText: 'Tìm:' }).click();
    const cleared = await page.evaluate(() => ({
      value: document.getElementById('inbox-search').value,
      text: document.getElementById('active-filters').innerText,
      active: document.getElementById('search-toggle').classList.contains('is-active'),
    }));

    for (const [key, box] of Object.entries(brands)) {
      assert.equal(box.truncated, false, key + ' h1 ' + box.scroll + '/' + box.client + ' ' + box.text);
      assert.match(box.text, /omni sale dmf/i);
    }
    assert.equal(brands['list-390'].version, 'inline-block');
    assert.equal(brands['list-alert-390'].version, 'inline-block');
    assert.equal(brands['detail-390'].search, 'none');
    assert.equal(brands['detail-402'].search, 'none');
    assert.equal(quick.wrap, 'wrap');
    assert.equal(quick.overlap.length, 0, quick.overlap.join(', '));
    assert.ok(quick.lines <= 3, 'quick lines ' + quick.lines);
    quick.boxes.forEach(box => {
      assert.ok(box.w + 1 >= box.label, box.text + ' hit ' + box.w + ' label ' + box.label);
      assert.ok(box.h >= 44, box.text + ' height ' + box.h);
    });
    assert.equal(searchChip.open, false);
    assert.equal(searchChip.hidden, false);
    assert.match(searchChip.text, /Tìm: Lan/);
    assert.equal(searchChip.active, true);
    assert.equal(cleared.value, '');
    assert.equal(cleared.active, false);
    assert.equal(cleared.text.includes('Tìm:'), false);
  } finally {
    await browser.close();
    server.close();
  }
});
