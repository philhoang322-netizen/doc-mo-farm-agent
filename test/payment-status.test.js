/**
 * Payment chip: Chưa TT / Đã TT, no deposit, VAT already in the price.
 * KiotViet is stubbed. Nothing is created on the real retailer.
 */
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'nongsansachdn';
delete process.env.KIOTVIET_ACCOUNT_ID;

const test = require('node:test');
const assert = require('node:assert/strict');

const kiotviet = require('../services/kiotviet');
const invoices = require('../services/invoices');
const invoiceImage = require('../services/invoiceImage');
const audit = require('../services/audit');
const payToggle = require('../public/admin/pay-toggle');

const root = path.join(__dirname, '..');
const reviewJs = fs.readFileSync(path.join(root, 'public', 'admin', 'review.js'), 'utf8');
const invoicesJs = fs.readFileSync(path.join(root, 'public', 'admin', 'invoices.js'), 'utf8');
const invoicesHtml = fs.readFileSync(path.join(root, 'public', 'admin', 'invoices.html'), 'utf8');
const kiotSrc = fs.readFileSync(path.join(root, 'services', 'kiotviet.js'), 'utf8');

const sample = {
  code: 'HD011637',
  created_at: '2026-09-25T03:00:00.000Z',
  customer_name: 'Chị Lan',
  customer_phone: '0901234567',
  customer_code: 'KH000123',
  items: [{ name: 'Xúc xích heo', quantity: 1, price: 265000, amount: 265000 }],
  total: 265000,
  amount_paid: 0,
  payment_status: 'chua_tt',
};

function calls() {
  const posted = [];
  const real = { call: kiotviet.call, enabled: kiotviet.enabled, readInvoicePayment: kiotviet.readInvoicePayment };
  kiotviet.enabled = () => true;
  kiotviet.call = async (method, apiPath, opts) => {
    posted.push({ method, path: apiPath, data: opts && opts.data });
    return {
      paymentId: 42,
      paymentCode: 'PT42',
      amount: opts && opts.data && opts.data.amount,
      method: opts && opts.data && opts.data.method,
      invoiceId: opts && opts.data && opts.data.invoiceId,
    };
  };
  kiotviet.readInvoicePayment = async () => {
    const last = posted.filter(row => row.path === '/payments').pop();
    return {
      ok: true,
      amount_paid: last ? last.data.amount : 0,
      payment_method: last && last.data.method === 'Cash' ? 'cash' : 'transfer',
      total: last ? last.data.amount : 0,
    };
  };
  return {
    posted,
    restore() {
      kiotviet.call = real.call;
      kiotviet.enabled = real.enabled;
      kiotviet.readInvoicePayment = real.readInvoicePayment;
    },
  };
}

test('orders send no deposit; a paid invoice sends totalPayment and method', () => {
  const order = kiotviet.salePayload({
    kind: 'order', branchId: 1, customerId: 2, details: [], paid: true, paymentMethod: 'cash', total: 100000,
  });
  assert.equal(order.totalPayment, 0);
  assert.equal(order.method, 'Transfer');
  assert.equal(order.payments, undefined);

  const paid = kiotviet.salePayload({
    kind: 'invoice', branchId: 1, customerId: 2, details: [], paid: true, paymentMethod: 'cash', total: 100000,
  });
  assert.equal(paid.totalPayment, 100000);
  assert.equal(paid.method, 'Cash');
  assert.equal(paid.payments, undefined);

  const transfer = kiotviet.salePayload({
    kind: 'invoice', branchId: 1, customerId: 2, details: [], paid: true, paymentMethod: 'transfer', total: 85000,
  });
  assert.equal(transfer.totalPayment, 85000);
  assert.equal(transfer.method, 'Transfer');
  assert.equal(transfer.accountId, undefined);
  process.env.KIOTVIET_ACCOUNT_ID = '321';
  try {
    const withAccount = kiotviet.invoicePaymentFields(true, 'transfer', 85000);
    assert.equal(withAccount.method, 'Transfer');
    assert.equal(withAccount.accountId, 321);
    assert.equal(withAccount.totalPayment, 85000);
    const cashFields = kiotviet.invoicePaymentFields(true, 'cash', 85000);
    assert.equal(cashFields.method, 'Cash');
    assert.equal(cashFields.accountId, undefined);
    const orderFields = kiotviet.salePayload({
      kind: 'order', branchId: 1, customerId: 2, details: [], paid: true, paymentMethod: 'transfer', total: 85000,
    });
    assert.equal(orderFields.totalPayment, 0);
    assert.equal(orderFields.accountId, undefined);
  } finally {
    delete process.env.KIOTVIET_ACCOUNT_ID;
  }

  const unpaid = kiotviet.salePayload({
    kind: 'invoice', branchId: 1, customerId: 2, details: [], paid: false, total: 85000,
  });
  assert.equal(unpaid.totalPayment, 0);
  assert.equal(unpaid.method, 'Transfer');

  const push = kiotSrc.slice(kiotSrc.indexOf('async function pushOrder'), kiotSrc.indexOf('\nasync function', kiotSrc.indexOf('async function pushOrder') + 10));
  assert.match(push, /totalPayment:\s*0/);
  assert.doesNotMatch(push, /totalPayment:\s*total/);
});

