/**
 * Facebook thread history, Lành → DV labels, and the review-card context.
 * Graph is mocked. Nothing is sent.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-hist-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.FB_PAGE_ID = '111';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-secret';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FB_CLASSIFY_MODEL;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../services/conversationStore');
const backfill = require('../services/fbBackfill');
const threadLabels = require('../services/threadLabels');
const drafts = require('../services/drafts');
const hitl = require('../services/hitlGate');
const ui = require('../public/admin/thread-context');

const SECRET = 'page-token-secret';
const now = new Date('2026-09-25T00:00:00.000Z');
const fresh = '2026-08-01T00:00:00+0000';
const old = '2020-01-01T00:00:00+0000';
const SECRET_BODY = 'BI_MAT_PHONG_9988';

function convPage(convs, after) {
  return {
    status: 200,
    headers: {},
    data: {
      data: convs,
      paging: after ? { cursors: { after } } : {},
    },
  };
}

function threadOne() {
  return {
    id: 't1',
    updated_time: fresh,
    participants: { data: [{ id: '111', name: 'Dốc Mơ Farm' }, { id: '222', name: 'Minh' }] },
    messages: {
      data: [
        { id: 'm.old', message: 'tin xua', from: { id: '222', name: 'Minh' }, created_time: old },
        {
          id: 'm.lanh',
          message: 'Dạ còn phòng ạ',
          from: { id: '111', name: 'Lành' },
          created_time: fresh,
          tags: { data: [{ name: 'inbox' }] },
        },
        {
          id: 'm.sign',
          message: `Giữ phòng giúp anh nha\nLành ${SECRET_BODY}`,
          from: { id: '111', name: 'Dốc Mơ Farm' },
          created_time: fresh,
        },
        {
          id: 'm.cust',
          message: `${SECRET_BODY} đặt phòng`,
          from: { id: '222', name: 'Minh' },
          created_time: fresh,
        },
      ],
      paging: { cursors: { after: 'MSG2' } },
    },
  };
}

function threadTwo() {
  return {
    id: 't2',
    updated_time: fresh,
    participants: { data: [{ id: '333', name: 'Bo' }] },
    messages: {
      data: [
        { id: 'm.sale', message: 'mua thịt heo giúp shop', from: { id: '333', name: 'Bo' }, created_time: fresh },
      ],
    },
  };
}

function graphHttp(extra) {
  const urls = [];
  const http = {
    urls,
    async get(url, config) {
      urls.push(url);
      assert.equal(config.headers.Authorization, `Bearer ${SECRET}`);
      assert.equal(String(url).includes(SECRET), false);
      const decoded = decodeURIComponent(url);
      if (extra && extra.get) return extra.get(decoded, url);
      if (decoded.includes('/messages?') || decoded.includes('/messages&') || /\/messages\?/.test(decoded)) {
        return {
          status: 200,
          headers: {},
          data: {
            data: [{
              id: 'm.more',
              message: 'đi trong ngày được không',
              from: { id: '222', name: 'Minh' },
              created_time: fresh,
            }],
          },
        };
      }
      if (!decoded.includes('after=')) return convPage([threadOne()], 'CURSOR2');
      return convPage([threadTwo()]);
    },
  };
  return http;
}

beforeEach(() => {
  store.resetForTests();
  backfill.resetForTests();
  threadLabels.resetForTests();
});

test('backfill pages Graph, is idempotent, and status has no message text', async () => {
  const http = graphHttp();
  const first = await backfill.start({
    wait: true,
    http,
    now,
    months: 6,
    pauseMs: 0,
    sleep: async () => {},
  });
  assert.equal(first.status.running, false);
  assert.equal(first.status.done, true);
  assert.equal(first.status.threads, 2);
  assert.equal(first.status.messages, 5);
  assert.equal(first.status.errors, 0);
  assert.ok(first.status.progress.pages >= 2);
  assert.equal(first.status.zalo.synced, false);
  const decoded = http.urls.map((url) => decodeURIComponent(url));
  assert.ok(decoded.some((url) => url.includes('platform=messenger')
    && url.includes('participants,updated_time,messages.limit(25){id,message,from,to,created_time,tags,attachments}')));
  assert.ok(decoded.some((url) => url.includes('/t1/messages')));
  const stored = await store.all('fb');
  assert.equal(stored.some((row) => row.source_msg_id === 'm.old'), false);
  assert.equal(await store.count(), 5);

  const again = await backfill.start({
    wait: true,
    http,
    now,
    months: 6,
    pauseMs: 0,
    sleep: async () => {},
  });
  assert.equal(await store.count(), 5);
  assert.equal(again.status.messages, 0);
  assert.ok(again.status.progress.already >= 5);

  const names = first.status.attribution.page_from_names.map((item) => item.name);
  assert.ok(names.includes('Lành'));
  assert.ok(first.status.attribution.fields.includes('from.name'));
  assert.ok(first.status.attribution.tags.some((item) => item.tag === 'inbox' && item.count >= 1));
  assert.ok(first.status.attribution.signature_lanh_count >= 1);
  const dumped = JSON.stringify(first.status);
  assert.equal(dumped.includes(SECRET_BODY), false);
  assert.equal(dumped.includes(SECRET), false);
  assert.equal(Object.hasOwn(first.status, 'message_text'), false);
});

test('backfill resumes after a failed page and backs off on rate limit', async () => {
  let failSecond = true;
  let rate = true;
  const urls = [];
  const sleeps = [];
  const http = {
    async get(url) {
      urls.push(url);
      const decoded = decodeURIComponent(url);
      assert.equal(decoded.includes(SECRET), false);
      if (rate) {
        rate = false;
        return { status: 429, headers: { 'retry-after': '0' }, data: { error: { code: 4, message: 'limit' } } };
      }
      if (failSecond && decoded.includes('after=CURSOR2')) throw new Error('network');
      if (!decoded.includes('after=')) return convPage([threadOne()], 'CURSOR2');
      return convPage([threadTwo()]);
    },
  };
  const blocked = await backfill.start({
    wait: true,
    http,
    now,
    months: 6,
    pauseMs: 0,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(blocked.status.done, false);
  assert.equal(blocked.status.progress.has_cursor, true);
  assert.ok(blocked.status.progress.rate_limits >= 1);
  assert.ok(sleeps.length >= 1);
  assert.equal(blocked.status.errors >= 1, true);
  const midCount = await store.count();
  assert.ok(midCount >= 1);

  failSecond = false;
  const resumed = await backfill.start({
    wait: true,
    http,
    now,
    months: 6,
    pauseMs: 0,
    sleep: async () => {},
  });
  assert.equal(resumed.status.done, true);
  assert.ok((await store.count()) > midCount);
  assert.ok(urls.some((url) => decodeURIComponent(url).includes('after=CURSOR2')));
});

test('Lành is DV by sender name and, when that is missing, by signature', () => {
  assert.equal(threadLabels.lanhAttribution([
    {
      direction: 'out',
      message_text: 'Dạ còn ạ',
      sender_meta: { from_name: 'Lành', from_id: '111', page_id: '111' },
    },
  ]), 'staff_lanh');
  assert.equal(threadLabels.lanhAttribution([
    {
      direction: 'out',
      message_text: 'Mình giữ phòng giúp anh.\nLành',
      sender_meta: { from_name: 'Dốc Mơ Farm', from_id: '111', page_id: '111' },
    },
  ]), 'signature');
  assert.equal(threadLabels.lanhAttribution([
    {
      direction: 'out',
      message_text: 'Lành',
      sender_meta: { from_name: 'Phước', from_id: '999', page_id: '111' },
    },
  ]), null);
});

test('a DV thread stays DV on a vague follow-up unless the new message is strong Sale', async () => {
  const vague = threadLabels.classifyContext({
    channel: 'messenger',
    text: 'Là loại nào ha shop?',
    messages: [
      { direction: 'in', message_text: 'Cho mình đặt phòng qua đêm' },
      { direction: 'out', message_text: 'Dạ còn phòng ạ', sender_label: 'Lành' },
    ],
    label: { label: 'dv', source: 'keyword', confidence: 0.8 },
    prior: null,
  });
  assert.equal(vague.biz_line, 'dv');

  const strong = threadLabels.classifyContext({
    channel: 'messenger',
    text: 'mua thịt heo',
    messages: [{ direction: 'in', message_text: 'xin chào' }],
    label: { label: 'dv', source: 'keyword', confidence: 0.8 },
    prior: null,
  });
  assert.equal(strong.biz_line, 'sale');

  await store.setLabel('fb', 'fb_777', { label: 'dv', source: 'keyword', confidence: 0.8 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_777',
    direction: 'in',
    message_text: 'mình muốn đặt phòng qua đêm',
    source_msg_id: 'prior-777',
    created_time: fresh,
  });
  const release = await hitl.releaseToCustomer({
    channel: 'messenger',
    externalKey: 'fb_777',
    replyTo: '777',
    text: 'Là loại nào ha shop?',
    msgId: 'vague-777',
    send: async () => {
      throw new Error('must not send');
    },
  }, 'Dạ em xem lại giúp ạ', { intent: 'Là loại nào ha shop?' });
  assert.equal(release.held, true);
  assert.equal(release.draft.approval_status, 'PENDING_REVIEW');
  assert.equal(release.draft.biz_line, 'dv');
});

test('few-shot classification examples are sanitized', () => {
  const shots = threadLabels.buildFewShot([{
    label: 'dv',
    messages: [{ direction: 'in', message_text: 'đặt phòng 0901234567 giúp mình' }],
  }]);
  assert.equal(shots[0].label, 'dv');
  assert.match(shots[0].text, /\[PHONE\]/);
  assert.equal(shots[0].text.includes('0901234567'), false);
  const payload = threadLabels.classificationMessages(
    [{ direction: 'in', message_text: 'gọi 0901234567' }],
    shots
  );
  assert.equal(JSON.stringify(payload).includes('0901234567'), false);
});

test('relabel assigns pending drafts and keeps a manual label', async () => {
  await store.record({
    channel: 'fb',
    thread_id: 'fb_555',
    direction: 'out',
    message_text: 'Mình giữ phòng giúp anh.\nLành',
    sender_meta: { from_name: 'Dốc Mơ Farm', from_id: '111', page_id: '111' },
    source_msg_id: 'out-555',
    created_time: fresh,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_555',
    direction: 'in',
    message_text: 'Là loại nào ha shop?',
    source_msg_id: 'in-555',
    created_time: fresh,
  });
  const pending = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_555',
    customer_query: 'Là loại nào ha shop?',
    draft_reply: 'Dạ để em xem ạ',
    biz_line: 'sale',
    source_msg_id: 'in-555',
  });
  assert.equal(pending.biz_line, 'sale');

  await store.setLabel('fb', 'fb_keep', { label: 'sale', source: 'manual', confidence: 1 });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_keep',
    direction: 'out',
    message_text: 'Dạ còn phòng\nLành',
    sender_meta: { from_name: 'Lành', from_id: '111', page_id: '111' },
    source_msg_id: 'out-keep',
    created_time: fresh,
  });

  const result = await threadLabels.relabel();
  const moved = await drafts.getDraft(pending.id);
  assert.equal(moved.biz_line, 'dv');
  assert.equal(moved.approval_status, 'PENDING_REVIEW');
  const labeled = await store.getLabel('fb', 'fb_555');
  assert.equal(labeled.label, 'dv');
  assert.equal(labeled.source, 'signature');
  const kept = await store.getLabel('fb', 'fb_keep');
  assert.equal(kept.source, 'manual');
  assert.equal(kept.label, 'sale');
  assert.ok(result.drafts_updated >= 1);
  assert.ok(result.keywords.length > 0 && result.keywords.length <= 30);
  assert.equal(JSON.stringify(result).includes('Là loại nào'), false);
});

test('context list collapses to 3 and expands to at most 10', () => {
  assert.equal(ui.visible([], false).length, 0);
  assert.equal(ui.needsToggle([]), false);
  const three = [1, 2, 3];
  assert.equal(ui.needsToggle(three), false);
  assert.equal(ui.visible(three, false).length, 3);
  const twelve = Array.from({ length: 12 }, (_, i) => i + 1);
  assert.equal(ui.needsToggle(twelve), true);
  assert.deepEqual(ui.visible(twelve, false), [10, 11, 12]);
  assert.equal(ui.visible(twelve, true).length, 10);
  assert.equal(ui.visible(twelve, true)[0], 3);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  assert.match(js, /Xem thêm/);
  assert.match(js, /thread-context/);
  assert.match(js, /Chuyển qua DV/);
});

test('manual Sale/DV move writes a manual thread label', async () => {
  const draft = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_42',
    customer_query: 'alo',
    draft_reply: 'Dạ ạ',
    biz_line: 'sale',
  });
  const moved = await drafts.moveBizLine(draft.id, 'dv', { actor: 'manager' });
  assert.equal(moved.biz_line, 'dv');
  assert.equal(moved.biz_sticky, true);
  const label = await store.getLabel('fb', 'fb_42');
  assert.equal(label.label, 'dv');
  assert.equal(label.source, 'manual');
  assert.equal(label.confidence, 1);
});

test('echoes record app_id and our sends record without duplicating the mid', async () => {
  const saved = await store.recordMessengerEvent({
    sender: { id: '111' },
    recipient: { id: '555' },
    timestamp: Date.now(),
    message: { mid: 'echo1', is_echo: true, text: 'Em gửi phòng nha — Lành', app_id: 999 },
  }, '111');
  assert.equal(saved.inserted, true);
  const again = await store.recordMessengerEvent({
    sender: { id: '111' },
    recipient: { id: '555' },
    timestamp: Date.now(),
    message: { mid: 'echo1', is_echo: true, text: 'Em gửi phòng nha — Lành', app_id: 999 },
  }, '111');
  assert.equal(again.inserted, false);
  assert.equal(await store.count(), 1);
  const status = await backfill.publicStatus();
  assert.ok(status.attribution.fields.includes('app_id'));
  assert.ok(status.attribution.echo_app_ids.some((item) => item.app_id === '999'));
  assert.ok(status.attribution.signature_lanh_count >= 1);
  assert.equal(JSON.stringify(status).includes('Em gửi phòng'), false);
});
