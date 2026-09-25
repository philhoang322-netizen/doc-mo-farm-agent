/**
 * Static inbox layout contract, plus a 390px browser check when Chrome
 * and playwright-core are available. CI without a browser still runs the
 * file checks and skips the viewport pass.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.ADMIN_PASSWORD = 'secret';
process.env.NODE_ENV = 'test';
process.env.DRAFTS_JSON_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-layout-')), 'drafts.json');
delete process.env.ADMIN_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'admin', 'review.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'admin', 'review.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'admin', 'review.js'), 'utf8');

test('inbox uses dynamic viewport, safe areas, and 16px inputs', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /100dvh/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /body\.hitl input,\s*body\.hitl textarea,\s*body\.hitl select \{\s*font-size:\s*16px/);
  assert.doesNotMatch(css, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
});

test('PR #23 inbox hooks stay in the markup', () => {
  assert.match(html, /id="toast"/);
  assert.match(html, /id="undo-toasts"/);
  assert.match(html, /aria-label="Quay lại danh sách"/);
  assert.match(html, /id="refresh-now"/);
  assert.match(html, /id="hot-chip"/);
  assert.match(html, /id="group-tabs"/);
  assert.match(js, /id = 'btn-approve'/);
  assert.match(js, /class: 'btn btn-primary'/);
  assert.match(js, /class: 'card-actions'/);
  assert.match(js, /class: 'card-reply'/);
  assert.match(js, /class: 'msg-names'/);
  assert.match(js, /class: 'name-row'/);
  assert.match(js, /class: 'msg-time'/);
  assert.match(js, /class: 'reply-error'/);
  assert.match(js, /data-draft-id/);
  assert.match(css, /button\.linkish \{[^}]*min-height:\s*var\(--tap\)/s);
  assert.match(css, /\.msg-card \{[^}]*overflow:\s*visible/);
  assert.match(css, /body\.inbox button\.btn\.back \{\s*display:\s*none/);
});

function loadPlaywright() {
  try { return require('playwright-core'); } catch (_) {}
  try { return require('/tmp/node_modules/playwright-core'); } catch (_) {}
  return null;
}

function chromePath() {
  return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find(candidate => fs.existsSync(candidate)) || '';
}

const playwright = loadPlaywright();
const chrome = chromePath();

test('390px inbox fits, keeps 44px targets, and starts the first card high', {
  skip: !playwright || !chrome,
  timeout: 90000,
}, async () => {
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_name: '8490123456789012',
    customer_user_id: '8490123456789012',
    customer_query: '**Khách:** em muốn đặt hàng 2 chai nước gừng',
    draft_reply: 'Dạ em ghi nhận đơn ạ',
    triage_level: 'hot',
    biz_line: 'sale',
  });
  await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    biz_line: 'sale',
    customer_name: 'Trần Minh',
    customer_user_id: 'fb_100200',
    customer_query: 'Còn thịt gà không?',
    draft_reply: 'Dạ còn ạ',
    triage_level: 'normal',
  });
  for (const name of ['Lê An', 'Phạm Bình', 'Đỗ Chi', 'Vũ Dũng', 'Ngô Em', 'Lý Gia', 'Mai Hà', 'Tô Kha']) {
    await drafts.createDraft({
      channel: 'zalo',
      sales_channel: 'farm',
      customer_name: name,
      customer_user_id: 'z_' + name,
      customer_query: 'Còn hàng không ' + name + '?',
      draft_reply: 'Dạ còn ạ',
      triage_level: 'normal',
      biz_line: 'sale',
    });
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.get('/admin', (req, res, next) => {
    Promise.resolve(hitlAdmin.page(req, res)).catch(next);
  });
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
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="password"]', 'secret');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('button[type="submit"]'),
    ]);
    await page.goto(base + '/admin?pollms=60000&nhom=zalo&hop=pending', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.msg-card');
    const metrics = await page.evaluate(() => {
      const view = document.documentElement.clientWidth;
      const tabs = [...document.querySelectorAll('#group-tabs .queue-tab')].filter(node => !node.hidden);
      const card = document.querySelector('.msg-card');
      const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
      const controls = [...document.querySelectorAll('button, a, summary, input, textarea, select')]
        .filter(visible)
        .map(node => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            id: node.id || '',
            cls: node.className && String(node.className).slice(0, 80),
            h: Math.round(box.height),
            w: Math.round(box.width),
            font: style.fontSize,
          };
        });
      const primary = document.querySelector('.card-actions .btn-primary');
      const primaryStyle = primary ? getComputedStyle(primary) : null;
      const reply = document.querySelector('textarea.card-reply');
      return {
        overflow: document.documentElement.scrollWidth > view + 1,
        scrollWidth: document.documentElement.scrollWidth,
        view,
        cardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
        tabs: tabs.map(node => {
          const box = node.getBoundingClientRect();
          return { text: node.innerText.replace(/\s+/g, ' ').trim(), right: Math.round(box.right), left: Math.round(box.left) };
        }),
        small: controls.filter(item => item.h < 44 || item.w < 44),
        inputFonts: controls.filter(item => item.tag === 'INPUT' || item.tag === 'TEXTAREA' || item.tag === 'SELECT').map(item => item.font),
        primaryBg: primaryStyle && primaryStyle.backgroundColor,
        primaryColor: primaryStyle && primaryStyle.color,
        replyFont: reply ? getComputedStyle(reply).fontSize : '',
        bold: !!document.querySelector('.msg-customer strong'),
        fallback: [...document.querySelectorAll('.msg-card')].map(node => node.innerText).join('\n'),
        rows: [...document.querySelectorAll('.msg-card')].filter(node => {
          const box = node.getBoundingClientRect();
          return box.height > 20 && box.top >= 0 && box.bottom <= window.innerHeight - 40;
        }).length,
        kiotInList: !!document.querySelector('.msg-card details.kiot-fold'),
        replyShown: [...document.querySelectorAll('.msg-card .card-reply')].some(node => getComputedStyle(node).display !== 'none'),
      };
    });
    assert.equal(metrics.overflow, false, 'horizontal overflow ' + metrics.scrollWidth);
    assert.ok(metrics.cardTop != null && metrics.cardTop <= 200, 'first card Y ' + metrics.cardTop);
    assert.equal(metrics.tabs.length, 3);
    metrics.tabs.forEach(tab => {
      assert.ok(tab.left >= -1 && tab.right <= metrics.view + 1, tab.text + ' right=' + tab.right);
    });
    const smallReal = metrics.small.filter(item => !(item.cls.includes('learn-check') && item.h >= 44));
    const fieldTag = item => item.tag === 'INPUT' || item.tag === 'TEXTAREA' || item.tag === 'SELECT';
    assert.deepEqual(smallReal.filter(item => (fieldTag(item) ? item.h < 40 : item.h < 44)), []);
    metrics.inputFonts.forEach(size => assert.ok(parseFloat(size) >= 16, size));
    assert.equal(metrics.replyFont, '16px');
    assert.equal(metrics.primaryBg, 'rgb(15, 90, 53)');
    assert.equal(metrics.primaryColor, 'rgb(255, 255, 255)');
    assert.equal(metrics.bold, true);
    assert.match(metrics.fallback, /Khách chưa có tên/);
    assert.equal(metrics.fallback.includes('8490123456789012'), false);
    assert.ok(metrics.rows >= 5, 'rows on first screen ' + metrics.rows);
    assert.equal(metrics.kiotInList, false);
    assert.equal(metrics.replyShown, false);

    await page.setViewportSize({ width: 402, height: 874 });
    await page.waitForSelector('.msg-card');
    const phone = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.msg-card')].map(node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, h: box.height };
      }).filter(box => box.h > 20);
      const tabs = document.getElementById('group-tabs');
      const tabStyle = getComputedStyle(tabs);
      const tabBox = tabs.getBoundingClientRect();
      const visibleRows = cards.filter(box => box.top >= 0 && box.bottom <= window.innerHeight - 1);
      return {
        cardTop: cards.length ? Math.round(cards[0].top) : null,
        rows: visibleRows.length,
        tabPosition: tabStyle.position,
        tabBottom: Math.round(tabBox.bottom),
        inHeader: tabs.parentElement && tabs.parentElement.id === 'app-bar',
        paddingBottom: getComputedStyle(document.body).paddingBottom,
      };
    });
    assert.equal(phone.inHeader, true);
    assert.notEqual(phone.tabPosition, 'fixed');
    assert.ok(phone.tabBottom < 160, 'channel row bottom ' + phone.tabBottom);
    assert.ok(phone.cardTop != null && phone.cardTop <= 172, 'first card Y ' + phone.cardTop);
    // Each card now has a 44px Xóa tin này / Xóa cả cuộc chat row, so fewer
    // full cards fit under the header than the compact list did.
    assert.ok(phone.rows >= 5, 'visible rows ' + phone.rows + ' first Y ' + phone.cardTop);
  } finally {
    await browser.close();
    server.close();
  }
});
