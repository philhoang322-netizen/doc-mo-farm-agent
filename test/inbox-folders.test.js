/**
 * Inbox folders: manual moves, 24h Do dự, new message back to Chờ xử lý,
 * Đã mua is not undone, Từ chối is never automatic.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-folders-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.INBOX_HESITANT_HOURS = '24';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../services/drafts');
const audit = require('../services/audit');
const inboxStatus = require('../services/inboxStatus');

async function seed(extra) {
  return drafts.createDraft(Object.assign({
    channel: 'messenger',
    customer_name: 'Lan',
    customer_user_id: 'fb_lan',
    customer_query: 'xin chao',
    draft_reply: 'Dạ farm nghe ạ',
  }, extra || {}));
}

test('backfill files an unfiled sent draft as Đã gửi and a Kiot code as Đã mua', async () => {
  assert.equal(inboxStatus.inferFolder({ approval_status: 'SENT' }), 'sent');
  assert.equal(inboxStatus.inferFolder({ invoice_code: 'HD011700', approval_status: 'PENDING_REVIEW' }), 'bought');
  assert.equal(inboxStatus.inferFolder({ approval_status: 'PENDING_REVIEW' }), 'pending');
  const sent = await seed({ customer_user_id: 'fb_sent', customer_query: 'gia thit' });
  await drafts.setInboxStatus(sent.id, 'sent', { actor: 'system', auto: true });
  const sentList = await drafts.listDrafts({ salesChannel: 'farm', hop: 'sent' });
  assert.ok(sentList.drafts.some(d => d.id === sent.id));
  assert.equal(sentList.folderCounts.sent >= 1, true);
});

test('manual Do dự, Từ chối, and return are audited', async () => {
  const d = await seed({ customer_user_id: 'fb_manual', customer_query: 'hoi gia' });
  const moved = await drafts.setInboxStatus(d.id, 'hesitant', { actor: 'manager:Phước', auto: false });
  assert.equal(moved.inbox_status, 'hesitant');
  const logs = await audit.list({ entity_id: d.id, action: 'draft.inbox_status' });
  const row = logs.logs.find(item => item.after && item.after.inbox_status === 'hesitant');
  assert.ok(row);
  assert.equal(row.actor, 'manager:Phước');
  assert.equal(row.meta.auto, false);
  assert.equal(row.meta.from, 'pending');
  assert.equal(row.meta.to, 'hesitant');
  const back = await drafts.setInboxStatus(d.id, 'pending', { actor: 'manager:Phước', auto: false });
  assert.equal(back.inbox_status, 'pending');
  const declined = await drafts.setInboxStatus(d.id, 'declined', { actor: 'manager:Phước', auto: false });
  assert.equal(declined.inbox_status, 'declined');
});

test('24h in Đã gửi with no order becomes Do dự, and a refusal hint does not', async () => {
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const d = await seed({ customer_user_id: 'fb_wait', customer_query: 'cam on' });
  await drafts.setInboxStatus(d.id, 'sent', { actor: 'system', auto: true, at: old });
  const listed = await drafts.listDrafts({ salesChannel: 'farm', hop: 'hesitant' });
  const found = listed.drafts.find(item => item.id === d.id);
  assert.ok(found, 'moved to Do dự');
  const logs = await audit.list({ entity_id: d.id, action: 'draft.inbox_status' });
  const auto = logs.logs.find(item => item.meta && item.meta.to === 'hesitant' && item.meta.auto === true);
  assert.ok(auto);

  const no = await seed({ customer_user_id: 'fb_no', customer_query: 'thoi khoi khong mua nua' });
  const still = await drafts.getDraft(no.id);
  assert.equal(still.inbox_status, 'pending');
  assert.equal(still.decline_hint, true);
  assert.equal(inboxStatus.suggestDecline(still), true);
});

test('a new customer message returns to Chờ xử lý and keeps Đã mua', async () => {
  const first = await seed({ customer_user_id: 'fb_back', customer_query: 'dat phong homestay' });
  await drafts.setInboxStatus(first.id, 'hesitant', { actor: 'manager:Phước', auto: false });
  const again = await seed({ customer_user_id: 'fb_back', customer_query: 'mai minh o lai nhe' });
  assert.equal(again.inbox_status, 'pending');
  assert.equal(again.inbox_prev_status, 'hesitant');
  assert.equal((await drafts.getDraft(first.id)).inbox_status, 'hesitant');

  const order = await seed({ customer_user_id: 'fb_keep', customer_query: 'mua thit heo' });
  await drafts.setInboxStatus(order.id, 'bought', { actor: 'system', auto: true, orderCode: 'HD9' });
  const later = await seed({ customer_user_id: 'fb_keep', customer_query: 'mai giao nhe' });
  assert.equal(later.inbox_status, 'pending');
  assert.equal(later.inbox_prev_status, 'bought');
  const kept = await drafts.getDraft(order.id);
  assert.equal(kept.inbox_status, 'bought');
  assert.equal(kept.invoice_code, 'HD9');
});

test('a finalized delete is gone from every folder', async () => {
  const d = await seed({ customer_user_id: 'fb_del', customer_query: 'alo' });
  await drafts.hardDelete(d.id, { actor: 'manager:Phước' });
  for (const hop of ['pending', 'sent', 'bought', 'hesitant', 'declined']) {
    const listed = await drafts.listDrafts({ salesChannel: 'farm', hop });
    assert.equal(listed.drafts.some(item => item.id === d.id), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listed.folderCounts, 'deleted'), false);
  }
  await assert.rejects(
    () => drafts.listDrafts({ salesChannel: 'farm', hop: 'deleted' }),
    (err) => err && err.status === 400
  );
  assert.equal(await drafts.getDraft(d.id), null);
});

test('learn off is audited and stores no training pair', async () => {
  const d = await seed({ customer_user_id: 'fb_learn', customer_query: 'gia rau', draft_reply: 'Dạ em xem ạ' });
  const sent = await drafts.updateDraft(d.id, {
    draft_reply: 'Dạ rau 20k ạ',
    send: true,
    learn: false,
    actor_name: 'Phước',
  });
  assert.equal(sent.learn, false);
  assert.equal(sent.learned, false);
  const training = require('../services/trainingLog');
  const rows = await training.listRecent();
  assert.equal(rows.some(row => row.draft_id === d.id), false);
  const logs = await audit.list({ entity_id: d.id, action: 'draft.approved' });
  assert.equal(logs.logs[0].meta.learning, 'off');
});
