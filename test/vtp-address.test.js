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

test('an incomplete address warns and does not block', () => {
  const empty = vtp.validate({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.warnings, []);

  const provinceOnly = vtp.validate({ provinceId: '51', detail: 'Ấp Phúc Nhạc' });
  assert.equal(provinceOnly.ok, true);
  assert.deepEqual(provinceOnly.errors, []);
  assert.ok(provinceOnly.missing.includes('district'));
  assert.ok(provinceOnly.missing.includes('ward'));
  assert.match(provinceOnly.warnings.join(' '), /Thiếu quận, phường/);

  const unmatched = vtp.validate({
    provinceId: '2',
    districtId: '51',
    wardText: 'Phường Không Có',
    detail: '12 Đường Thử',
  });
  assert.equal(unmatched.ok, true);
  assert.deepEqual(unmatched.missing, []);
  assert.deepEqual(unmatched.invalid, ['ward']);
  assert.match(unmatched.warnings.join(' '), /Chưa khớp phường/);

  const streetEmpty = vtp.validate({ provinceId: '2', districtId: '51', wardId: '884' });
  assert.equal(streetEmpty.ok, true);
  assert.deepEqual(streetEmpty.missing, ['street']);
  assert.equal(streetEmpty.focus, 'street');

  const ok = vtp.validate({ provinceId: '51', districtId: '576', wardId: '9904', detail: 'Ấp Phúc Nhạc' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);
});

test('partial parse keeps a province and leaves the missing levels empty', () => {
  const parsed = vtp.parse('12 Đường Thử, Hồ Chí Minh');
  assert.equal(parsed.detail, '12 Đường Thử');
  assert.equal(parsed.province && parsed.province.id, '2');
  assert.equal(parsed.district, null);
  assert.equal(parsed.ward, null);
  assert.equal(parsed.districtText, '');
  assert.equal(parsed.wardText, '');
  assert.equal(parsed.line, '12 Đường Thử, Hồ Chí Minh');
});

test('an unmatched ward stays in the ward field as free text', () => {
  const parsed = vtp.parse('12 Đường Thử, Phường Không Có, Hồ Chí Minh');
  assert.equal(parsed.detail, '12 Đường Thử');
  assert.equal(parsed.province && parsed.province.id, '2');
  assert.equal(parsed.ward, null);
  assert.equal(parsed.wardText, 'Phường Không Có');
  assert.match(parsed.line, /12 Đường Thử, Phường Không Có, Hồ Chí Minh/);
});

test('an unmatched district stays editable and a catalog miss stays on the street', () => {
  const district = vtp.parse('12 Đường Thử, Quận Không Có, Hồ Chí Minh');
  assert.equal(district.district, null);
  assert.equal(district.districtText, 'Quận Không Có');
  assert.equal(district.province && district.province.id, '2');
  assert.equal(district.detail, '12 Đường Thử');

  const unknown = vtp.parse('Nhà số 9 ngõ lạ không có trên bản đồ');
  assert.equal(unknown.province, null);
  assert.equal(unknown.district, null);
  assert.equal(unknown.ward, null);
  assert.match(unknown.detail, /ngõ lạ/);

  const streetEmpty = vtp.parse('Hồ Chí Minh');
  assert.equal(streetEmpty.province && streetEmpty.province.id, '2');
  assert.equal(streetEmpty.detail, '');
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

test('the default province is the Hồ Chí Minh catalog entry', () => {
  const prev = process.env.DEFAULT_PROVINCE;
  const prevWindow = globalThis.DEFAULT_PROVINCE;
  delete process.env.DEFAULT_PROVINCE;
  delete globalThis.DEFAULT_PROVINCE;
  try {
    assert.equal(vtp.DEFAULT_PROVINCE, 'Hồ Chí Minh');
    assert.equal(vtp.configuredProvinceName(), 'Hồ Chí Minh');
    const item = vtp.defaultProvince();
    assert.equal(item.id, '2');
    assert.equal(item.code, 'HCM');
    assert.equal(item.label, 'Hồ Chí Minh');
    const districts = vtp.searchDistricts('', item.id, 8);
    assert.ok(districts.length >= 1);
    assert.ok(districts.every(row => row.provinceId === '2'));
    assert.ok(districts.some(row => row.label === 'Quận 6'));
    const warn = vtp.gaps({ provinceId: item.id, provinceName: item.label });
    assert.equal(warn.ok, true);
    assert.equal(warn.missing.includes('province'), false);
    assert.ok(warn.missing.includes('district'));
    assert.ok(warn.missing.includes('ward'));
    const text = warn.warnings.join(' ');
    assert.match(text, /quận/);
    assert.match(text, /phường/);
    assert.equal(/tỉnh/.test(text), false);

    process.env.DEFAULT_PROVINCE = 'Hà Nội';
    assert.equal(vtp.configuredProvinceName(), 'Hà Nội');
    assert.equal(vtp.defaultProvince().id, '1');
    process.env.DEFAULT_PROVINCE = 'TP. Hồ Chí Minh';
    assert.equal(vtp.defaultProvince().id, '2');
    assert.equal(vtp.defaultProvince().label, 'Hồ Chí Minh');
    process.env.DEFAULT_PROVINCE = 'Tỉnh Không Có';
    assert.equal(vtp.defaultProvince(), null);
  } finally {
    if (prev == null) delete process.env.DEFAULT_PROVINCE;
    else process.env.DEFAULT_PROVINCE = prev;
    if (prevWindow == null) delete globalThis.DEFAULT_PROVINCE;
    else globalThis.DEFAULT_PROVINCE = prevWindow;
  }
});

test('catalog is the live 3-level Viettel Post list, not the 34-province map', () => {
  assert.equal(units.levels, 3);
  assert.ok(units.p.length >= 63);
  assert.ok(units.p.some(row => row[2] === 'Hà Giang'));
  assert.ok(units.w.every(row => row[1] != null));
});
