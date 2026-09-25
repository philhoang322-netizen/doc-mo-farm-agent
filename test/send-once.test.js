/**
 * Duyệt & Gửi sends on click. No confirm dialog. A double click sends once.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-once-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sendOnce = require('../public/admin/send-once');
const drafts = require('../services/drafts');
const zalo = require('../services/zaloService');

function sliceFn(src, name, nextName) {
  const start = src.indexOf(name);
  const end = src.indexOf(nextName, start + name.length);
  assert.ok(start >= 0 && end > start, name);
  return src.slice(start, end);
}

test('send does not open a confirm dialog, and a second click is ignored', () => {
  assert.equal(sendOnce.needsConfirm(), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/admin/review.js'), 'utf8');
  const approve = sliceFn(src, 'async function approveCard', 'function lineActions');
  const detailSend = sliceFn(src, 'function send()', 'function vnd');
  assert.equal(/\bconfirm\s*\(/.test(approve), false);
  assert.equal(/\bconfirm\s*\(/.test(detailSend), false);
  assert.match(approve, /tryBegin/);
  assert.match(src, /Xác nhận tạo hoá đơn/);
  assert.match(src, /Xác nhận tạo đơn đặt hàng/);
  assert.match(src, /Đã gửi · /);

  const empty = sendOnce.prepare({ reply: '   ', learn: true });
  assert.equal(empty.send, false);
  assert.match(empty.inline, /Nhập câu trả lời/);

  const gate = sendOnce.createGate();
  assert.equal(gate.tryBegin('draft-1'), true);
  assert.equal(gate.tryBegin('draft-1'), false);
  assert.equal(gate.tryBegin('draft-2'), true);
  gate.end('draft-1');
  assert.equal(gate.tryBegin('draft-1'), true);
});

test('two overlapping sends deliver once and the card lands in Đã gửi', async () => {
  const realGet = zalo.getTokens;
  const realSend = zalo.sendTextMessage;
  let calls = 0;
  let release;
  let started;
  const hold = new Promise(resolve => { release = resolve; });
  zalo.getTokens = () => ({ accessToken: 'test-token' });
  zalo.sendTextMessage = async () => {
    calls += 1;
    if (started) started();
    await hold;
    return { message_id: 'once' };
  };
  try {
    const d = await drafts.createDraft({
      channel: 'zalo',
      customer_user_id: 'zalo_send_once',
      customer_query: 'alo',
      draft_reply: 'Dạ farm gửi ngay ạ',
    });
    const body = { draft_reply: 'Dạ farm gửi ngay ạ', send: true, learn: false, approval_status: 'APPROVED' };
    const firstSend = new Promise(resolve => { started = resolve; });
    const pending = Promise.all([
      drafts.updateDraft(d.id, body, { actorName: 'Phước' }),
      drafts.updateDraft(d.id, body, { actorName: 'Phước' }),
    ]);
    await firstSend;
    assert.equal(calls, 1);
    release();
    const [first, second] = await pending;
    assert.equal(calls, 1);
    const sent = [first, second].filter(row => row && row.send && row.send.sent);
    assert.equal(sent.length, 1);
    const stored = await drafts.getDraft(d.id);
    assert.equal(stored.approval_status, 'SENT');
    assert.equal(stored.inbox_status, 'sent');
    const folder = await drafts.listDrafts({ salesChannel: 'farm', hop: 'sent', nhom: 'zalo' });
    assert.ok(folder.drafts.some(item => item.id === d.id));
  } finally {
    zalo.getTokens = realGet;
    zalo.sendTextMessage = realSend;
  }
});
