/**
 * Xóa tin này / Xóa cả cuộc chat.
 * Undo lives in the browser for 3 seconds. After that the row is gone,
 * the same source message does not come back, and a new message id does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const drafts = require('../services/drafts');
const audit = require('../services/audit');
const tombstones = require('../services/tombstones');
const undo = require('../public/admin/undo-delete');
const sendOnce = require('../public/admin/send-once');

const root = path.join(__dirname, '..');
const reviewJs = fs.readFileSync(path.join(root, 'public', 'admin', 'review.js'), 'utf8');
const reviewCss = fs.readFileSync(path.join(root, 'public', 'admin', 'review.css'), 'utf8');

function draftBody(extra) {
  return {
    channel: 'zalo',
    sales_channel: 'farm',
    customer_query: 'alo',
    draft_reply: 'Dạ ạ',
    biz_line: 'sale',
    ...extra,
  };
}

test('visible delete buttons, 3s undo, and Duyệt & Gửi have no confirm', () => {
  assert.match(reviewJs, /Xóa tin này/);
  assert.match(reviewJs, /Xóa cả cuộc chat/);
  assert.match(reviewJs, /label: 'Hoàn tác'/);
  assert.match(reviewJs, /undoDelete/);
  assert.match(reviewJs, /settledDeletes/);
  assert.equal(undo.UNDO_MS, 3000);
  assert.equal(undo.needsConfirm(), false);
  assert.equal(sendOnce.needsConfirm(), false);
  const menu = reviewJs.slice(reviewJs.indexOf('function moreMenu'), reviewJs.indexOf('function renderDetail'));
  assert.doesNotMatch(menu, /Xóa tin này|Xóa cả cuộc chat|deleteButtons/);
  const sendStart = reviewJs.indexOf('function send()');
  const sendFn = reviewJs.slice(sendStart, reviewJs.indexOf('\n  function ', sendStart + 10));
  assert.doesNotMatch(sendFn, /confirm\(/);
  assert.match(sendFn, /sendOnce/);
  assert.match(reviewCss, /\.card-delete \.card-del \{[^}]*min-height:\s*44px/s);
  const hard = fs.readFileSync(path.join(root, 'services', 'drafts.js'), 'utf8');
  const fn = hard.slice(hard.indexOf('async function hardDelete'), hard.indexOf('async function listThread'));
  assert.doesNotMatch(fn, /kiotviet|releaseToCustomer|sendMessage|sendText/);
});

test('undo within 3s cancels finalize; after 3s it runs', () => {
  const timers = [];
  const fake = {
    set(fn) {
      const handle = { fn, cleared: false };
      timers.push(handle);
      return handle;
    },
    clear(handle) { handle.cleared = true; },
  };
  let ran = 0;
  const job = undo.schedule('a', {
    ms: undo.UNDO_MS,
    timers: fake,
    onFinalize() { ran += 1; },
  });
  assert.equal(job.undo(), true);
  timers[0].fn();
  assert.equal(ran, 0);
  assert.equal(timers[0].cleared, true);

  const later = [];
  const job2 = undo.schedule('b', {
    ms: 3000,
    timers: {
      set(fn) {
        const handle = { fn };
        later.push(handle);
        return handle;
      },
      clear() {},
    },
    onFinalize() { ran += 1; },
  });
  later[0].fn();
  assert.equal(ran, 1);
  assert.equal(job2.undo(), false);
});

test('a refresh payload omits ids waiting on Hoàn tác', () => {
  const incoming = [{ id: 'keep' }, { id: 'gone' }, { id: 'also' }];
  const left = undo.omitPending(incoming, ['gone']);
  assert.deepEqual(left.map(row => row.id), ['keep', 'also']);
  const restored = undo.restoreInPlace(left, { draft: { id: 'gone' }, index: 1 });
  assert.deepEqual(restored.map(row => row.id), ['keep', 'gone', 'also']);
});

test('delete one item, undo is client-side, refresh does not bring it back', { concurrency: 1 }, async () => {
  const stamp = String(Date.now());
  const keep = await drafts.createDraft(draftBody({
    customer_user_id: 'cust-keep-one-' + stamp,
    customer_name: 'Giữ lại',
    source_msg_id: 'src-keep-one-' + stamp,
    customer_query: 'tin giữ',
  }));
  const drop = await drafts.createDraft(draftBody({
    customer_user_id: 'cust-keep-one-' + stamp,
    customer_name: 'Giữ lại',
    source_msg_id: 'src-drop-one-' + stamp,
    customer_query: 'tin xoá',
  }));
  const other = await drafts.createDraft(draftBody({
    customer_user_id: 'cust-other-one-' + stamp,
    customer_name: 'Khác',
    source_msg_id: 'src-other-one-' + stamp,
  }));

  const removed = await drafts.hardDelete(drop.id, { actor: 'manager:Phil', scope: 'item' });
  assert.equal(removed.deleted, true);
  assert.equal(removed.scope, 'item');
  const pending = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  const ids = pending.drafts.map(row => row.id);
  assert.equal(ids.includes(drop.id), false);
  assert.equal(ids.includes(keep.id), true);
  assert.equal(ids.includes(other.id), true);
  const hidden = undo.omitPending(pending.drafts, [drop.id]);
  assert.equal(hidden.some(row => row.id === drop.id), false);

  await assert.rejects(
    () => drafts.createDraft(draftBody({
      customer_user_id: 'cust-keep-one-' + stamp,
      source_msg_id: 'src-drop-one-' + stamp,
      customer_query: 'thử lại',
    })),
    (err) => err.code === 'deleted'
  );
  const fresh = await drafts.createDraft(draftBody({
    customer_user_id: 'cust-keep-one-' + stamp,
    source_msg_id: 'src-new-after-one-' + stamp,
    customer_query: 'tin mới',
  }));
  assert.ok(fresh.id);
  assert.notEqual(fresh.id, drop.id);
  const logs = await audit.list({ entity_id: drop.id, action: 'draft.deleted' });
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].actor, 'manager:Phil');
  assert.equal(logs.logs[0].meta.scope, 'item');
  assert.equal(JSON.stringify(logs.logs[0]).includes('tin xoá'), false);
});

test('delete the whole thread and a later message still opens a card', { concurrency: 1 }, async () => {
  const user = 'cust-thread-' + Date.now();
  const first = await drafts.createDraft(draftBody({
    customer_user_id: user,
    source_msg_id: 'thread-a-' + user,
    customer_query: 'tin đầu',
  }));
  const second = await drafts.createDraft(draftBody({
    customer_user_id: user,
    source_msg_id: 'thread-b-' + user,
    customer_query: 'tin sau',
  }));
  const stranger = await drafts.createDraft(draftBody({
    channel: 'messenger',
    customer_user_id: user,
    source_msg_id: 'thread-fb-' + user,
    customer_query: 'kênh khác',
  }));
  const result = await drafts.hardDeleteThread(first.id, { actor: 'manager:Phil' });
  assert.equal(result.scope, 'thread');
  assert.equal(result.count, 2);
  const zalo = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  assert.equal(zalo.drafts.some(row => row.id === first.id || row.id === second.id), false);
  const fb = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'fb-sale', hop: 'pending' });
  assert.equal(fb.drafts.some(row => row.id === stranger.id), true);
  const again = await drafts.createDraft(draftBody({
    customer_user_id: user,
    source_msg_id: 'thread-new-' + user,
    customer_query: 'khách nhắn tiếp',
  }));
  assert.ok(again.id);
  const back = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  assert.equal(back.drafts.some(row => row.id === again.id), true);
  assert.equal(back.drafts.some(row => row.id === first.id), false);
  const logs = await audit.list({ entity_id: second.id, action: 'draft.deleted' });
  assert.equal(logs.logs[0].meta.scope, 'thread');
});

test('a tombstoned webhook does not send and does not rebuild the card', { concurrency: 1 }, async () => {
  const pipeline = require('../services/pipeline');
  const msgId = 'wh-deleted-' + Date.now();
  const row = await drafts.createDraft(draftBody({
    customer_user_id: 'cust-wh',
    source_msg_id: msgId,
  }));
  await drafts.hardDelete(row.id, { actor: 'manager:Phil' });
  let sent = false;
  const skipped = await pipeline.handleMessage({
    channel: 'oa',
    externalKey: 'z-wh',
    replyTo: 'z-wh',
    text: 'gửi lại',
    msgId,
    send: async () => { sent = true; return true; },
    log: () => {},
  });
  assert.equal(skipped.skipped, 'duplicate');
  assert.equal(sent, false);
  assert.equal(await tombstones.isBlocked('zalo', msgId), true);
  const listed = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  assert.equal(listed.drafts.some(item => item.source_msg_id === msgId), false);
});
