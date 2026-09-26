/**
 * Viettel Post handoff: clipboard text now, createOrder later.
 * No HTTP. Synthetic fixtures only.
 */
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vtpOrder = require('../public/admin/vtp-order');

const COMPLETE = {
  receiver: 'Khách Thử',
  phone: '0900000001',
  address: {
    detail: '12 Đường Thử',
    provinceId: '2',
    provinceName: 'Hồ Chí Minh',
    districtId: '51',
    districtName: 'Bình Thạnh',
    wardId: '884',
    wardName: 'Phường 26',
  },
  items: [{ name: 'Sản phẩm thử', sku: 'SP-DEMO', quantity: 1 }],
  total: 10000,
  paymentStatus: 'chua_tt',
  note: 'giao thử',
};

test('clipboard lists receiver, VTP address order, items, COD and note', () => {
  const text = vtpOrder.clipboardText(COMPLETE);
  assert.equal(text, [
    'Người nhận: Khách Thử',
    'SĐT: 0900000001',
    'Địa chỉ: 12 Đường Thử, Phường 26, Bình Thạnh, Hồ Chí Minh',
    'Hàng: Sản phẩm thử × 1',
    'COD: 10000',
    'Ghi chú: giao thử',
  ].join('\n'));
});

test('COD is the invoice total when Chưa TT and 0 otherwise', () => {
  assert.equal(vtpOrder.codAmount(COMPLETE), 10000);
  assert.equal(vtpOrder.codAmount(Object.assign({}, COMPLETE, { paymentStatus: 'da_tt' })), 0);
  assert.equal(vtpOrder.codAmount(Object.assign({}, COMPLETE, { paymentStatus: 'mot_phan' })), 0);
  assert.match(vtpOrder.clipboardText(Object.assign({}, COMPLETE, { paymentStatus: 'da_tt' })), /COD: 0/);
});

test('an incomplete address does not copy and names the missing part', () => {
  const order = Object.assign({}, COMPLETE, {
    address: { detail: '12 Đường Thử', provinceId: '2', provinceName: 'Hồ Chí Minh', wardName: 'Phường Không Có' },
  });
  const decided = vtpOrder.plan(order, {});
  assert.equal(decided.ok, false);
  assert.equal(decided.mode, 'blocked');
  assert.equal(decided.text, '');
  assert.ok(decided.missing.includes('district'));
  assert.ok(decided.missing.includes('ward'));
  assert.equal(decided.focus, 'district');
});

test('missing receiver, phone or items blocks the copy', () => {
  assert.ok(vtpOrder.missingParts(Object.assign({}, COMPLETE, { receiver: '' })).includes('name'));
  assert.ok(vtpOrder.missingParts(Object.assign({}, COMPLETE, { phone: '' })).includes('phone'));
  assert.ok(vtpOrder.missingParts(Object.assign({}, COMPLETE, { items: [] })).includes('items'));
});

test('VIETTELPOST_ENABLED off copies and never calls a transport', async () => {
  let called = 0;
  const transport = () => { called += 1; return { ok: true }; };
  const decided = vtpOrder.plan(COMPLETE, { VIETTELPOST_ENABLED: '', VIETTELPOST_TOKEN: '' });
  assert.equal(decided.mode, 'clipboard');
  const result = await vtpOrder.createOrder(COMPLETE, {}, transport);
  assert.equal(result.mode, 'clipboard');
  assert.match(result.text, /Người nhận: Khách Thử/);
  assert.equal(called, 0);
  assert.equal(vtpOrder.enabled({ VIETTELPOST_ENABLED: '1' }), false);
  assert.equal(vtpOrder.enabled({ VIETTELPOST_ENABLED: 'true', VIETTELPOST_TOKEN: 'tok' }), true);
});

test('the live createOrder plug-in runs only when the flag and a token are set', async () => {
  const env = { VIETTELPOST_ENABLED: '1', VIETTELPOST_TOKEN: 'later-token' };
  await assert.rejects(() => vtpOrder.createOrder(COMPLETE, env), (err) => err.code === 'VTP_NOT_WIRED');
  let sent = null;
  const result = await vtpOrder.createOrder(COMPLETE, env, (payload) => {
    sent = payload;
    return { code: 'VTP1' };
  });
  assert.equal(result.mode, 'api');
  assert.equal(result.result.code, 'VTP1');
  assert.equal(sent.cod, 10000);
  assert.equal(sent.provinceId, '2');
  assert.equal(sent.districtId, '51');
  assert.equal(sent.wardId, '884');
  assert.equal(sent.receiverPhone, '0900000001');
});

test('the VTP module does not call the network', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'vtp-order.js'), 'utf8');
  assert.match(src, /VIETTELPOST_ENABLED/);
  assert.match(src, /VIETTELPOST_TOKEN/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.doesNotMatch(src, /https?:\/\//);
});
