/**
 * Viettel Post address: 3-level catalog, diacritic-insensitive search,
 * best-effort parse, and province + ward validation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const units = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'vtp-units.json'), 'utf8'));
const vtp = require('../public/admin/vtp-address');
vtp.load(units);

test('search ignores diacritics', () => {
  const hits = vtp.searchWards('gia kiem');
  assert.ok(hits.some(item => item.id === '9904'));
  assert.equal(vtp.fold('Gia Kiệm'), 'gia kiem');
});

test('parse a comma-separated HCMC address', () => {
  const parsed = vtp.parse('12 Nguyễn Xí, Phường 26, Bình Thạnh, Hồ Chí Minh');
  assert.equal(parsed.detail, '12 Nguyễn Xí');
  assert.equal(parsed.province && parsed.province.id, '2');
  assert.equal(parsed.district && parsed.district.id, '51');
  assert.equal(parsed.ward && parsed.ward.id, '884');
  assert.equal(parsed.line, '12 Nguyễn Xí, Phường 26, Quận Bình Thạnh, Hồ Chí Minh');
});

test('parse Gia Kiệm with district, including an unpunctuated line', () => {
  const punctuated = vtp.parse('Ấp Phúc Nhạc, Xã Gia Kiệm, Huyện Thống Nhất, Đồng Nai');
  assert.equal(punctuated.detail, 'Ấp Phúc Nhạc');
  assert.equal(punctuated.province && punctuated.province.id, '51');
  assert.equal(punctuated.district && punctuated.district.id, '576');
  assert.equal(punctuated.ward && punctuated.ward.id, '9904');
  assert.match(punctuated.line, /^Ấp Phúc Nhạc, Xã Gia Kiệm/);
  assert.match(punctuated.line, /Huyện Thống Nhất, Đồng Nai$/);

  const loose = vtp.parse('ấp phúc nhạc xã gia kiệm huyện thống nhất đồng nai');
  assert.equal(loose.ward && loose.ward.id, '9904');
  assert.equal(loose.district && loose.district.id, '576');
  assert.equal(loose.province && loose.province.id, '51');
  assert.match(loose.detail, /ấp phúc nhạc/i);
});

test('parse a Hanoi street and keep the street as the detail', () => {
  const parsed = vtp.parse('Số 5A ngách 22 ngõ 282 Kim Giang, Đại Kim, Hoàng Mai, Hà Nội');
  assert.equal(parsed.detail, 'Số 5A ngách 22 ngõ 282 Kim Giang');
  assert.equal(parsed.province && parsed.province.id, '1');
  assert.equal(parsed.district && parsed.district.id, '4');
  assert.equal(parsed.ward && parsed.ward.id, '75');
  assert.equal(parsed.line, 'Số 5A ngách 22 ngõ 282 Kim Giang, Phường Đại Kim, Quận Hoàng Mai, Hà Nội');
});

test('province and ward are required once an address is started', () => {
  assert.equal(vtp.validate({}).ok, false);
  assert.equal(vtp.validate({ provinceId: '51' }).ok, false);
  assert.equal(vtp.validate({ wardId: '9904' }).ok, false);
  const ok = vtp.validate({ provinceId: '51', wardId: '9904' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
});

test('invoice page shows the normalized address on its own row', () => {
  const invoiceImage = require('../services/invoiceImage');
  const line = 'Ấp Phúc Nhạc, Xã Gia Kiệm, Huyện Thống Nhất, Đồng Nai';
  const html = invoiceImage.pageHtml({
    code: 'HD1',
    customer_name: 'Lan',
    customer_code: 'KH1',
    total: 1000,
    delivery_address: line,
  }, '');
  assert.equal((html.match(/class="id-row"/g) || []).length, 1);
  const idRow = html.slice(html.indexOf('<div class="id-row">'), html.indexOf('</div>'));
  assert.equal(idRow.includes('Ấp Phúc Nhạc'), false);
  assert.match(html, /class="addr-line"/);
  assert.match(html, /Ấp Phúc Nhạc, Xã Gia Kiệm, Huyện Thống Nhất, Đồng Nai/);
});

test('catalog is the live 3-level Viettel Post list, not the 34-province map', () => {
  assert.equal(units.levels, 3);
  assert.ok(units.p.length >= 63);
  assert.ok(units.p.some(row => row[2] === 'Hà Giang'));
  assert.ok(units.w.every(row => row[1] != null));
});