test('POST /payments collects an existing invoice; accountId only for a configured transfer', async () => {
  const stub = calls();
  try {
    const cash = await kiotviet.addInvoicePayment({ invoiceId: '77', amount: 85000, method: 'cash' });
    assert.equal(cash.ok, true);
    assert.equal(cash.paymentId, '42');
    assert.equal(stub.posted[0].method, 'post');
    assert.equal(stub.posted[0].path, '/payments');
    assert.deepEqual(stub.posted[0].data, { invoiceId: 77, amount: 85000, method: 'Cash' });

    process.env.KIOTVIET_ACCOUNT_ID = '1058437590';
    await kiotviet.addInvoicePayment({ invoiceId: 77, amount: 1000, method: 'transfer' });
    assert.equal(stub.posted[1].data.method, 'Transfer');
    assert.equal(stub.posted[1].data.accountId, 1058437590);
    delete process.env.KIOTVIET_ACCOUNT_ID;

    kiotviet.enabled = () => false;
    const skipped = await kiotviet.addInvoicePayment({ invoiceId: 77, amount: 1, method: 'transfer' });
    assert.equal(skipped.skipped, true);
    assert.equal(stub.posted.length, 2);
  } finally {
    delete process.env.KIOTVIET_ACCOUNT_ID;
    stub.restore();
  }
});

