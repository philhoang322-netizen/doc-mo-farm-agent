/**
 * Queue badges use the same filter as the list, and both sides share one
 * newest-first order.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-queue-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../services/drafts');
const order = require('../public/admin/inbox-order');

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function seed(extra) {
  await pause(5);
  return drafts.createDraft(Object.assign({
    channel: 'zalo',
    customer_name: 'Khách',
    customer_query: 'alo',
    draft_reply: 'Dạ em nghe ạ',
    triage_level: 'normal',
    biz_line: 'sale',
  }, extra || {}));
}

test('group counts stay full for every tab and match the list', async () => {
  const zaloPending = await seed({
    customer_user_id: 'z_pending',
    triage_level: 'normal',
  });
  const zaloSent = await seed({
    customer_user_id: 'z_sent',
    triage_level: 'hot',
  });
  await drafts.setInboxStatus(zaloSent.id, 'sent', { actor: 'manager:Phước', auto: false });
  const fbHot = await seed({
    channel: 'messenger',
    biz_line: 'sale',
    customer_user_id: 'fb_hot',
    triage_level: 'hot',
    customer_query: 'mua thit',
  });
  const fbNormal = await seed({
    channel: 'messenger',
    biz_line: 'sale',
    customer_user_id: 'fb_normal',
    triage_level: 'normal',
    customer_query: 'gia rau',
  });
  const fbDv = await seed({
    channel: 'messenger',
    biz_line: 'dv',
    customer_user_id: 'fb_dv',
    triage_level: 'urgent',
    customer_query: 'dat phong',
  });
  await seed({
    customer_user_id: 'z_gone',
    triage_level: 'normal',
  }).then(d => drafts.softDelete(d.id, { actor: 'manager:Phước' }));

  const asZalo = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo' });
  const asFb = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'fb-sale' });
  assert.deepEqual(asZalo.groupCounts, asFb.groupCounts);
  assert.equal(asZalo.groupCounts.zalo, 2);
  assert.equal(asZalo.groupCounts.fbSale, 2);
  assert.equal(asZalo.groupCounts.fbDv, 1);
  assert.equal(asZalo.drafts.length, asZalo.groupCounts.zalo);
  assert.ok(asZalo.drafts.every(d => d.channel === 'zalo' && !d.deleted_at));
  assert.equal(asFb.drafts.length, asFb.groupCounts.fbSale);
  assert.deepEqual(asFb.drafts.map(d => d.id).sort(), [fbHot.id, fbNormal.id].sort());

  const pendingZalo = await drafts.listDrafts({
    salesChannel: 'farm', nhom: 'zalo', hop: 'pending',
  });
  const pendingFb = await drafts.listDrafts({
    salesChannel: 'farm', nhom: 'fb-sale', hop: 'pending', triage: 'hot',
  });
  assert.deepEqual(pendingZalo.groupCounts, pendingFb.groupCounts);
  assert.equal(pendingZalo.groupCounts.zalo, 1);
  assert.equal(pendingZalo.drafts.length, 1);
  assert.equal(pendingZalo.drafts[0].id, zaloPending.id);
  assert.equal(pendingFb.groupCounts.fbSale, 2);
  assert.equal(pendingFb.drafts.length, 1);
  assert.equal(pendingFb.drafts[0].id, fbHot.id);

  assert.equal(pendingZalo.triageCounts.normal, 1);
  assert.equal(pendingZalo.triageCounts.hot, 0);
  assert.equal(pendingFb.triageCounts.hot, 1);
  assert.equal(pendingFb.triageCounts.normal, 1);
  assert.equal(pendingFb.triageCounts.urgent, 0);
  assert.equal(pendingFb.drafts.length, pendingFb.triageCounts.hot);

  const typed = await drafts.listDrafts({
    salesChannel: 'farm', nhom: 'zalo', hop: 'pending', type: 'follower',
  });
  assert.deepEqual(typed.groupCounts, pendingZalo.groupCounts);
  assert.equal(typed.drafts.length, 0);

  const deleted = await drafts.listDrafts({
    salesChannel: 'farm', nhom: 'zalo', hop: 'deleted',
  });
  assert.equal(deleted.drafts.length, deleted.groupCounts.zalo);
  assert.equal(deleted.groupCounts.zalo, 1);
  assert.equal(deleted.drafts.some(d => d.id === zaloPending.id), false);
  assert.equal(fbDv.biz_line, 'dv');
});

test('newest customer message is first, with id as the tie-break', () => {
  const older = { id: 'id-a', created_at: '2026-09-01T00:00:00.000Z' };
  const newer = { id: 'id-b', created_at: '2026-09-02T00:00:00.000Z' };
  const received = {
    id: 'id-c',
    created_at: '2026-08-01T00:00:00.000Z',
    source_received_at: '2026-09-03T00:00:00.000Z',
  };
  const tieLow = { id: 'id-a', created_at: '2026-09-02T00:00:00.000Z' };
  const tieHigh = { id: 'id-b', created_at: '2026-09-02T00:00:00.000Z' };
  assert.equal(order.compare(tieLow, tieHigh), 1);
  assert.equal(order.compare(tieHigh, tieLow), -1);
  assert.equal(order.compare(tieLow, { ...tieLow }), 0);
  assert.deepEqual(
    order.sort([older, newer, received]).map(d => d.id),
    ['id-c', 'id-b', 'id-a']
  );
  assert.deepEqual(order.sort([tieLow, tieHigh]).map(d => d.id), ['id-b', 'id-a']);
  assert.equal(order.stamp(received), received.source_received_at + '\n' + received.id);
  assert.equal(order.stamp(older), older.created_at + '\n' + older.id);
});

test('the queue list uses that same order', async () => {
  const first = await seed({ customer_user_id: 'ord-1', customer_query: 'mot' });
  const second = await seed({ customer_user_id: 'ord-2', customer_query: 'hai' });
  const third = await seed({ customer_user_id: 'ord-3', customer_query: 'ba' });
  const listed = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  const ids = listed.drafts.map(d => d.id);
  const mine = [third.id, second.id, first.id];
  assert.deepEqual(ids.filter(id => mine.includes(id)), mine);
  const resorted = order.sort(listed.drafts.slice().reverse());
  assert.deepEqual(resorted.map(d => d.id), ids);
});

test('the default tab is the first group that has messages', () => {
  assert.equal(order.defaultGroup({ zalo: 0, fbSale: 30, fbDv: 0 }), 'fb-sale');
  assert.equal(order.defaultGroup({ zalo: 1, fbSale: 30, fbDv: 4 }), 'zalo');
  assert.equal(order.defaultGroup({ zalo: 0, fbSale: 30, fbDv: 4 }, { 'fb-sale': true }), 'fb-dv');
  assert.equal(order.defaultGroup({ zalo: 0, fbSale: 0, fbDv: 0 }), 'zalo');
  assert.equal(order.defaultGroup({ zalo: 1, fbSale: 2, fbDv: 3 }, { zalo: true }), 'fb-sale');
});
