/**
 * Read-only FB label sample. Does not relabel.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-sample-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.ADMIN_USERS_PATH = path.join(dir, 'users.json');
process.env.ADMIN_PASSWORD = 'secret';
process.env.NODE_ENV = 'test';
delete process.env.ADMIN_API_KEY;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const store = require('../services/conversationStore');
const lanhMark = require('../services/lanhMark');
const sample = require('../services/labelSample');
const users = require('../services/adminUsers');
const hitlAdmin = require('../services/hitlAdmin');

const fresh = '2026-08-01T00:00:00.000Z';
const PHONE = '0901234567';
const SECRET_TAIL = 'SECRET_TAIL_NOT_IN_SAMPLE';
const SECOND = 'SECOND_CUSTOMER_BODY_SHOULD_NOT_LEAK';

function appServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  hitlAdmin.mount(app);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function login(base, username, password) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

beforeEach(() => {
  store.resetForTests();
});

test('the signature finder matches the same words as the labeler', () => {
  assert.equal(lanhMark.textHasLanh('trời lạnh quá'), false);
  assert.equal(lanhMark.findLanhTokens('trời lạnh quá').length, 0);
  assert.equal(lanhMark.textHasLanh('Lành'), true);
  assert.deepEqual(
    lanhMark.findLanhTokens('Em là Lành đây').map((hit) => hit.token),
    ['Lành']
  );
  assert.equal(lanhMark.textHasLanh('xlanhx'), false);
  assert.equal(lanhMark.findLanhTokens('xlanhx').length, 0);
  assert.equal(sample.clampLimit(undefined), 30);
  assert.equal(sample.clampLimit(9), 9);
  assert.equal(sample.clampLimit(500), 100);
});

test('sample returns the page snippet, a short first customer line, and the product/service split', async () => {
  await store.setLabel('fb', 'fb_inline', { label: 'dv', source: 'signature', confidence: 0.9 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_inline',
    direction: 'out',
    message_text: 'Em tên Lành đây, shop gửi giá dầu gội',
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    source_msg_id: 'in-out',
    created_time: fresh,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_inline',
    direction: 'in',
    message_text: 'xin giá dầu gội',
    source_msg_id: 'in-in',
    created_time: fresh,
  });

  await store.setLabel('fb', 'fb_product', { label: 'dv', source: 'signature', confidence: 0.9 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_product',
    direction: 'out',
    message_text: `Dạ nước nghệ còn chai. Gọi ${PHONE}\nLành`,
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    source_msg_id: 'pr-out',
    created_time: fresh,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_product',
    direction: 'in',
    message_text: `mua nước nghệ lên men giúp em ${'Y'.repeat(80)}${SECRET_TAIL}`,
    source_msg_id: 'pr-in',
    created_time: fresh,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_product',
    direction: 'in',
    message_text: SECOND,
    source_msg_id: 'pr-in-2',
    created_time: fresh,
  });

  await store.setLabel('fb', 'fb_stay', { label: 'dv', source: 'signature', confidence: 0.9 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_stay',
    direction: 'out',
    message_text: 'Dạ còn phòng farmstay\nLành',
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    source_msg_id: 'st-out',
    created_time: fresh,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_stay',
    direction: 'in',
    message_text: 'mình muốn lưu trú cuối tuần',
    source_msg_id: 'st-in',
    created_time: fresh,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_stay',
    direction: 'out',
    message_text: 'Dạ hôm nay trời lạnh quá',
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    source_msg_id: 'st-cold',
    created_time: fresh,
  });

  await store.setLabel('fb', 'fb_keyword', { label: 'dv', source: 'keyword', confidence: 0.7 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_keyword',
    direction: 'in',
    message_text: 'KEYWORD_ONLY_BODY',
    source_msg_id: 'kw-in',
    created_time: fresh,
  });

  const result = await sample.build({ label: 'dv', reason: 'signature', limit: 30 });
  assert.equal(result.matched_threads, 3);
  assert.equal(result.threads.length, 3);
  assert.deepEqual(result.threads.map((row) => row.thread_id), ['fb_inline', 'fb_product', 'fb_stay']);

  const product = result.threads.find((row) => row.thread_id === 'fb_product');
  assert.equal(product.reason, 'signature');
  assert.equal(product.message_count, 3);
  assert.equal(product.signature.substring, 'Lành');
  assert.equal(product.signature.placement, 'signoff');
  assert.match(product.signature.context, /Lành/);
  assert.match(product.signature.context, /nước nghệ/);
  assert.equal(product.signature.context.includes(PHONE), false);
  assert.ok(product.first_customer.length <= 60);
  assert.match(product.first_customer, /nước nghệ/);
  assert.equal(product.first_customer.includes(SECRET_TAIL), false);
  assert.ok(product.catalog_products.includes('Nước nghệ lên men'));
  assert.equal(product.has_product_keyword, true);
  assert.equal(product.has_service_keyword, false);

  const stay = result.threads.find((row) => row.thread_id === 'fb_stay');
  assert.equal(stay.signature.placement, 'signoff');
  assert.equal(stay.has_service_keyword, true);
  assert.equal(stay.has_product_keyword, false);
  assert.equal(stay.signature.context.includes('trời lạnh'), false);

  const inline = result.threads.find((row) => row.thread_id === 'fb_inline');
  assert.equal(inline.signature.placement, 'inline');
  assert.equal(inline.signature.substring, 'Lành');
  assert.equal(inline.has_product_keyword, true);

  const lanh = result.signature_histogram.find((row) => row.substring === 'Lành');
  assert.equal(lanh.threads, 3);
  assert.equal(lanh.signoff_messages, 2);
  assert.equal(lanh.inline_messages, 1);
  assert.equal(result.signature_dv.threads, 3);
  assert.equal(result.signature_dv.product_only, 2);
  assert.equal(result.signature_dv.service_only, 1);
  assert.equal(result.signature_dv.both, 0);

  const dumped = JSON.stringify(result);
  assert.equal(dumped.includes(SECOND), false);
  assert.equal(dumped.includes(SECRET_TAIL), false);
  assert.equal(dumped.includes(PHONE), false);
  assert.equal(dumped.includes('KEYWORD_ONLY_BODY'), false);

  const page = await sample.build({ label: 'dv', reason: 'signature', limit: 1 });
  assert.equal(page.threads.length, 1);
  assert.equal(page.matched_threads, 3);
  assert.equal(page.signature_histogram.find((row) => row.substring === 'Lành').threads, 3);
  assert.equal(page.signature_dv.threads, 3);
});

test('the sample route is manager-only and does not relabel', async () => {
  await users.create({ username: 'lan', password: 'matkhau1', role: 'sale', display_name: 'Lan' });
  await store.setLabel('fb', 'fb_keep', { label: 'sale', source: 'manual', confidence: 1 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_keep',
    direction: 'out',
    message_text: 'Dạ còn phòng\nLành',
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    source_msg_id: 'keep-out',
    created_time: fresh,
  });

  const server = await appServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const open = await fetch(`${base}/admin/api/fb/labels/sample`);
    assert.equal(open.status, 401);

    const saleCookie = await login(base, 'lan', 'matkhau1');
    const sale = await fetch(`${base}/admin/api/fb/labels/sample`, {
      headers: { Cookie: saleCookie },
    });
    assert.equal(sale.status, 403);

    const managerCookie = await login(base, '', 'secret');
    const bad = await fetch(`${base}/admin/api/fb/labels/sample?label=nope`, {
      headers: { Cookie: managerCookie },
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/admin/api/fb/labels/sample?label=dv&reason=signature&limit=30`, {
      headers: { Cookie: managerCookie },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.matched_threads, 0);
    assert.equal(body.signature_dv.threads, 0);
    const kept = await store.getLabel('fb', 'fb_keep');
    assert.equal(kept.label, 'sale');
    assert.equal(kept.source, 'manual');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
