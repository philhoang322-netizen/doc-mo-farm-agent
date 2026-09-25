/**
 * Quick-entry parsing and catalog matching. Pure: no KiotViet HTTP.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const quick = require('../services/quickEntry');

const SAUSAGES = [
  { id: 1, code: 'SP-TOI', name: 'Xúc xích tỏi', price: 85000, unit: 'gói', isActive: true, available: 3 },
  { id: 2, code: 'SP-PM', name: 'Xúc xích phô mai', price: 85000, unit: 'gói', isActive: true, available: 20 },
];

const SHOP = [
  { id: 3, code: 'SP-XX', name: 'Xúc xích', price: 85000, unit: 'gói', isActive: true, available: 20 },
  { id: 4, code: 'SP-NN', name: 'Nước nghệ lên men', price: 95000, unit: 'chai', isActive: true, available: 9 },
  { id: 5, code: 'SP-BR', name: 'Ba rọi heo', price: 180000, unit: 'kg', isActive: true, available: 6 },
  { id: 6, code: 'SP-HT', name: 'Thịt heo trắng', price: 160000, unit: 'kg', isActive: true, available: 4 },
  { id: 7, code: 'SP-HX', name: 'Heo trắng xay', price: 150000, unit: 'kg', isActive: true, available: 2 },
];

test('parseQuickEntry splits commas, và, +, and newlines', () => {
  const comma = quick.parseQuickEntry('1 xuc xich, 2 nước nghệ lên men');
  assert.equal(comma.length, 2);
  assert.equal(comma[0].quantity, 1);
  assert.equal(comma[0].phrase, 'xuc xich');
  assert.equal(comma[1].quantity, 2);
  assert.equal(comma[1].phrase, 'nước nghệ lên men');

  const va = quick.parseQuickEntry('1 xuc xich và 2 nuoc nghe');
  assert.equal(va.length, 2);
  assert.equal(va[1].phrase, 'nuoc nghe');

  const plus = quick.parseQuickEntry('1 xuc xich + 2 nuoc nghe');
  assert.equal(plus.length, 2);

  const lines = quick.parseQuickEntry('1 xuc xich\n2 nuoc nghe');
  assert.equal(lines.length, 2);
});

test('parseQuickEntry reads decimals with dot or comma and weight units', () => {
  const dot = quick.parseQuickEntry('0.5kg ba rọi, 1 xúc xích');
  assert.equal(dot[0].quantity, 0.5);
  assert.equal(dot[0].unit, 'kg');
  assert.equal(dot[0].phrase, 'ba rọi');
  assert.equal(dot[1].quantity, 1);
  assert.equal(dot[1].unit, null);
  assert.equal(dot[1].phrase, 'xúc xích');

  const comma = quick.parseQuickEntry('0,5 kg ba rọi');
  assert.equal(comma[0].quantity, 0.5);
  assert.equal(comma[0].unit, 'kg');

  const one = quick.parseQuickEntry('1,5kg ba rọi');
  assert.equal(one[0].quantity, 1.5);
  assert.equal(one[0].unit, 'kg');

  const grams = quick.parseQuickEntry('500g ba rọi');
  assert.equal(grams[0].quantity, 500);
  assert.equal(grams[0].unit, 'g');

  const lang = quick.parseQuickEntry('2 lạng ba rọi');
  assert.equal(lang[0].quantity, 2);
  assert.equal(lang[0].unit, 'lang');
});

test('accent-less text matches the catalog name and converts weight', () => {
  const matched = quick.matchQuickEntry('1 xuc xich, 2 nuoc nghe len men', SHOP);
  assert.equal(matched.lines.length, 2);
  assert.equal(matched.lines[0].status, 'matched');
  assert.equal(matched.lines[0].product.code, 'SP-XX');
  assert.equal(matched.lines[0].quantity, 1);
  assert.equal(matched.lines[0].product.price, 85000);
  assert.equal(matched.lines[1].status, 'matched');
  assert.equal(matched.lines[1].product.code, 'SP-NN');
  assert.equal(matched.lines[1].quantity, 2);

  const weight = quick.matchQuickEntry('500g ba roi, 2 lang ba roi', [
    SHOP[2],
  ]);
  assert.equal(weight.lines[0].status, 'matched');
  assert.equal(weight.lines[0].quantity, 0.5);
  assert.equal(weight.lines[0].unit, 'kg');
  assert.equal(weight.lines[1].quantity, 0.2);
});

test('several plausible matches stay unresolved and unmatched phrases are flagged', () => {
  const ambiguous = quick.matchQuickEntry('1 xuc xich', SAUSAGES);
  assert.equal(ambiguous.lines[0].status, 'ambiguous');
  assert.equal(ambiguous.lines[0].product, null);
  assert.equal(ambiguous.lines[0].candidates.length, 2);
  const codes = ambiguous.lines[0].candidates.map(c => c.code).sort();
  assert.deepEqual(codes, ['SP-PM', 'SP-TOI']);

  const specific = quick.matchQuickEntry('1 xuc xich toi', SAUSAGES);
  assert.equal(specific.lines[0].status, 'matched');
  assert.equal(specific.lines[0].product.code, 'SP-TOI');

  const miss = quick.matchQuickEntry('1 khong co mon nay', SHOP);
  assert.equal(miss.lines[0].status, 'unmatched');
  assert.equal(miss.lines[0].product, null);
});

test('heo trắng alias prefers the mapped SKU and in-stock candidates sort first', () => {
  const mapped = quick.matchQuickEntry('1kg heo trang', SHOP, {
    aliases: [{ key: 'heotrang', sku: 'SP-HT' }],
  });
  assert.equal(mapped.lines[0].status, 'matched');
  assert.equal(mapped.lines[0].product.code, 'SP-HT');
  assert.equal(mapped.lines[0].quantity, 1);

  const open = quick.matchQuickEntry('1 heo trang', SHOP);
  assert.equal(open.lines[0].status, 'ambiguous');
  assert.equal(open.lines[0].product, null);
  assert.ok(open.lines[0].candidates.length >= 2);

  const ties = quick.matchQuickEntry('1 xuc xich', [
    { ...SAUSAGES[0], available: 0 },
    { ...SAUSAGES[1], available: 12 },
  ]);
  assert.equal(ties.lines[0].status, 'ambiguous');
  assert.equal(ties.lines[0].candidates[0].code, 'SP-PM');
  assert.equal(ties.lines[0].candidates[0].available, 12);
});

test('inactive duplicate does not replace the active product', () => {
  const rows = quick.matchQuickEntry('1 xuc xich', [
    { id: 1, code: 'OLD', name: 'Xúc xích', price: 1, unit: 'gói', isActive: false, available: 99 },
    { id: 2, code: 'NEW', name: 'Xúc xích', price: 85000, unit: 'gói', isActive: true, available: 4 },
  ]);
  assert.equal(rows.lines[0].status, 'matched');
  assert.equal(rows.lines[0].product.code, 'NEW');
});

test('prefillText keeps the customer basket, including accent-less typing', () => {
  const typed = quick.prefillText({
    customer_query: '1 xuc xich, 2 nước nghệ lên men',
    customer_intent: '[sales] đặt hàng',
    suggested: [],
  });
  assert.equal(typed, '1 xuc xich, 2 nước nghệ lên men');

  const fromNames = quick.prefillText({
    customer_query: '',
    customer_intent: '[sales] hỏi giá',
    suggested: [{ quantity: 2, product_name: 'Heo trắng' }],
  });
  assert.equal(fromNames, '2 Heo trắng');
});
