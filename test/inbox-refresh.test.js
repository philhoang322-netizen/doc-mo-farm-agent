/**
 * Auto-refresh is a background fetch. An open KiotViet form, a focused
 * input, or a dirty reply must keep every card in place. The check below
 * types into the order form and lets several poll cycles run.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.ADMIN_PASSWORD = 'secret';
process.env.NODE_ENV = 'test';
process.env.DRAFTS_JSON_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-refresh-')), 'drafts.json');
delete process.env.ADMIN_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const policy = require('../public/admin/inbox-refresh');
const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');

test('background refresh freezes an open edit and only inserts when idle', () => {
  assert.equal(policy.listMutation('background', true), 'freeze');
  assert.equal(policy.listMutation('background', false), 'insert');
  assert.equal(policy.listMutation('apply', true), 'insert');
  assert.equal(policy.listMutation('apply', false), 'insert');
  assert.equal(policy.listMutation('replace', false), 'replace');
  assert.equal(policy.editingHold({ kiotOpen: true }), true);
  assert.equal(policy.editingHold({ focusedTag: 'textarea' }), true);
  assert.equal(policy.editingHold({ dirty: true }), true);
  assert.equal(policy.editingHold({ detailOpen: true }), true);
  assert.equal(policy.editingHold({ composerOpen: true }), true);
  assert.equal(policy.editingHold({ channelFormOpen: true }), true);
  assert.equal(policy.editingHold({}), false);
  assert.deepEqual(policy.unseenIds(['a'], [{ id: 'a' }, { id: 'b' }]), ['b']);
  assert.equal(policy.bannerLabel(2), 'Có 2 tin mới — bấm để hiện');
  assert.equal(policy.anchorDelta(120, 260), 140);
});

function loadPuppeteer() {
  try { return require('puppeteer-core'); } catch (_) {}
  try { return require('/tmp/node_modules/puppeteer-core'); } catch (_) {}
  return null;
}

function chromePath() {
  return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find(candidate => fs.existsSync(candidate)) || '';
}

const puppeteer = loadPuppeteer();
const chrome = chromePath();

async function seed(name) {
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_name: name,
    customer_query: 'Xin chào ' + name,
    draft_reply: 'Dạ em nghe ' + name,
    triage_level: 'normal',
  });
  await new Promise(resolve => setTimeout(resolve, 5));
}

test('typing in the order form survives several refresh cycles', { skip: !puppeteer || !chrome, timeout: 60000 }, async () => {
  for (const name of ['Mốc A', 'Mốc B', 'Mốc C', 'Mốc D']) await seed(name);
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
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 900 });
    await page.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    await page.type('input[name="password"]', 'secret');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('button[type="submit"]'),
    ]);
    await page.goto(base + '/admin?pollms=400&nhom=zalo&hop=pending', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card-reply');
    await page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve());

    const scrollToAnchor = () => page.evaluate(() => {
      const card = [...document.querySelectorAll('.msg-card')].find(node => node.innerText.includes('Mốc A'));
      const y = card.getBoundingClientRect().top + window.scrollY - 48;
      window.scrollTo(0, Math.max(0, y));
      return {
        top: card.getBoundingClientRect().top,
        scrollY: window.scrollY,
        count: document.querySelectorAll('.msg-card').length,
      };
    });

    const beforeInsert = await scrollToAnchor();
    assert.equal(beforeInsert.count, 4);
    await seed('Mốc E');
    await page.waitForFunction(() => document.querySelectorAll('.msg-card').length === 5, { timeout: 8000 });
    const afterInsert = await page.evaluate(() => {
      const card = [...document.querySelectorAll('.msg-card')].find(node => node.innerText.includes('Mốc A'));
      return {
        top: card.getBoundingClientRect().top,
        hasNew: [...document.querySelectorAll('.msg-card')].some(node => node.innerText.includes('Mốc E')),
      };
    });
    assert.equal(afterInsert.hasNew, true);
    assert.ok(Math.abs(afterInsert.top - beforeInsert.top) < 3, 'idle insert moved the card at the top of the screen');

    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.msg-card')].find(node => node.innerText.includes('Mốc A'));
      card.querySelector('details.kiot-fold summary').click();
    });
    await page.waitForSelector('details.kiot-fold[open] [id^="kiot-name-"]');
    async function replaceField(selector, text) {
      await page.click(selector);
      await page.evaluate(sel => {
        const input = document.querySelector(sel);
        input.focus();
        input.select();
      }, selector);
      await page.keyboard.type(text);
    }
    await replaceField('details.kiot-fold[open] [id^="kiot-name-"]', 'Chị Hoa giữ');
    await replaceField('details.kiot-fold[open] [id^="kiot-phone-"]', '0909888777');
    await replaceField('details.kiot-fold[open] [id^="kiot-address-"]', '12 Nguyễn Xí');
    await replaceField('details.kiot-fold[open] [id^="kiot-note-"]', 'giao buổi sáng');
    await page.click('details.kiot-fold[open] textarea.kiot-quick');
    await page.keyboard.type('1 trứng gà');
    await page.evaluate(() => {
      const card = document.querySelector('details.kiot-fold[open]').closest('.msg-card');
      const reply = card.querySelector('.card-reply');
      reply.focus();
    });
    await page.keyboard.type(' GIU');
    await page.evaluate(() => {
      const name = document.querySelector('details.kiot-fold[open] [id^="kiot-name-"]');
      name.dataset.keep = 'yes';
      window.__keepName = name;
    });
    const typed = await page.evaluate(() => {
      const card = document.querySelector('details.kiot-fold[open]').closest('.msg-card');
      card.id = 'anchor-card';
      const top = card.getBoundingClientRect().top;
      window.scrollBy(0, 0);
      return {
        name: document.querySelector('[id^="kiot-name-"]').value,
        phone: document.querySelector('[id^="kiot-phone-"]').value,
        address: document.querySelector('[id^="kiot-address-"]').value,
        note: document.querySelector('[id^="kiot-note-"]').value,
        quick: document.querySelector('textarea.kiot-quick').value,
        reply: card.querySelector('.card-reply').value,
        scrollY: window.scrollY,
        top,
        count: document.querySelectorAll('.msg-card').length,
      };
    });
    assert.equal(typed.name, 'Chị Hoa giữ');
    assert.equal(typed.phone, '0909888777');
    assert.equal(typed.address, '12 Nguyễn Xí');
    assert.equal(typed.note, 'giao buổi sáng');
    assert.equal(typed.quick, '1 trứng gà');
    assert.match(typed.reply, /GIU$/);
    assert.equal(typed.count, 5);

    await seed('Mốc F');
    await seed('Mốc G');
    await page.waitForFunction(() => {
      const banner = document.getElementById('new-indicator');
      return banner && !banner.hidden && banner.textContent === 'Có 2 tin mới — bấm để hiện';
    }, { timeout: 8000 });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const held = await page.evaluate(() => {
      const card = document.getElementById('anchor-card');
      const name = document.querySelector('details.kiot-fold[open] [id^="kiot-name-"]');
      return {
        name: name.value,
        phone: document.querySelector('[id^="kiot-phone-"]').value,
        address: document.querySelector('[id^="kiot-address-"]').value,
        note: document.querySelector('[id^="kiot-note-"]').value,
        quick: document.querySelector('textarea.kiot-quick').value,
        reply: card.querySelector('.card-reply').value,
        sameNode: name === window.__keepName && name.dataset.keep === 'yes',
        scrollY: window.scrollY,
        top: card.getBoundingClientRect().top,
        count: document.querySelectorAll('.msg-card').length,
        nav: performance.getEntriesByType('navigation')[0].type,
        open: !!card.querySelector('details.kiot-fold[open]'),
      };
    });
    assert.equal(held.name, typed.name);
    assert.equal(held.phone, typed.phone);
    assert.equal(held.address, typed.address);
    assert.equal(held.note, typed.note);
    assert.equal(held.quick, typed.quick);
    assert.equal(held.reply, typed.reply);
    assert.equal(held.sameNode, true);
    assert.equal(held.count, typed.count);
    assert.equal(held.open, true);
    assert.equal(held.nav, 'navigate');
    assert.ok(Math.abs(held.scrollY - typed.scrollY) < 2, 'scroll jumped while the order form was open');
    assert.ok(Math.abs(held.top - typed.top) < 3, 'the card on screen moved while the order form was open');

    await page.click('#new-indicator');
    await page.waitForFunction(() => document.querySelectorAll('.msg-card').length === 7, { timeout: 8000 });
    const applied = await page.evaluate(() => {
      const card = document.getElementById('anchor-card');
      const name = card.querySelector('[id^="kiot-name-"]');
      return {
        name: name.value,
        phone: card.querySelector('[id^="kiot-phone-"]').value,
        address: card.querySelector('[id^="kiot-address-"]').value,
        note: card.querySelector('[id^="kiot-note-"]').value,
        quick: card.querySelector('textarea.kiot-quick').value,
        reply: card.querySelector('.card-reply').value,
        sameNode: name === window.__keepName,
        top: card.getBoundingClientRect().top,
        hasF: [...document.querySelectorAll('.msg-card')].some(node => node.innerText.includes('Mốc F')),
        hasG: [...document.querySelectorAll('.msg-card')].some(node => node.innerText.includes('Mốc G')),
      };
    });
    assert.equal(applied.name, typed.name);
    assert.equal(applied.phone, typed.phone);
    assert.equal(applied.address, typed.address);
    assert.equal(applied.note, typed.note);
    assert.equal(applied.quick, typed.quick);
    assert.equal(applied.reply, typed.reply);
    assert.equal(applied.sameNode, true);
    assert.equal(applied.hasF, true);
    assert.equal(applied.hasG, true);
    assert.ok(Math.abs(applied.top - typed.top) < 3, 'showing the new cards moved the open order form');
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
