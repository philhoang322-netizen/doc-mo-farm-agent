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
  assert.match(css, /padding-left:\s*calc\(12px \+ env\(safe-area-inset-left/);
  assert.match(css, /folder-row \{[^}]*flex-wrap:\s*wrap/s);
  assert.doesNotMatch(css, /bar-collapsed \.ver/);
  assert.match(js, /aria-label', 'Nóng '/);
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(header, /id="group-tabs"/);
  assert.match(header, /role="tablist"/);
  const queue = html.slice(html.indexOf('id="queue"'), html.indexOf('id="list"'));
  assert.doesNotMatch(queue, /id="group-tabs"/);
  assert.doesNotMatch(css, /group-scroll \{[^}]*position:\s*fixed/s);
  assert.match(css, /show-detail #group-tabs \{\s*display:\s*none/);
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
  timeout: 120000,
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
      channel: 'messenger',
      sales_channel: 'farm',
      biz_line: 'sale',
      customer_name: 'FB Khách',
      customer_user_id: 'fb_khach',
      customer_query: 'Inbox Facebook',
      draft_reply: 'Dạ em xem ạ.',
      triage_level: 'normal',
    });
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
        const name = document.getElementById('product-name');
        const ver = document.querySelector('#app-version');
        return {
          scroll: h1.scrollWidth,
          client: h1.clientWidth,
          truncated: h1.scrollWidth > h1.clientWidth + 1,
          left: name.getBoundingClientRect().left,
          version: ver ? getComputedStyle(ver).display : 'missing',
          versionText: ver ? ver.textContent.trim() : '',
          search: getComputedStyle(document.getElementById('search-toggle')).display,
          text: h1.innerText.replace(/\s+/g, ' ').trim(),
        };
      });
    }
    async function folderFit() {
      return page.evaluate(() => {
        const folders = [...document.querySelectorAll('#folder-nav .folder')];
        const hot = document.getElementById('hot-list');
        const hotShown = hot && !hot.hidden && getComputedStyle(hot).display !== 'none';
        const hotBox = hotShown ? hot.getBoundingClientRect() : null;
        const nav = document.getElementById('folder-nav');
        const navStyle = getComputedStyle(nav);
        const list = document.querySelector('#queue');
        const listBox = list.getBoundingClientRect();
        const view = document.documentElement.clientWidth;
        const desktop = view >= 1024;
        const boundsLeft = desktop ? listBox.left : 0;
        const boundsRight = desktop ? listBox.right : view;
        const intersects = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5
          && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const boxes = folders.map(btn => {
          const box = btn.getBoundingClientRect();
          let masked = false;
          let clipped = false;
          let node = btn.parentElement;
          while (node && node !== document.documentElement) {
            const style = getComputedStyle(node);
            const mask = (style.maskImage || '') + ' ' + (style.webkitMaskImage || '');
            if (/\b(?:linear|radial|conic)-gradient\b|url\(/.test(mask)) masked = true;
            const ox = style.overflowX;
            const oy = style.overflowY;
            if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip'
              || oy === 'hidden' || oy === 'auto' || oy === 'scroll' || oy === 'clip') {
              const parent = node.getBoundingClientRect();
              if (box.left < parent.left - 1 || box.right > parent.right + 1
                || box.top < parent.top - 1 || box.bottom > parent.bottom + 1) clipped = true;
            }
            node = node.parentElement;
          }
          return {
            text: btn.innerText.replace(/\s+/g, ' ').trim(),
            left: Math.round(box.left),
            right: Math.round(box.right),
            top: Math.round(box.top),
            bottom: Math.round(box.bottom),
            w: Math.round(box.width),
            h: Math.round(box.height),
            masked,
            clipped,
            outside: box.left < boundsLeft - 1 || box.right > boundsRight + 1,
            hotOverlap: hotBox ? intersects(box, hotBox) : false,
          };
        });
        return {
          boxes,
          scroll: nav.scrollWidth > nav.clientWidth + 1,
          mask: ((navStyle.maskImage || '') + ' ' + (navStyle.webkitMaskImage || '')).trim(),
          hotLabel: hot ? hot.getAttribute('aria-label') : '',
          hotHidden: !hotShown,
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

    async function channelBar() {
      return page.evaluate(() => {
        const bar = document.getElementById('group-tabs');
        const style = getComputedStyle(bar);
        const box = bar.getBoundingClientRect();
        const header = document.getElementById('app-bar').getBoundingClientRect();
        const tabs = [...bar.querySelectorAll('[role="tab"]')].map(btn => {
          const b = btn.getBoundingClientRect();
          return {
            text: btn.innerText.replace(/\s+/g, ' ').trim(),
            selected: btn.getAttribute('aria-selected'),
            h: Math.round(b.height),
            top: Math.round(b.top),
            bottom: Math.round(b.bottom),
          };
        });
        return {
          inHeader: bar.parentElement && bar.parentElement.id === 'app-bar',
          inQueue: !!bar.closest('#queue'),
          position: style.position,
          display: style.display,
          role: bar.getAttribute('role'),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          headerBottom: Math.round(header.bottom),
          tabs,
        };
      });
    }

    const folders = {};
    const channels = {};
    for (const width of [390, 402, 440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForSelector('#folder-nav .folder');
      folders['list-' + width] = await folderFit();
      channels['list-' + width] = await channelBar();
    }
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.locator('.msg-card', { hasText: 'Nguyễn Lan' }).locator('.msg').click();
    await page.waitForSelector('#detail .detail-quick');
    folders['detail-1024'] = await folderFit();
    channels['detail-1024'] = await channelBar();
    await page.setViewportSize({ width: 1280, height: 800 });
    folders['detail-1280'] = await folderFit();
    channels['detail-1280'] = await channelBar();
    await page.setViewportSize({ width: 402, height: 874 });
    await page.click('#detail-back');
    await page.waitForSelector('#queue .msg', { state: 'visible' });
    await page.locator('.msg-card', { hasText: 'Trần Bích' }).locator('.msg').click();
    await page.waitForSelector('details.kiot-fold[open] .kiot-panel');
    await page.locator('details.kiot-fold[open] .kiot-panel').scrollIntoViewIfNeeded();
    const kiotBrand = await brandBox();

    for (const [key, box] of Object.entries(brands)) {
      assert.equal(box.truncated, false, key + ' h1 ' + box.scroll + '/' + box.client + ' ' + box.text);
      assert.match(box.text, /omni sale dmf/i);
      assert.ok(box.left >= 12, key + ' brand left ' + box.left);
      assert.notEqual(box.version, 'none', key + ' version hidden');
      assert.match(box.versionText, /1\.0\.0/);
    }
    assert.ok(kiotBrand.left >= 12, 'kiot brand left ' + kiotBrand.left);
    assert.notEqual(kiotBrand.version, 'none', 'kiot version ' + kiotBrand.version);
    assert.match(kiotBrand.versionText, /1\.0\.0/);
    assert.match(kiotBrand.text, /omni sale dmf/i);
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
    for (const [key, fit] of Object.entries(folders)) {
      assert.equal(fit.scroll, false, key + ' folder row scrolls');
      assert.equal(fit.hotHidden, false, key + ' hot chip hidden');
      assert.match(fit.hotLabel, /^Nóng \d+$/);
      assert.doesNotMatch(fit.mask, /gradient/);
      assert.ok(fit.boxes.length >= 6, key + ' folders ' + fit.boxes.length);
      fit.boxes.forEach(box => {
        assert.equal(box.masked, false, key + ' ' + box.text + ' masked');
        assert.equal(box.clipped, false, key + ' ' + box.text + ' clipped');
        assert.equal(box.outside, false, key + ' ' + box.text + ' ' + box.left + '-' + box.right);
        assert.equal(box.hotOverlap, false, key + ' ' + box.text + ' overlaps Nóng');
        assert.ok(box.h >= 44, key + ' ' + box.text + ' h ' + box.h);
      });
    }
    for (const key of ['list-402', 'detail-1280']) {
      const bar = channels[key];
      assert.equal(bar.inHeader, true, key + ' tabs outside header');
      assert.equal(bar.inQueue, false, key + ' tabs still in the list pane');
      assert.notEqual(bar.position, 'fixed', key + ' tabs are a bottom bar');
      assert.equal(bar.role, 'tablist');
      assert.equal(bar.display === 'none', false, key + ' tabs hidden');
      assert.ok(bar.bottom < 220, key + ' tab bottom ' + bar.bottom);
      assert.equal(bar.tabs.length, 3);
      bar.tabs.forEach(tab => {
        assert.equal(tab.h >= 44, true, key + ' ' + tab.text + ' h ' + tab.h);
        assert.match(tab.text, /\d/);
      });
    }
    assert.equal(channels['list-402'].tabs[0].selected, 'true');
    await page.setViewportSize({ width: 402, height: 874 });
    await page.click('#detail-back');
    await page.waitForSelector('#group-tabs [data-nhom="fb-sale"]', { state: 'visible' });
    const listBefore = await page.locator('.msg-card').count();
    await page.click('#group-tabs [data-nhom="fb-sale"]');
    await page.waitForSelector('.msg-card', { hasText: 'FB Khách' });
    const switched = await page.evaluate(() => ({
      selected: document.querySelector('[data-nhom="fb-sale"]').getAttribute('aria-selected'),
      zalo: document.querySelector('[data-nhom="zalo"]').getAttribute('aria-selected'),
      url: location.search,
      names: [...document.querySelectorAll('.msg-card')].map(node => node.innerText).join('\n'),
      tabsFixed: getComputedStyle(document.getElementById('group-tabs')).position,
    }));
    const closedPad = await page.evaluate(() => getComputedStyle(document.body).paddingBottom);
    assert.equal(closedPad, '0px', 'list keeps a bottom-bar gap after closing detail');
    assert.equal(switched.selected, 'true');
    assert.equal(switched.zalo, 'false');
    assert.match(switched.url, /nhom=fb-sale/);
    assert.match(switched.names, /FB Khách/);
    assert.equal(switched.names.includes('Nguyễn Lan'), false);
    assert.notEqual(switched.tabsFixed, 'fixed');
    assert.ok(listBefore >= 1);
    await page.click('#group-tabs [data-nhom="zalo"]');
    await page.waitForSelector('.msg-card', { hasText: 'Nguyễn Lan' });
  } finally {
    await browser.close();
    server.close();
  }
});
