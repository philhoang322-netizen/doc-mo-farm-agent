/**
 * Xóa: no confirm dialog, 3s client undo, then a hard delete.
 * A tombstone blocks backfill. A refresh must not put a pending card back.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-delete-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.TRAINING_LOG_PATH = path.join(dir, 'training.json');
process.env.NODE_ENV = 'test';
process.env.FB_PAGE_ID = '111';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-secret';
process.env.INBOX_SYNC_HOURS = '24';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const undo = require('../public/admin/undo-delete');
const drafts = require('../services/drafts');
const audit = require('../services/audit');
const tombstones = require('../services/tombstones');
const trainingLog = require('../services/trainingLog');
const inboxSync = require('../services/inboxSync');
const pipeline = require('../services/pipeline');

test('Xóa does not confirm, and each undo is its own 3 second timer', () => {
  assert.equal(undo.needsConfirm(), false);
  assert.equal(undo.UNDO_MS, 3000);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/admin/review.js'), 'utf8');
  const start = src.indexOf('async function removeDraft');
  const end = src.indexOf('function showSync');
  const body = src.slice(start, end);
  assert.equal(/\bconfirm\s*\(/.test(body), false);
  assert.equal(body.includes('/restore'), false);
  assert.match(body, /UNDO_MS/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/admin/review.html'), 'utf8');
  assert.equal(html.includes('data-folder="deleted"'), false);
  assert.equal(html.includes('Đã xóa'), false);

  const finalized = [];
  const timers = [];
  const fake = {
    set(fn, ms) {
      const slot = { fn, ms, cleared: false };
      timers.push(slot);
      return timers.length - 1;
    },
    clear(handle) { timers[handle].cleared = true; },
  };
  const opts = {
    ms: undo.UNDO_MS,
    timers: fake,
    onFinalize: (id) => finalized.push(id),
  };
  const first = undo.schedule('card-a', opts);
  const second = undo.schedule('card-b', opts);
  assert.equal(timers[0].ms, 3000);
  assert.equal(timers[1].ms, 3000);
  assert.equal(first.undo(), true);
  timers[0].fn();
  timers[1].fn();
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(finalized, ['card-b']);
  assert.equal(second.undo(), false);
});

test('undo puts the same card back; a refresh omits ids still pending', () => {
  const draft = {
    id: 'd1',
    approval_status: 'PENDING_REVIEW',
    inbox_status: 'hesitant',
    biz_line: 'dv',
    channel: 'messenger',
  };
  const list = [{ id: 'd0', biz_line: 'sale' }, { id: 'd2', biz_line: 'sale' }];
  const restored = undo.restoreInPlace(list, { draft, index: 1 });
  assert.equal(restored[1], draft);
  assert.equal(restored[1].inbox_status, 'hesitant');
  assert.equal(restored[1].biz_line, 'dv');
  assert.equal(restored[1].approval_status, 'PENDING_REVIEW');
  assert.deepEqual(restored.map(d => d.id), ['d0', 'd1', 'd2']);

  const incoming = [draft, { id: 'd9', inbox_status: 'pending' }];
  const visible = undo.omitPending(incoming, ['d1']);
  assert.deepEqual(visible.map(d => d.id), ['d9']);
});

test('finalize hard-deletes, writes a body-free tombstone and audit, and blocks re-import', async () => {
  const secret = 'SECRET-BODY-khong-luu';
  const reply = 'SECRET-REPLY-khong-luu';
  const d = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_secret',
    customer_name: 'Mai',
    customer_query: secret,
    draft_reply: reply,
    source_msg_id: 'm.secret',
    biz_line: 'sale',
  });
  await trainingLog.storeOnApprove({
    ...d,
    ai_draft_version: 'ban ai',
    draft_reply: reply,
  }, { actor: 'manager:Phước', learn: true });
  assert.equal((await trainingLog.listRecent()).some(row => row.draft_id === d.id), true);

  const gone = await drafts.hardDelete(d.id, { actor: 'manager:Phước' });
  assert.equal(gone.deleted, true);
  assert.equal(JSON.stringify(gone).includes(secret), false);
  assert.equal(JSON.stringify(gone).includes(reply), false);
  assert.equal(await drafts.getDraft(d.id), null);
  assert.equal((await trainingLog.listRecent()).some(row => row.draft_id === d.id), false);

  for (const hop of ['pending', 'sent', 'bought', 'hesitant', 'declined']) {
    const listed = await drafts.listDrafts({ salesChannel: 'farm', hop });
    assert.equal(listed.drafts.some(item => item.id === d.id), false);
  }

  const stone = await tombstones.get('messenger', 'm.secret');
  assert.deepEqual(Object.keys(stone).sort(), ['channel', 'deleted_at', 'deleted_by', 'source_msg_id']);
  assert.equal(stone.deleted_by, 'manager:Phước');
  assert.equal(stone.channel, 'messenger');
  assert.equal(JSON.stringify(stone).includes(secret), false);
  assert.equal(JSON.stringify(stone).includes(reply), false);

  const logs = await audit.list({ entity_id: d.id, action: 'draft.deleted' });
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].actor, 'manager:Phước');
  assert.equal(logs.logs[0].meta.channel, 'messenger');
  assert.equal(logs.logs[0].meta.customer_user_id, 'fb_secret');
  assert.equal(JSON.stringify(logs.logs[0]).includes(secret), false);
  assert.equal(JSON.stringify(logs.logs[0]).includes(reply), false);

  await assert.rejects(
    () => drafts.createDraft({
      channel: 'messenger',
      customer_user_id: 'fb_secret',
      customer_query: secret,
      draft_reply: reply,
      source_msg_id: 'm.secret',
    }),
    (err) => err && err.code === 'deleted'
  );

  let sent = 0;
  const skipped = await pipeline.handleMessage({
    channel: 'messenger',
    externalKey: 'fb_secret',
    replyTo: 'secret',
    text: secret,
    msgId: 'm.secret',
    senderName: 'Mai',
    send: async () => { sent += 1; return { ok: true }; },
    log: () => {},
  });
  assert.equal(skipped.skipped, 'duplicate');
  assert.equal(sent, 0);
  assert.equal(await drafts.findBySourceMsg('messenger', 'm.secret'), null);

  inboxSync.resetForTests();
  let ingested = 0;
  const sync = await inboxSync.syncMissed({
    now: new Date('2026-09-25T05:00:00.000Z'),
    http: {
      async get() {
        return {
          status: 200,
          data: {
            data: [{
              id: 't1',
              messages: {
                data: [{
                  id: 'm.secret',
                  message: secret,
                  from: { id: '222', name: 'Mai' },
                  created_time: '2026-09-25T04:00:00+0000',
                }],
              },
            }],
          },
        };
      },
    },
    ingest: async () => { ingested += 1; return { draftId: 'should-not' }; },
  });
  assert.equal(sync.added, 0);
  assert.equal(sync.skipped, 1);
  assert.equal(ingested, 0);
  assert.equal(await drafts.findBySourceMsg('messenger', 'm.secret'), null);
});
