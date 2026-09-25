/**
 * /admin roles. ADMIN_PASSWORD stays the bootstrap manager. Sale cannot
 * send, delete, refund, or raise a large discount. DV cannot see FB-Sale.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.ADMIN_PASSWORD = 'secret';
process.env.NODE_ENV = 'test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-access-'));
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.ADMIN_USERS_PATH = path.join(dir, 'admin_users.json');
delete process.env.ADMIN_API_KEY;
delete process.env.DISCOUNT_MANAGER_VND;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const drafts = require('../services/drafts');
const users = require('../services/adminUsers');
const trainingLog = require('../services/trainingLog');
const hitlAdmin = require('../services/hitlAdmin');
const audit = require('../services/audit');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  hitlAdmin.mount(app);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function login(base, username, password) {
  const body = new URLSearchParams({ username, password });
  const res = await fetch(base + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const raw = res.headers.get('set-cookie') || '';
  const cookie = raw.split(';')[0];
  assert.match(cookie, /dmf_hitl=/);
  return cookie;
}

test('sale cannot send, delete, or discount past the limit; dv misses FB-Sale', async () => {
  const sale = await users.create({ username: 'lan', password: 'matkhau1', role: 'sale', display_name: 'Lan' });
  const dv = await users.create({ username: 'mai', password: 'matkhau1', role: 'dv', display_name: 'Mai' });
  assert.equal(sale.role, 'sale');
  assert.equal(dv.role, 'dv');
  assert.equal(await users.staffCanSend(), false);

  const zalo = await drafts.createDraft({
    channel: 'zalo',
    customer_name: 'Chị Lan',
    customer_query: 'Còn rau không',
    draft_reply: 'Dạ còn ạ',
  });
  const stay = await drafts.createDraft({
    channel: 'messenger',
    biz_line: 'dv',
    customer_name: 'Cô Mai',
    customer_query: 'Đặt phòng',
    draft_reply: 'Dạ ngày nào ạ',
  });

  const server = await appServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const saleCookie = await login(base, 'lan', 'matkhau1');
    const dvCookie = await login(base, 'mai', 'matkhau1');
    const saleHeaders = { Cookie: saleCookie, 'Content-Type': 'application/json' };
    const dvHeaders = { Cookie: dvCookie, 'Content-Type': 'application/json' };

    const session = await fetch(base + '/admin/api/session', { headers: saleHeaders });
    const me = await session.json();
    assert.equal(me.role, 'sale');
    assert.equal(me.canSend, false);
    assert.equal(me.canDelete, false);

    const saleList = await (await fetch(base + '/admin/api/drafts?kenh=farm', { headers: saleHeaders })).json();
    assert.ok(saleList.drafts.some(d => d.id === zalo.id));
    assert.equal(saleList.drafts.some(d => d.id === stay.id), false);

    const dvList = await (await fetch(base + '/admin/api/drafts?kenh=farm', { headers: dvHeaders })).json();
    assert.equal(dvList.drafts.some(d => d.id === zalo.id), false);
    assert.ok(dvList.drafts.some(d => d.id === stay.id));

    const sent = await fetch(base + '/admin/api/drafts/' + zalo.id, {
      method: 'PATCH',
      headers: saleHeaders,
      body: JSON.stringify({ draft_reply: 'Dạ còn rau ạ', send: true, approval_status: 'APPROVED' }),
    });
    assert.equal(sent.status, 403);

    const removed = await fetch(base + '/admin/api/drafts/' + zalo.id + '/delete', {
      method: 'POST',
      headers: saleHeaders,
      body: '{}',
    });
    assert.equal(removed.status, 403);

    const refund = await fetch(base + '/admin/api/drafts/' + zalo.id, {
      method: 'PATCH',
      headers: saleHeaders,
      body: JSON.stringify({ review_form: { refund_decision: 'hoan' } }),
    });
    assert.equal(refund.status, 403);

    const big = await fetch(base + '/admin/api/drafts/' + zalo.id + '/kiotviet', {
      method: 'POST',
      headers: saleHeaders,
      body: JSON.stringify({ discount: 80000, confirm: false }),
    });
    assert.equal(big.status, 403);

    const usersPage = await fetch(base + '/admin/users', { headers: saleHeaders });
    assert.equal(usersPage.status, 403);

    const edited = await fetch(base + '/admin/api/drafts/' + zalo.id, {
      method: 'PATCH',
      headers: saleHeaders,
      body: JSON.stringify({ draft_reply: 'Dạ còn rau nhé chị' }),
    });
    assert.equal(edited.status, 200);
    const rows = await audit.list({ entity_id: zalo.id });
    const logs = rows.logs || rows.entries || [];
    assert.ok(logs.some(row => row.actor === 'sale:lan' && row.action === 'draft.edited'), JSON.stringify(rows).slice(0, 500));

    const manager = await trainingLog.storeOnApprove({
      id: '11111111-1111-1111-1111-111111111111',
      customer_query: 'thit heo gia bao nhieu',
      ai_draft_version: 'Dạ 150k',
      draft_reply: 'Dạ thịt heo 150k một ký ạ',
      sales_channel: 'farm',
    }, { actor: 'manager:phuoc' });
    const staff = await trainingLog.storeOnApprove({
      id: '22222222-2222-2222-2222-222222222222',
      customer_query: 'thit heo gia bao nhieu',
      ai_draft_version: 'Dạ 150k',
      draft_reply: 'Dạ thịt heo 150k một ký ạ',
      sales_channel: 'farm',
    }, { actor: 'sale:lan' });
    assert.ok(manager && staff);
    const ranked = await trainingLog.relevantExamples('thit heo gia', 'farm', 2);
    assert.equal(ranked[0].actor, 'manager:phuoc');

    await users.setDisabled(sale.id, true);
    const locked = await fetch(base + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'lan', password: 'matkhau1' }),
      redirect: 'manual',
    });
    assert.equal(locked.status, 401);
    const stale = await fetch(base + '/admin/api/session', { headers: saleHeaders });
    assert.equal(stale.status, 401);

    const boot = await login(base, '', 'secret');
    const created = await fetch(base + '/admin/users', {
      method: 'POST',
      headers: { Cookie: boot, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'create',
        username: 'hoa',
        password: 'matkhau12',
        role: 'manager',
        display_name: 'Hoa',
      }),
      redirect: 'manual',
    });
    assert.equal(created.status, 303);
    const userLogs = await audit.list({ action: 'admin.user_created' });
    const createdRows = userLogs.logs || userLogs.entries || [];
    assert.ok(createdRows.some(row => row.actor === 'manager' && row.after && row.after.username === 'hoa'));
    assert.equal(JSON.stringify(createdRows).includes('matkhau12'), false);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