test('toggle stores payment, audits, and posts to Kiot once', async () => {
  invoices.resetForTests();
  const stub = calls();
  try {
    await invoices.recordSale({
      code: 'HD100',
      kiotId: '77',
      documentType: 'invoice',
      customerName: 'Chị Lan',
      customerCode: 'KH0009',
      total: 50000,
      items: [{ name: 'Xúc xích', quantity: 1, price: 50000, amount: 50000 }],
    });
    const first = await invoices.setPaymentStatus('HD100', { status: 'da_tt', method: 'transfer', actor: 'manager' });
    assert.equal(first.invoice.payment_status, 'da_tt');
    assert.equal(first.invoice.amount_paid, 50000);
    assert.equal(first.invoice.paid_by, 'manager');
    assert.equal(first.invoice.payment_method, 'transfer');
    assert.ok(first.invoice.paid_at);
    assert.equal(first.invoice.kiot_payment_id, '42');
    assert.equal(stub.posted.length, 1);
    assert.equal(stub.posted[0].data.amount, 50000);
    assert.equal(stub.posted[0].data.method, 'Transfer');

    const again = await invoices.setPaymentStatus('HD100', { status: 'da_tt', method: 'cash', actor: 'manager' });
    assert.equal(again.error, undefined);
    assert.equal(again.invoice.payment_method, 'transfer');
    assert.equal(again.invoice.kiot_payment_id, '42');
    assert.equal(stub.posted.length, 1);

    const off = await invoices.setPaymentStatus('HD100', { status: 'chua_tt', actor: 'manager' });
    assert.match(off.error, /phiếu thu/);
    assert.equal(off.invoice.payment_status, 'da_tt');
    assert.equal(off.invoice.payment_method, 'transfer');
    assert.equal(stub.posted.length, 1);

    await invoices.recordSale({
      code: 'DH100',
      kiotId: '55',
      documentType: 'order',
      customerName: 'Chị Lan',
      total: 50000,
      items: [{ name: 'Xúc xích', quantity: 1, price: 50000, amount: 50000 }],
    });
    const order = await invoices.setPaymentStatus('DH100', { status: 'da_tt', method: 'cash', actor: 'Phước' });
    assert.match(order.error, /Chưa có hoá đơn/);
    assert.equal(order.invoice.payment_status, 'chua_tt');
    assert.equal(stub.posted.length, 1);

    const storedOrder = await invoices.recordSale({
      code: 'DH200',
      documentType: 'order',
      total: 50000,
      paymentStatus: 'da_tt',
      paymentMethod: 'cash',
    });
    assert.equal(storedOrder.payment_status, 'chua_tt');
    assert.equal(storedOrder.amount_paid, 0);
    assert.equal(storedOrder.payment_method, null);

    await invoices.recordSale({
      code: 'HD101',
      kiotId: '78',
      documentType: 'invoice',
      customerName: 'Anh Minh',
      total: 180000,
      paymentStatus: 'da_tt',
      paymentMethod: 'cash',
      paidBy: 'manager',
      items: [{ name: 'Trứng', quantity: 1, price: 180000, amount: 180000 }],
    });

    const paidOnly = await invoices.search({ payment: 'da_tt' });
    assert.ok(paidOnly.some(row => row.code === 'HD100'));
    assert.ok(paidOnly.some(row => row.code === 'HD101'));
    assert.equal(paidOnly.some(row => row.code === 'DH100'), false);
    const cashOnly = await invoices.search({ payment: 'cash' });
    assert.ok(cashOnly.some(row => row.code === 'HD101' && row.payment_method === 'cash'));
    assert.equal(cashOnly.some(row => row.code === 'HD100'), false);
    const transferOnly = await invoices.search({ payment: 'transfer' });
    assert.ok(transferOnly.some(row => row.code === 'HD100' && row.payment_method === 'transfer'));
    const openOnly = await invoices.search({ payment: 'chua_tt' });
    assert.ok(openOnly.some(row => row.code === 'DH100'));
    assert.equal(openOnly.some(row => row.code === 'HD100'), false);
    const toggleLog = (await audit.list({ action: 'invoice.payment', entity_id: 'HD100' })).logs[0];
    assert.equal(toggleLog.actor, 'manager');
    assert.ok(toggleLog.at);
    assert.equal(toggleLog.after.payment_method, 'transfer');
    assert.equal(toggleLog.before.payment_method, null);
    assert.equal(toggleLog.meta.source, 'toggle');
    assert.equal(toggleLog.meta.kiot.method, 'Transfer');

    const mapped = kiotviet.paymentFromInvoice({
      total: 100000,
      totalPayment: 100000,
      payments: [{ method: 'Cash', amount: 40000 }, { method: 'Transfer', amount: 60000 }],
    });
    assert.equal(mapped.payment_status, 'da_tt');
    assert.equal(mapped.payment_method, 'mixed');
    const partial = kiotviet.paymentFromInvoice({
      total: 100000,
      totalPayment: 40000,
      payments: [{ method: 'Cash', amount: 40000 }],
    });
    assert.equal(partial.payment_status, 'mot_phan');
    assert.equal(partial.payment_method, 'cash');

    const csv = invoices.toCsv(await invoices.search({}));
    assert.match(csv, /paid_at,paid_by,method/);
    assert.match(csv, /Tiền mặt/);
    assert.match(csv, /Chuyển khoản/);
    assert.match(csv, /HD100/);
    assert.match(csv, /chua_tt/);

    const logs = await audit.list({ action: 'invoice.payment', entity_id: 'HD100' });
    assert.ok(logs.logs.length >= 1);
    assert.ok(logs.logs.some(row => row.meta && row.meta.source === 'toggle'));
  } finally {
    stub.restore();
  }
});

