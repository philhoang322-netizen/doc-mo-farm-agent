/**
 * Phone-keyed customer profile. A message phone and a KiotViet create
 * attach channel ids. The AI summary does not contain the phone.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cust-profile-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.CUSTOMER_LINKS_PATH = path.join(dir, 'customer_links.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
process.env.HITL_REQUIRE_APPROVAL = 'true';
delete process.env.HITL_ACK_MESSAGE;
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'nongsansachdn';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const links = require('../services/customerLink');
const kiotviet = require('../services/kiotviet');
const hitl = require('../services/hitlGate');
const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');

const real = {
  findCustomerByPhone: kiotviet.findCustomerByPhone,
  listInvoicesByCustomer: kiotviet.listInvoicesByCustomer,
};

let lookups = 0;

function stubKiot() {
  lookups = 0;
  kiotviet.findCustomerByPhone = async () => {
    lookups += 1;
    return { id: 44, name: 'Tran Thi Be', contactNumber: '0903334455' };
  };
  kiotviet.listInvoicesByCustomer = async () => ([
    { code: 'HD000123', purchaseDate: '2026-08-01T02:00:00Z', total: 120000, totalPayment: 0, status: 1 },
    { code: 'HD000100', purchaseDate: '2026-07-01T02:00:00Z', total: 80000, totalPayment: 80000, status: 1 },
    { code: 'HD000099', purchaseDate: '2026-06-01T02:00:00Z', total: 50000, totalPayment: 0, status: 2 },
  ]);
}

function restoreKiot() {
  kiotviet.findCustomerByPhone = real.findCustomerByPhone;
  kiotviet.listInvoicesByCustomer = real.listInvoicesByCustomer;
}

test('a phone links Zalo and Facebook, and history stays out of the prompt', async () => {
  assert.deepEqual(links.phonesIn('Chị 0903 334 455 nha'), ['0903334455']);
  assert.deepEqual(links.phonesIn('goi +84 901 222 333'), ['0901222333']);

  const zalo = await links.note({
    phone: '0903.334.455',
    name: 'Chị Hoa',
    channel: 'zalo',
    userId: 'zalo-user-9',
  });
  const both = await links.note({
    phone: '0903334455',
    name: 'Chị Hoa',
    channel: 'messenger',
    userId: 'fb_psid-9',
  });
  assert.equal(zalo.phone, '0903334455');
  assert.equal(both.zalo_user_id, 'zalo-user-9');
  assert.equal(both.facebook_psid, 'psid-9');
  assert.deepEqual(links.present(both).channels.sort(), ['messenger', 'zalo']);

  await links.note({ phone: '0911222333', channel: 'zalo', userId: 'zalo-user-9' });
  const moved = await links.forDraft({ channel: 'zalo', customer_user_id: 'zalo-user-9' });
  assert.equal(moved.phone, '0911222333');
  const left = await links.forDraft({ channel: 'zalo', customer_phone: '0903334455' });
  assert.equal(left.zalo_user_id, null);
  assert.equal(left.facebook_psid, 'psid-9');

  const unlinked = await links.unlink({ phone: '0903334455', channel: 'messenger' });
  assert.equal(unlinked.facebook_psid, null);

  stubKiot();
  links.clearCache();
  try {
    const first = await links.purchaseHistory('0903334455');
    const second = await links.purchaseHistory('0903 334 455');
    assert.equal(lookups, 1);
    assert.equal(first.total_spent, 200000);
    assert.equal(first.unpaid_count, 1);
    assert.equal(first.last_purchase, '2026-08-01');
    assert.equal(second.orders.length, 2);
    assert.equal(first.orders.some(order => order.code === 'HD000099'), false);

    const prompt = await links.promptContext({
      externalId: 'zalo-user-9',
      name: 'Tran Thi Be',
      text: 'lấy lại như lần trước',
    });
    assert.match(prompt, /200000đ/);
    assert.equal(prompt.includes('0903334455'), false);
    assert.equal(prompt.includes('Tran Thi Be'), false);
    assert.equal(prompt.includes('0911222333'), false);
  } finally {
    restoreKiot();
    links.clearCache();
  }
});

test('a held reply records the phone and does not send', async () => {
  let sent = 0;
  const result = await hitl.releaseToCustomer({
    channel: 'oa',
    replyTo: 'zalo-hoa',
    externalKey: 'zalo-hoa',
    text: 'Số của chị 0903 334 455',
    senderName: 'Chị Hoa',
    send: async () => { sent += 1; return true; },
    log: () => {},
  }, 'Dạ em ghi số rồi ạ', { handover: false });
  assert.equal(result.held, true);
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
  assert.equal(result.draft.approval_status, 'PENDING_REVIEW');
  assert.equal(result.draft.customer_phone, '0903334455');
  const row = await links.forDraft(result.draft);
  assert.equal(row.zalo_user_id, 'zalo-hoa');
  assert.equal(row.phone, '0903334455');
});

test('the manager can link and unlink from the card API', async () => {
  const draft = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_psid-api',
    customer_name: 'Cô Mai',
    customer_query: 'Đặt phòng',
    draft_reply: 'Dạ ngày nào ạ',
  });
  const app = express();
  app.use(express.json());
  hitlAdmin.mount(app);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = {
    Authorization: 'Basic ' + Buffer.from('farm:secret').toString('base64'),
    'Content-Type': 'application/json',
  };
  stubKiot();
  links.clearCache();
  try {
    const linked = await fetch(base + '/admin/api/customers/link', {
      method: 'POST',
      headers,
      body: JSON.stringify({ draft_id: draft.id, phone: '0988 776 655', name: 'Cô Mai' }),
    });
    const body = await linked.json();
    assert.equal(linked.status, 200);
    assert.equal(body.profile.phone, '0988776655');
    assert.ok(body.profile.channels.includes('messenger'));
    assert.equal(JSON.stringify(body).includes('test-secret'), false);
    assert.equal(body.history.total_spent, 200000);

    const card = await fetch(base + '/admin/api/drafts/' + draft.id + '/customer', { headers });
    const shown = await card.json();
    assert.equal(card.status, 200);
    assert.equal(shown.profile.phone, '0988776655');
    assert.equal(shown.history.unpaid_count, 1);

    const off = await fetch(base + '/admin/api/customers/unlink', {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: '0988776655', channel: 'messenger' }),
    });
    const removed = await off.json();
    assert.equal(off.status, 200);
    assert.equal(removed.profile.channels.includes('messenger'), false);

    const saved = await drafts.getDraft(draft.id);
    assert.equal(saved.customer_phone, '0988776655');
    assert.equal(saved.approval_status, 'PENDING_REVIEW');
  } finally {
    restoreKiot();
    links.clearCache();
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
