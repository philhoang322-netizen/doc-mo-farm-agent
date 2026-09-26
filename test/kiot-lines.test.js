/**
 * Multiple products on one KiotViet inbox order.
 * Adding a line keeps the others. Quick entry keeps every parsed item.
 * The Kiot payload lists those lines, and nothing is created before confirm.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiot-lines-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'nongsansachdn';
process.env.STOCK_LOW_THRESHOLD = '5';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const linesApi = require('../public/admin/kiot-lines');

test('a picked suggestion fills quantity 1 and leaves an existing line', () => {
  const first = linesApi.addProduct([linesApi.blankLine()], {
    code: 'NN-DEMO', name: 'Nước nghệ thử', price: 20000, unit: 'chai', available: 8,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].sku, 'NN-DEMO');
  assert.equal(first[0].quantity, 1);
  assert.equal(first[0].price, 20000);
  assert.equal(first[0].stock.available, 8);
  const second = linesApi.addProduct(first, {
    code: 'SP-DEMO', name: 'Sản phẩm thử', price: 10000, available: 3,
  });
  assert.equal(second.length, 2);
  assert.equal(second[0].sku, 'NN-DEMO');
  assert.equal(second[1].sku, 'SP-DEMO');
  assert.equal(second[1].quantity, 1);
});
const quick = require('../services/quickEntry');
const kiotviet = require('../services/kiotviet');
const kiotInbox = require('../services/kiotInbox');
const drafts = require('../services/drafts');
const invoiceImage = require('../services/invoiceImage');
const emvco = require('../services/emvco');

const real = {
  enabled: kiotviet.enabled,
  findProduct: kiotviet.findProduct,
  getOnHand: kiotviet.getOnHand,
  createSaleDocument: kiotviet.createSaleDocument,
  listProductsForMatch: kiotviet.listProductsForMatch,
  call: kiotviet.call,
  findOrCreateCustomer: kiotviet.findOrCreateCustomer,
  getCustomer: kiotviet.getCustomer,
};

const XX = { sku: 'SP-XX', code: 'SP-XX', name: 'Xúc xích', price: 85000, unit: 'gói', available: 20 };
const NN = { sku: 'SP-NN', code: 'SP-NN', name: 'Nước nghệ lên men', price: 95000, unit: 'chai', available: 3 };
const LX = { sku: 'SP-LX', code: 'SP-LX', name: 'Lạp xưởng', price: 70000, unit: 'gói', available: 0 };

const CATALOG = [XX, NN, LX].map((p, i) => ({
  id: i + 1,
  code: p.code,
  name: p.name,
  price: p.price,
  basePrice: p.price,
  unit: p.unit,
  isActive: true,
  available: p.available,
}));

function installMocks() {
  kiotviet.enabled = () => true;
  kiotviet.listProductsForMatch = async () => CATALOG.map(p => ({ ...p }));
  kiotviet.findProduct = async ({ sku }) => {
    const hit = CATALOG.find(p => p.code === String(sku || '').toUpperCase());
    return hit ? { ...hit, fullName: hit.name } : null;
  };
  kiotviet.getOnHand = async ({ sku }) => {
    const hit = CATALOG.find(p => p.code === sku);
    const available = hit ? hit.available : 0;
    return { ok: true, sku, available, onHand: available, reserved: 0, branchId: 26947 };
  };
  kiotviet.findOrCreateCustomer = async () => ({ id: 7, code: 'KH000123', name: 'Nguyễn Lan' });
  kiotviet.getCustomer = async () => ({ id: 7, code: 'KH000123', name: 'Nguyễn Lan' });
}

function restoreMocks() {
  kiotviet.enabled = real.enabled;
  kiotviet.findProduct = real.findProduct;
  kiotviet.getOnHand = real.getOnHand;
  kiotviet.createSaleDocument = real.createSaleDocument;
  kiotviet.listProductsForMatch = real.listProductsForMatch;
  kiotviet.call = real.call;
  kiotviet.findOrCreateCustomer = real.findOrCreateCustomer;
  kiotviet.getCustomer = real.getCustomer;
}

after(() => {
  restoreMocks();
});

test('adding three products keeps each line, and removing one leaves the other two', () => {
  let rows = [linesApi.blankLine()];
  rows = linesApi.chooseProduct(rows, 0, XX);
  rows = linesApi.addLine(rows);
  rows = linesApi.chooseProduct(rows, 1, NN);
  rows = linesApi.addLine(rows);
  rows = linesApi.chooseProduct(rows, 2, LX);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(line => line.sku), ['SP-XX', 'SP-NN', 'SP-LX']);
  assert.equal(rows[0].price, 85000);
  assert.equal(rows[0].quantity, 1);
  assert.equal(rows[1].quantity, 1);
  assert.equal(rows[0].stock.level, 'ok');
  assert.equal(rows[1].stock.level, 'low');
  assert.equal(rows[2].stock.level, 'blocked');
  assert.equal(linesApi.lineAmount(rows[1]), 95000);
  assert.equal(linesApi.orderTotal(rows, 0, 0), 85000 + 95000 + 70000);

  rows = linesApi.chooseProduct(rows, 0, LX);
  assert.equal(rows[0].sku, 'SP-XX', 'a new product must not replace the one already on the line');
  assert.equal(rows[1].sku, 'SP-LX');
  rows = linesApi.removeLine(rows, 1);
  assert.deepEqual(rows.map(line => line.sku), ['SP-XX', 'SP-NN', 'SP-LX']);

  rows = linesApi.removeLine(rows, 1);
  assert.deepEqual(rows.map(line => line.sku), ['SP-XX', 'SP-LX']);
  const payload = linesApi.payloadLines(rows);
  assert.equal(payload.length, 2);
  assert.deepEqual(payload.map(line => line.sku), ['SP-XX', 'SP-LX']);
  assert.equal(payload[0].product_name, 'Xúc xích');
  assert.equal(payload[1].quantity, 1);
  assert.equal(linesApi.orderTotal(rows, 0, 0), 85000 + 70000);

  const saved = linesApi.snapshot({
    document: 'invoice',
    lines: rows,
    quick: '1 xuc xich, 2 lap xuong',
    name: 'Nguyễn Lan',
    phone: '0901234567',
    touched: { quick: true },
  });
  const back = linesApi.restore(saved);
  assert.deepEqual(back.lines.map(line => line.sku), ['SP-XX', 'SP-LX']);
  assert.equal(back.quick, '1 xuc xich, 2 lap xuong');
  assert.equal(back.name, 'Nguyễn Lan');
});

test('quick entry of two items becomes two lines and does not drop a product already chosen', () => {
  const parsed = quick.parseQuickEntry('1 xuc xich, 2 lap xuong');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].phrase, 'xuc xich');
  assert.equal(parsed[0].quantity, 1);
  assert.equal(parsed[1].phrase, 'lap xuong');
  assert.equal(parsed[1].quantity, 2);

  const matched = [
    { sku: 'SP-XX', name: 'Xúc xích', price: 85000, quantity: 1, status: 'matched', stock: { level: 'ok', available: 20 } },
    { sku: 'SP-LX', name: 'Lạp xưởng', price: 70000, quantity: 2, status: 'matched', stock: { level: 'ok', available: 9 } },
  ];
  const filled = linesApi.applyQuick([linesApi.blankLine()], matched);
  assert.equal(filled.length, 2);
  assert.equal(filled[1].quantity, 2);
  assert.equal(linesApi.orderTotal(filled, 0, 0), 85000 + 140000);
  assert.equal(linesApi.payloadLines(filled).length, 2);

  let kept = linesApi.chooseProduct([linesApi.blankLine()], 0, XX);
  kept[0].quantity = 3;
  kept = linesApi.applyQuick(kept, matched);
  assert.equal(kept[0].sku, 'SP-XX');
  assert.equal(kept[0].quantity, 3);
  assert.equal(kept.filter(line => line.sku === 'SP-XX').length, 1);
  assert.ok(kept.some(line => line.sku === 'SP-LX' && line.quantity === 2));
});

test('quote stocks the matching line when a blank row sits between products', () => {
  const rows = linesApi.mergeQuote([
    { sku: 'SP-XX', name: 'Xúc xích', quantity: 1, price: null },
    linesApi.blankLine(),
    { sku: 'SP-LX', name: 'Lạp xưởng', quantity: 2, price: null },
  ], [
    { sku: 'SP-XX', name: 'Xúc xích', price: 85000, stock: { level: 'ok', available: 20 } },
    { sku: 'SP-LX', name: 'Lạp xưởng', price: 70000, stock: { level: 'ok', available: 9 } },
  ]);
  assert.equal(rows[0].price, 85000);
  assert.equal(rows[0].stock.available, 20);
  assert.equal(rows[1].sku, '');
  assert.equal(rows[2].price, 70000);
  assert.equal(linesApi.orderTotal(rows, 0, 0), 85000 + 140000);
});

test('quick entry does not create a Kiot document, and confirm sends every remaining line', async () => {
  installMocks();
  const posts = [];
  kiotviet.call = async (method, pathName, opts) => {
    posts.push({ method, path: pathName, data: opts && opts.data });
    const details = (opts && opts.data && (opts.data.invoiceDetails || opts.data.orderDetails)) || [];
    const total = details.reduce((sum, row) => sum + row.quantity * row.price, 0);
    return { id: 9, code: pathName.includes('order') ? 'DH011800' : 'HD011800', total };
  };
  let creates = 0;
  kiotviet.createSaleDocument = async (...args) => {
    creates += 1;
    return real.createSaleDocument(...args);
  };
  try {
    const filled = await kiotInbox.quickFill('1 xuc xich, 2 lap xuong');
    assert.equal(filled.status, 200);
    assert.equal(filled.body.created, false);
    assert.equal(filled.body.lines.length, 2);
    assert.equal(filled.body.lines[0].sku, 'SP-XX');
    assert.equal(filled.body.lines[1].sku, 'SP-LX');
    assert.equal(filled.body.lines[1].quantity, 2);
    assert.ok(filled.body.lines[0].stock);
    assert.ok(filled.body.lines[1].stock);
    assert.equal(creates, 0);
    assert.equal(posts.length, 0);

    const draft = await drafts.createDraft({
      channel: 'zalo',
      customer_name: 'Nguyễn Lan',
      customer_phone: '0901234567',
      customer_user_id: 'zalo_lines_' + Date.now(),
      customer_query: '1 xuc xich, 2 lap xuong',
      draft_reply: 'Dạ em lên đơn ạ.',
    });
    const preview = await kiotInbox.prepareOrCreate(draft.id, {
      confirm: false,
      document: 'invoice',
      customer_name: 'Nguyễn Lan',
      phone: '0901234567',
      lines: [
        { sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 },
        { sku: 'SP-LX', product_name: 'Lạp xưởng', quantity: 2 },
      ],
    }, 'Phil');
    assert.equal(preview.status, 200);
    assert.equal(preview.body.created, false);
    assert.equal(preview.body.lines.length, 2);
    assert.equal(preview.body.total, 85000 + 140000);
    assert.equal(creates, 0);

    kiotviet.createSaleDocument = real.createSaleDocument;
    const invoice = await kiotviet.createSaleDocument({
      documentType: 'invoice',
      customerName: 'Nguyễn Lan',
      phone: '0901234567',
      customerId: 7,
      customerCode: 'KH000123',
      lines: [
        { sku: 'SP-XX', product_name: 'Xúc xích', quantity: 1 },
        { sku: 'SP-LX', product_name: 'Lạp xưởng', quantity: 2 },
      ],
    });
    assert.equal(invoice.ok, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].data.invoiceDetails.length, 2);
    assert.deepEqual(posts[0].data.invoiceDetails.map(row => row.productCode), ['SP-XX', 'SP-LX']);
    assert.equal(posts[0].data.invoiceDetails[1].quantity, 2);
    assert.equal(invoice.total, 85000 + 140000);
    assert.equal(posts[0].data.orderDetails, undefined);

    const orderBody = kiotviet.salePayload({
      kind: 'order',
      branchId: 26947,
      customerId: 7,
      customerName: 'Nguyễn Lan',
      phone: '0901234567',
      discount: 0,
      shippingFee: 0,
      description: '',
      details: posts[0].data.invoiceDetails,
    });
    assert.equal(orderBody.orderDetails.length, 2);
    assert.equal(orderBody.invoiceDetails, undefined);
  } finally {
    restoreMocks();
  }
});

test('the public invoice page, image header, and VietQR use every line and the summed total', async () => {
  const items = [
    { name: 'Xúc xích', quantity: 1, price: 85000, amount: 85000 },
    { name: 'Nước nghệ lên men', quantity: 2, price: 95000, amount: 190000 },
    { name: 'Lạp xưởng', quantity: 1, price: 70000, amount: 70000 },
  ];
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  assert.equal(total, 345000);
  const row = {
    code: 'HD011800',
    created_at: '2026-09-25T08:15:00.000Z',
    customer_name: 'Nguyễn Lan',
    customer_code: 'KH000123',
    customer_phone: '0901234567',
    items,
    total,
    amount_paid: 0,
  };
  const html = invoiceImage.pageHtml(row, '/hd/HD011800/anh?t=token');
  const idRow = html.slice(html.indexOf('<div class="id-row">'), html.indexOf('</div>'));
  assert.equal((html.match(/class="id-row"/g) || []).length, 1);
  assert.match(idRow, /class="id-name">Nguyễn Lan</);
  assert.match(idRow, /title="Mã KH">KH000123</);
  assert.match(idRow, /title="Mã HĐ">HD011800</);
  assert.match(html, /\.id-name \{[^}]*font-size:\s*22px/);
  assert.match(html, /\.id-name \{[^}]*font-weight:\s*700/);
  assert.match(html, /\.id-code \{[^}]*font-size:\s*15px/);
  assert.match(html, /Xúc xích × 1/);
  assert.match(html, /Nước nghệ lên men × 2/);
  assert.match(html, /Lạp xưởng × 1/);
  assert.match(html, /Tổng 345\.000đ/);
  const payload = emvco.buildPayload({ amount: total, addInfo: 'HD011800' });
  assert.equal(emvco.valid(payload), true);
  assert.ok(payload.includes('345000'));

  const png = await invoiceImage.render(row);
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  const slots = invoiceImage.layoutHeader(
    require('pureimage').make(invoiceImage.WIDTH, 10).getContext('2d'),
    row,
    invoiceImage.WIDTH,
  );
  assert.equal(slots.name.y, slots.kh.y);
  assert.equal(slots.kh.y, slots.hd.y);
  assert.equal(slots.name.font, '22px NotoBold');
  assert.equal(slots.kh.font, slots.hd.font);

  const review = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  assert.match(review, /kiotLines\.chooseProduct/);
  assert.match(review, /kiotLines\.applyQuick/);
  assert.match(review, /kiotLines\.addLine/);
  assert.match(review, /kiotLines\.removeLine/);
  assert.match(review, /\+ Thêm sản phẩm/);
  assert.match(review, /text: 'Thêm dòng'/);
  assert.match(review, /s\.kiot = window\.kiotLines\.snapshot/);
  assert.match(review, /window\.kiotLines\.restore/);
  const list = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'invoices.js'), 'utf8');
  assert.match(list, /row\.items/);
  assert.match(list, /className = 'lines'/);
});
