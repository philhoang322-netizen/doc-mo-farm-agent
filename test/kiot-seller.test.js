/**
 * KiotViet seller and branch on invoice/order create.
 * Directory responses are mocked. No live retailer calls.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiot-seller-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'demo-shop';
delete process.env.KIOTVIET_SOLD_BY_ID;
delete process.env.KIOTVIET_BRANCH_ID;

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const kiotviet = require('../services/kiotviet');
const invoiceImage = require('../services/invoiceImage');

const real = {
  enabled: kiotviet.enabled,
  findProduct: kiotviet.findProduct,
  findOrCreateCustomer: kiotviet.findOrCreateCustomer,
  getCustomer: kiotviet.getCustomer,
  call: kiotviet.call,
};

const savedEnv = {
  sold: process.env.KIOTVIET_SOLD_BY_ID,
  branch: process.env.KIOTVIET_BRANCH_ID,
};

function restoreEnv() {
  if (savedEnv.sold == null) delete process.env.KIOTVIET_SOLD_BY_ID;
  else process.env.KIOTVIET_SOLD_BY_ID = savedEnv.sold;
  if (savedEnv.branch == null) delete process.env.KIOTVIET_BRANCH_ID;
  else process.env.KIOTVIET_BRANCH_ID = savedEnv.branch;
}

let routes;
let posts;

function install({ users, branches, usersError, branchesError } = {}) {
  posts = [];
  routes = { users, branches, usersError, branchesError };
  kiotviet.enabled = () => true;
  kiotviet.findProduct = async () => ({
    id: 1,
    code: 'SP-DEMO',
    name: 'Sản phẩm thử',
    fullName: 'Sản phẩm thử',
    basePrice: 10000,
  });
  kiotviet.findOrCreateCustomer = async () => ({ id: 4, code: 'KH0001', name: 'Khách Thử' });
  kiotviet.getCustomer = async () => ({ id: 4, code: 'KH0001', name: 'Khách Thử' });
  kiotviet.call = async (method, pathName, opts) => {
    if (pathName === '/users') {
      if (routes.usersError) throw routes.usersError;
      return { total: (routes.users || []).length, data: routes.users || [] };
    }
    if (pathName === '/branches') {
      if (routes.branchesError) throw routes.branchesError;
      return { total: (routes.branches || []).length, data: routes.branches || [] };
    }
    posts.push({ method, path: pathName, data: opts && opts.data });
    return { id: 9, code: pathName.includes('order') ? 'DH900001' : 'HD900001', total: 10000 };
  };
  kiotviet.clearSaleDirectoryCache();
}

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(part => String(part)).join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then(result => ({ result, lines }))
    .finally(() => { console.log = orig; });
}

async function createInvoice(extra) {
  return kiotviet.createSaleDocument({
    documentType: 'invoice',
    customerName: 'Khách Thử',
    phone: '0900000001',
    customerCode: 'KH0001',
    lines: [{ sku: 'SP-DEMO', product_name: 'Sản phẩm thử', quantity: 1 }],
    ...(extra || {}),
  });
}

beforeEach(() => {
  delete process.env.KIOTVIET_SOLD_BY_ID;
  delete process.env.KIOTVIET_BRANCH_ID;
  install({
    users: [
      { id: 11, givenName: 'Người Thử Không Ghi Log', userName: 'thu1' },
      { id: 22, givenName: 'Người Khác', userName: 'thu2' },
    ],
    branches: [
      { id: 3, branchName: 'Chi nhánh thử' },
      { id: 9, branchName: 'Chi nhánh khác' },
    ],
  });
});

after(() => {
  kiotviet.enabled = real.enabled;
  kiotviet.findProduct = real.findProduct;
  kiotviet.findOrCreateCustomer = real.findOrCreateCustomer;
  kiotviet.getCustomer = real.getCustomer;
  kiotviet.call = real.call;
  kiotviet.clearSaleDirectoryCache();
  restoreEnv();
});

test('sale branch helper still defaults to 26947 for stock reads', () => {
  delete process.env.KIOTVIET_BRANCH_ID;
  assert.equal(kiotviet.saleBranchId(), 26947);
});

test('KIOTVIET_SOLD_BY_ID is sent when GET /users lists it', async () => {
  process.env.KIOTVIET_SOLD_BY_ID = '22';
  const { result, lines } = await captureLogs(() => createInvoice());
  assert.equal(result.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data.soldById, 22);
  assert.equal(lines.some(line => line.includes('seller fallback')), false);
  assert.equal(lines.join('\n').includes('Người'), false);
});

test('a missing or unknown seller id falls back to the first user', async () => {
  const unset = await captureLogs(() => createInvoice());
  assert.equal(unset.result.ok, true);
  assert.equal(posts[0].data.soldById, 11);
  assert.match(unset.lines.join('\n'), /KiotViet seller fallback id=11 env=unset/);
  assert.equal(unset.lines.join('\n').includes('Người Thử'), false);

  posts = [];
  process.env.KIOTVIET_SOLD_BY_ID = '999';
  const missing = await captureLogs(() => createInvoice());
  assert.equal(missing.result.ok, true);
  assert.equal(posts[0].data.soldById, 11);
  assert.match(missing.lines.join('\n'), /KiotViet seller fallback id=11 env=999/);

  posts = [];
  process.env.KIOTVIET_SOLD_BY_ID = 'not-an-id';
  const invalid = await captureLogs(() => createInvoice());
  assert.equal(posts[0].data.soldById, 11);
  assert.match(invalid.lines.join('\n'), /KiotViet seller fallback id=11 env=invalid/);
  assert.equal(invalid.lines.join('\n').includes('not-an-id'), false);
});

test('GET /users is cached for about an hour', async () => {
  let userCalls = 0;
  kiotviet.call = async (method, pathName, opts) => {
    if (pathName === '/users') {
      userCalls += 1;
      return { data: [{ id: 11 }, { id: 22 }] };
    }
    if (pathName === '/branches') return { data: [{ id: 3 }] };
    posts.push({ method, path: pathName, data: opts && opts.data });
    return { id: 9, code: 'HD900001', total: 10000 };
  };
  kiotviet.clearSaleDirectoryCache();
  process.env.KIOTVIET_SOLD_BY_ID = '22';
  const first = await kiotviet.resolveSoldBy();
  delete process.env.KIOTVIET_SOLD_BY_ID;
  const second = await kiotviet.resolveSoldBy();
  assert.equal(first.soldById, 22);
  assert.equal(first.source, 'env');
  assert.equal(second.soldById, 11);
  assert.equal(second.source, 'fallback');
  assert.equal(userCalls, 1);
});

test('a failed user lookup omits soldById because the Public API allows it', async () => {
  install({
    usersError: new Error('KiotViet timeout'),
    branches: [{ id: 3, branchName: 'Chi nhánh thử' }],
  });
  const { result, lines } = await captureLogs(() => createInvoice());
  assert.equal(result.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(posts[0].data, 'soldById'), false);
  assert.match(lines.join('\n'), /KiotViet seller omitted/);
  assert.equal(lines.join('\n').includes('timeout'), false);
});

test('an empty user list also omits the seller', async () => {
  install({ users: [], branches: [{ id: 3 }] });
  const created = await createInvoice();
  assert.equal(created.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(posts[0].data, 'soldById'), false);
});

test('KIOTVIET_BRANCH_ID is used when GET /branches lists it, else the first branch', async () => {
  process.env.KIOTVIET_BRANCH_ID = '9';
  const listed = await captureLogs(() => createInvoice());
  assert.equal(listed.result.ok, true);
  assert.equal(listed.result.branchId, 9);
  assert.equal(posts[0].data.branchId, 9);
  assert.equal(listed.lines.some(line => line.includes('branch fallback')), false);
  assert.equal(listed.lines.join('\n').includes('Chi nhánh'), false);

  posts = [];
  process.env.KIOTVIET_BRANCH_ID = '26947';
  const stale = await captureLogs(() => createInvoice());
  assert.equal(stale.result.branchId, 3);
  assert.equal(posts[0].data.branchId, 3);
  assert.match(stale.lines.join('\n'), /KiotViet branch fallback id=3 env=26947/);

  posts = [];
  delete process.env.KIOTVIET_BRANCH_ID;
  const unset = await captureLogs(() => createInvoice());
  assert.equal(unset.result.branchId, 3);
  assert.match(unset.lines.join('\n'), /KiotViet branch fallback id=3 env=unset/);
});

test('a failed branch lookup shows a Vietnamese error and does not post', async () => {
  install({
    users: [{ id: 11 }],
    branchesError: new Error('down'),
  });
  const created = await createInvoice();
  assert.equal(created.ok, false);
  assert.equal(created.error, kiotviet.BRANCH_UNKNOWN_ERROR);
  assert.match(created.error, /chi nhánh/);
  assert.equal(posts.length, 0);

  install({ users: [{ id: 11 }], branches: [] });
  const empty = await createInvoice();
  assert.equal(empty.ok, false);
  assert.equal(empty.error, kiotviet.BRANCH_UNKNOWN_ERROR);
  assert.equal(posts.length, 0);
});

test('order create carries the same seller and branch', async () => {
  process.env.KIOTVIET_SOLD_BY_ID = '22';
  process.env.KIOTVIET_BRANCH_ID = '9';
  const created = await kiotviet.createSaleDocument({
    documentType: 'order',
    customerName: 'Khách Thử',
    phone: '0900000001',
    customerCode: 'KH0001',
    lines: [{ sku: 'SP-DEMO', product_name: 'Sản phẩm thử', quantity: 1 }],
  });
  assert.equal(created.ok, true);
  assert.equal(posts[0].path, '/orders');
  assert.equal(posts[0].data.soldById, 22);
  assert.equal(posts[0].data.branchId, 9);
  assert.equal(posts[0].data.invoiceDetails, undefined);
});

test('salePayload drops an empty seller instead of sending null', () => {
  const body = kiotviet.salePayload({
    kind: 'invoice',
    branchId: 3,
    soldById: null,
    customerId: 4,
    details: [],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'soldById'), false);
  const withSeller = kiotviet.salePayload({
    kind: 'invoice',
    branchId: 3,
    soldById: 11,
    customerId: 4,
    details: [],
  });
  assert.equal(withSeller.soldById, 11);
});

test('invoice renderer output has no stock text', () => {
  const row = {
    code: 'HD900001',
    created_at: '2026-09-26T03:00:00.000Z',
    customer_name: 'Khách Thử',
    customer_phone: '0900000001',
    customer_code: 'KH0001',
    items: [{
      name: 'Sản phẩm thử',
      quantity: 1,
      price: 185000,
      amount: 185000,
      available: 171,
      stock: { level: 'ok', available: 171 },
    }],
    total: 185000,
    amount_paid: 0,
    delivery_address: '12 Đường Thử',
  };
  const page = invoiceImage.pageHtml(row, '/hd/HD900001/anh?t=token');
  const lines = invoiceImage.linesHtml(row);
  const header = invoiceImage.headerHtml(row);
  const combined = `${page}\n${lines}\n${header}`;
  assert.doesNotMatch(combined, /Còn Kho/);
  assert.doesNotMatch(combined, /tồn kho/i);
  assert.doesNotMatch(combined, /Còn 171/);
  assert.doesNotMatch(combined, /\b171\b/);
  assert.match(page, /Sản phẩm thử/);
  assert.match(page, /Tổng 185\.000đ/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoiceImage.js'), 'utf8');
  assert.doesNotMatch(src, /Còn Kho/);
});

test('the review box shows Mã KH on one customer row and Còn Kho for stock', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  assert.match(js, /Mã KH: chưa có/);
  assert.match(js, /Mã KH: ' \+ code/);
  assert.match(js, /class: 'kiot-who'/);
  assert.match(js, /return 'Còn Kho ' \+ stock\.available/);
  assert.doesNotMatch(js, /return 'Còn ' \+ stock\.available/);
});