test('paid invoice page stamps ĐÃ THANH TOÁN and hides the VCB line', () => {
  const unpaid = invoiceImage.pageHtml(sample, '/hd/x.png');
  const idRow = unpaid.slice(unpaid.indexOf('<div class="id-row">'), unpaid.indexOf('</div>'));
  assert.equal((unpaid.match(/class="id-row"/g) || []).length, 1);
  assert.match(idRow, /<span class="id-name">Chị Lan<\/span>/);
  assert.match(idRow, /title="Mã KH">KH000123</);
  assert.match(idRow, /title="Mã HĐ">HD011637</);
  assert.doesNotMatch(idRow, /pay-chip|Chưa TT|Đã TT/);
  assert.match(unpaid, /Chưa TT/);
  assert.match(unpaid, /1058437590/);
  assert.doesNotMatch(unpaid, /ĐÃ THANH TOÁN/);
  assert.doesNotMatch(unpaid, /Giá đã gồm VAT/);
  assert.doesNotMatch(unpaid, /chưa gồm VAT/);

  const paid = invoiceImage.pageHtml({
    ...sample,
    payment_status: 'da_tt',
    amount_paid: 265000,
    payment_method: 'transfer',
  }, '/hd/x.png');
  const paidRow = paid.slice(paid.indexOf('<div class="id-row">'), paid.indexOf('</div>'));
  assert.equal((paid.match(/class="id-row"/g) || []).length, 1);
  assert.doesNotMatch(paidRow, /Đã TT/);
  assert.match(paid, /class="pay-chip is-paid">Đã TT · CK</);
  assert.match(paid, /ĐÃ THANH TOÁN/);
  assert.match(paid, /class="paid-method">Chuyển khoản</);
  assert.doesNotMatch(paid, /1058437590/);
  assert.doesNotMatch(paid, /nội dung CK/);
  assert.doesNotMatch(paid, /Giá đã gồm VAT/);

  const cashPage = invoiceImage.pageHtml({
    ...sample,
    payment_status: 'da_tt',
    amount_paid: 265000,
    payment_method: 'cash',
  }, '/hd/x.png');
  assert.match(cashPage, /Đã TT · Tiền mặt/);
  assert.match(cashPage, /class="paid-method">Tiền mặt</);
  assert.doesNotMatch(cashPage, /1058437590/);
  assert.doesNotMatch(cashPage, /Chuyển khoản/);

  const cardPage = invoiceImage.pageHtml({
    ...sample,
    payment_status: 'da_tt',
    amount_paid: 265000,
    payment_method: 'card',
  }, '/hd/x.png');
  assert.match(cardPage, /Đã TT · Thẻ/);
  assert.match(cardPage, /class="paid-method">Thẻ</);
});

test('header chip shares the row when it fits and drops to the next row when it does not', async () => {
  const unpaidPng = await invoiceImage.render(sample);
  assert.equal(unpaidPng.readUInt32BE(0), 0x89504e47);
  const paidPng = await invoiceImage.render({ ...sample, payment_status: 'da_tt', amount_paid: sample.total });
  assert.equal(paidPng.readUInt32BE(0), 0x89504e47);
  const ctx = require('pureimage').make(invoiceImage.WIDTH, 10).getContext('2d');
  const wide = invoiceImage.layoutHeader(ctx, sample, invoiceImage.WIDTH);
  assert.equal(wide.name.y, wide.kh.y);
  assert.equal(wide.kh.y, wide.hd.y);
  assert.equal(wide.pay.row, 1);
  assert.equal(wide.pay.y, 0);
  assert.equal(wide.pay.text, 'Chưa TT');
  assert.equal(invoiceImage.payMethodCaption(sample), '');

  const tight = invoiceImage.layoutHeader(ctx, {
    ...sample,
    customer_code: 'KH000123456789',
    payment_status: 'da_tt',
  }, 360);
  assert.equal(tight.name.y, tight.kh.y);
  assert.equal(tight.kh.y, tight.hd.y);
  assert.equal(tight.pay.row, 2);
  assert.equal(tight.pay.y, 28);
  assert.equal(tight.pay.text, 'Đã TT · CK');
  assert.equal(tight.pay.paid, true);
});

