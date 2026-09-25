/**
 * Kiot product picker: quantity display, search notes, and accent match.
 */
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const picker = require('../public/admin/kiot-picker');
const kiotviet = require('../services/kiotviet');

test('quantity stays a whole number unless a decimal was typed', () => {
  assert.equal(picker.normalizeQty(1.001), 1);
  assert.equal(picker.normalizeQty('1.001'), 1);
  assert.equal(picker.normalizeQty('1,001'), 1);
  assert.equal(picker.normalizeQty(1), 1);
  assert.equal(picker.normalizeQty(''), 1);
  assert.equal(picker.normalizeQty(0), 1);
  assert.equal(picker.normalizeQty(1.2), 1.2);
  assert.equal(picker.normalizeQty('0.5'), 0.5);
  assert.equal(picker.normalizeQty('1.20'), 1.2);
  assert.equal(picker.qtyText(1.001), '1');
  assert.equal(picker.qtyText(1.2), '1.2');
  assert.equal(picker.qtyText('0,5'), '0.5');
  assert.equal(picker.qtyText('1.'), '1.');
  assert.equal(picker.qtyText('1,'), '1,');
  assert.equal(picker.qtyText(1.001).includes('1.001'), false);
});

test('search states name the offline, empty, and loading cases', () => {
  assert.equal(picker.searchNote('loading'), 'Đang tìm…');
  assert.equal(picker.searchNote('error'), picker.OFFLINE);
  assert.equal(picker.searchNote('empty'), picker.EMPTY);
  assert.equal(picker.searchNote('ok'), '');
  assert.equal(picker.searchNote('idle'), '');
  assert.equal(picker.OFFLINE, 'Chưa kết nối KiotViet: không tra được sản phẩm/giá');
  assert.equal(picker.EMPTY, 'Không tìm thấy sản phẩm gần giống');
});

test('accent-insensitive search returns the top matches with price and stock', () => {
  const catalog = [];
  for (let i = 0; i < 10; i++) {
    catalog.push({
      id: i + 1,
      code: 'XX' + String(i).padStart(2, '0'),
      name: i === 3 ? 'Xúc xích heo' : 'xuc xich loai ' + i,
      price: 15000 + i,
      available: 4 + i,
      unit: 'kg',
    });
  }
  catalog.push({ id: 99, code: 'GA01', name: 'Thịt gà', price: 90000, available: 2, unit: 'kg' });
  const accented = kiotviet.rankProducts(catalog, 'xúc xích');
  const plain = kiotviet.rankProducts(catalog, 'xuc xich');
  assert.equal(accented.length, 8);
  assert.deepEqual(accented.map(p => p.id), plain.map(p => p.id));
  assert.ok(accented.some(p => p.name === 'Xúc xích heo'));
  assert.equal(accented.some(p => p.name === 'Thịt gà'), false);
  const hit = accented[0];
  assert.equal(typeof hit.code, 'string');
  assert.equal(typeof hit.price, 'number');
  assert.equal(typeof hit.available, 'number');
  const byCode = kiotviet.rankProducts(catalog, 'ga0');
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].code, 'GA01');
  assert.deepEqual(kiotviet.rankProducts(catalog, 'x'), []);
});

test('the order form shows picker notes and does not create a Kiot document by itself', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.css'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'services', 'hitlAdmin.js'), 'utf8');
  assert.match(html, /kiot-picker\.js/);
  assert.match(html, /inbox-order\.js/);
  assert.match(routes, /\/admin\/inbox-order\.js/);
  assert.match(routes, /\/admin\/kiot-picker\.js/);
  assert.match(js, /step: '1'/);
  assert.match(js, /searchNote\(line\.searchPhase\)/);
  assert.match(js, /fillSearch\(query, results, line, index\), 250\)/);
  assert.match(js, /searchPhase = 'error'/);
  assert.match(js, /searchPhase = products\.length \? 'ok' : 'empty'/);
  assert.match(js, /Xác nhận tạo hoá đơn/);
  assert.match(js, /Xác nhận tạo đơn đặt hàng/);
  assert.doesNotMatch(js, /fillSearch[\s\S]{0,500}confirm:\s*true/);
  assert.match(css, /\.msg-card \{[^}]*overflow:\s*visible/);
  assert.match(css, /button\.kiot-hit \{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.kiot-fold \{[^}]*overflow:\s*visible/);
});
