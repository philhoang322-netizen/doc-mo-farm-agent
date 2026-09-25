/**
 * Missed-message backfill. Graph is mocked. Nothing is sent.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-sync-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.FB_PAGE_ID = '111';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-secret';
process.env.INBOX_SYNC_HOURS = '24';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const inboxSync = require('../services/inboxSync');
const drafts = require('../services/drafts');
const hitl = require('../services/hitlGate');
const ops = require('../services/ops');
const zalo = require('../services/zaloService');

const now = new Date('2026-09-25T05:00:00.000Z');
const fresh = '2026-09-25T04:00:00+0000';
const old = '2026-09-20T04:00:00+0000';

let sends = 0;
const realSend = zalo.sendTextMessage;

function page(messages, after) {
  return {
    status: 200,
    data: {
      data: [{ id: 't1', messages: { data: messages } }],
      paging: after ? { cursors: { after } } : {},
    },
  };
}

beforeEach(() => {
  inboxSync.resetForTests();
  sends = 0;
  zalo.sendTextMessage = async () => { sends += 1; return { message_id: 'nope' }; };
});

test('adds a new customer message, skips page echoes, old messages, and duplicates', async () => {
  await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_222',
    customer_query: 'da co',
    draft_reply: 'Dạ ạ',
    source_msg_id: 'm.have',
  });
  const urls = [];
  const http = {
    async get(url, config) {
      urls.push(url);
      assert.equal(config.headers.Authorization, 'Bearer page-token-secret');
      assert.equal(url.includes('page-token-secret'), false);
      if (!url.includes('after=')) {
        return page([
          { id: 'm.have', message: 'da co', from: { id: '222', name: 'Lan' }, created_time: fresh },
          { id: 'm.page', message: 'farm noi', from: { id: '111' }, created_time: fresh },
          { id: 'm.old', message: 'hom truoc', from: { id: '222' }, created_time: old },
          { id: 'm.new', message: 'dat phong homestay', from: { id: '333', name: 'An' }, created_time: fresh },
        ], 'CURSOR2');
      }
      return page([
        { id: 'm.sale', message: 'mua thit heo', from: { id: '444', name: 'Bo' }, created_time: fresh },
      ]);
    },
  };
  const result = await inboxSync.syncMissed({
    http,
    now,
    ingest: async (item) => {
      if (!(await ops.isNewEvent(item.id, 'messenger'))) return { skipped: 'duplicate' };
      const release = await hitl.releaseToCustomer({
        channel: 'messenger',
        externalKey: 'fb_' + item.psid,
        replyTo: item.psid,
        text: item.text,
        msgId: item.id,
        senderName: item.name,
        send: async () => { sends += 1; return { ok: true }; },
      }, 'Dạ farm đã nhận ạ', { rewriteDv: true, intent: item.text });
      return { held: release.held, draftId: release.draft && release.draft.id, sent: release.sent };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 1);
  assert.equal(sends, 0);
  assert.equal(result.zalo.synced, false);
  assert.match(urls[1], /after=CURSOR2/);
  const dv = await drafts.findBySourceMsg('messenger', 'm.new');
  const sale = await drafts.findBySourceMsg('messenger', 'm.sale');
  assert.equal(dv.biz_line, 'dv');
  assert.equal(dv.approval_status, 'PENDING_REVIEW');
  assert.match(dv.draft_reply, /ngày đến/);
  assert.equal(sale.biz_line, 'sale');
  assert.equal(sale.draft_reply, 'Dạ farm đã nhận ạ');

  inboxSync.resetForTests();
  const again = await inboxSync.syncMissed({
    http,
    now: new Date(now.getTime() + 61 * 1000),
    ingest: async () => { throw new Error('should not ingest'); },
  });
  assert.equal(again.added, 0);
  assert.ok(again.skipped >= 1);
});

test('Graph development-mode errors are returned, and the button is rate limited', async () => {
  const http = {
    async get() {
      return {
        status: 400,
        data: { error: { message: '(#200) App is in Development mode', code: 200, type: 'OAuthException' } },
      };
    },
  };
  const first = await inboxSync.syncMissed({ http, now });
  assert.equal(first.ok, false);
  assert.match(first.error, /Development mode/);
  assert.equal(first.error_code, 200);
  const second = await inboxSync.syncMissed({ http, now: new Date(now.getTime() + 1000) });
  assert.equal(second.rate_limited, true);
  assert.match(second.error, /một phút/);
  zalo.sendTextMessage = realSend;
});