test('chip is one tap, 3 seconds, no confirm, and the list filter is wired', () => {
  assert.equal(payToggle.UNDO_MS, 3000);
  assert.equal(payToggle.needsConfirm(), false);
  const timers = [];
  let ran = 0;
  const job = payToggle.schedule('HD1', {
    timers: {
      set(fn) {
        const handle = { fn, cleared: false };
        timers.push(handle);
        return handle;
      },
      clear(handle) { handle.cleared = true; },
    },
    onFinalize() { ran += 1; },
  });
  assert.equal(job.undo(), true);
  timers[0].fn();
  assert.equal(ran, 0);

  assert.match(reviewJs, /Chưa TT/);
  assert.match(reviewJs, /Đã TT/);
  assert.match(reviewJs, /Hoàn tác/);
  assert.match(reviewJs, /payToggle/);
  assert.match(reviewJs, /committedPay\(d\)\.status/);
  assert.doesNotMatch(reviewJs, /Xuất hoá đơn để có mã QR/);
  const payFn = reviewJs.slice(reviewJs.indexOf('function schedulePay'), reviewJs.indexOf('function payControls'));
  assert.doesNotMatch(payFn, /confirm\(/);

  assert.match(invoicesJs, /Chưa TT/);
  assert.match(invoicesJs, /Đã TT/);
  assert.match(invoicesJs, /Hoàn tác/);
  assert.match(invoicesJs, /payToggle/);
  assert.match(invoicesJs, /pay-filter/);
  assert.doesNotMatch(invoicesJs, /Đánh dấu đã thanh toán/);
  assert.doesNotMatch(invoicesJs, /confirm\(/);
  assert.match(invoicesHtml, /Tất cả/);
  assert.match(invoicesHtml, /data-pay="chua_tt"/);
  assert.match(invoicesHtml, /Đã TT-Tiền mặt/);
  assert.match(invoicesHtml, /data-pay="cash"/);
  assert.match(invoicesHtml, /Đã TT-CK/);
  assert.match(invoicesHtml, /data-pay="transfer"/);
  assert.equal(payToggle.chipLabel('chua_tt', null), 'Chưa TT');
  assert.equal(payToggle.chipLabel('da_tt', 'cash'), 'Đã TT · Tiền mặt');
  assert.equal(payToggle.chipLabel('da_tt', 'transfer'), 'Đã TT · CK');
  assert.deepEqual(payToggle.choices('chua_tt').map(row => row.label), ['Tiền mặt', 'CK']);
  assert.deepEqual(payToggle.choices('mot_phan').map(row => row.label), ['Tiền mặt', 'CK']);
  assert.deepEqual(payToggle.choices('da_tt'), []);
  assert.equal(payToggle.chipLabel('mot_phan', 'cash', 20000), 'Còn nợ 20.000đ');
  assert.equal(payToggle.chipLabel('da_tt', 'card'), 'Đã TT · Thẻ');
  assert.equal(payToggle.needsConfirm(), false);
  const menuFn = reviewJs.slice(reviewJs.indexOf('function togglePayMenu'), reviewJs.indexOf('function payControls'));
  assert.doesNotMatch(menuFn, /confirm\(/);
  assert.match(reviewJs, /Đã TT · Tiền mặt|chipLabel/);
  assert.match(invoicesHtml, /pay-toggle\.js/);

  const imageSrc = fs.readFileSync(path.join(root, 'services', 'invoiceImage.js'), 'utf8');
  assert.match(imageSrc, /Giá đã gồm VAT/);
  assert.match(imageSrc, /ĐÃ THANH TOÁN/);
  assert.doesNotMatch(imageSrc, /chưa gồm VAT/);
});
