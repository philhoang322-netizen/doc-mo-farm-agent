/**
 * Source receive time and the sent clock on an inbox card.
 * Nothing here sends a message.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-time-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
process.env.FB_PAGE_ID = '';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cardTime = require('../public/admin/card-time');
const drafts = require('../services/drafts');
const messenger = require('../services/messenger');

const ICT = '2026-09-25T05:30:00.000Z';

test('ms epoch, Graph created_time, and a Zalo timestamp parse to one instant', () => {
  const epoch = 1591234567890;
  const iso = new Date(epoch).toISOString();
  assert.equal(cardTime.parse(epoch), iso);
  assert.equal(cardTime.parse(String(epoch)), iso);
  assert.equal(cardTime.parse('2026-09-25T05:30:00+0000'), ICT);
  assert.equal(cardTime.parse('2026-09-25T05:30:00.000Z'), ICT);
  assert.equal(cardTime.parse('not-a-time'), null);
  assert.equal(cardTime.parse(''), null);
});

test('absolute clocks use Asia/Ho_Chi_Minh', () => {
  assert.equal(cardTime.absolute(ICT), '12:30 25/09/2026');
  assert.equal(cardTime.absolute('2026-09-25T17:05:00.000Z'), '00:05 26/09/2026');
});

test('a stored source time is Nhận, and a missing one falls back with a tilde', () => {
  const now = Date.parse('2026-09-25T05:31:30.000Z');
  const received = cardTime.receivedLabel({
    source_received_at: ICT,
    created_at: '2026-09-25T05:31:00.000Z',
  }, now);
  assert.equal(received.text, 'Nhận: 12:30 25/09/2026');
  assert.equal(received.approx, false);
  assert.equal(received.title, '1 phút trước');

  const fallback = cardTime.receivedLabel({
    source_received_at: null,
    created_at: '2026-09-25T05:30:00.000Z',
  }, now);
  assert.equal(fallback.text, 'Nhận: ~12:30 25/09/2026');
  assert.equal(fallback.approx, true);
  assert.match(fallback.title, /không gửi giờ nhận/);
});

test('Gửi shows on a sent card for every folder that keeps sent_at, and not when unset', () => {
  const sent = cardTime.sentLabel({
    sent_at: ICT,
    sent_by: 'dv:hoa',
    inbox_status: 'bought',
  });
  assert.equal(sent.text, 'Gửi: 12:30 25/09/2026');
  assert.equal(sent.who, 'hoa');
  for (const folder of ['sent', 'bought', 'hesitant', 'declined']) {
    const line = cardTime.sentLabel({ sent_at: ICT, sent_by: 'manager', inbox_status: folder });
    assert.equal(line.text, 'Gửi: 12:30 25/09/2026');
    assert.equal(line.who, 'Quản lý');
  }
  assert.equal(cardTime.sentLabel({ sent_at: null, inbox_status: 'declined' }), null);
});

test('a cheap id backfill reads only a synthetic Messenger clock', async () => {
  assert.equal(cardTime.fromSyntheticMsgId('fb_28343541935308908_1591234567890'), cardTime.parse(1591234567890));
  assert.equal(cardTime.fromSyntheticMsgId('m_mid.real'), null);
  assert.equal(cardTime.fromSyntheticMsgId('zalo-msg-1'), null);

  const embedded = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_embed',
    draft_reply: 'Dạ em đây ạ',
    source_msg_id: 'fb_embed_1591234567890',
  });
  assert.equal(embedded.source_received_at, null);
  await drafts.backfillSourceTimes();
  const filled = await drafts.getDraft(embedded.id);
  assert.equal(filled.source_received_at, cardTime.parse(1591234567890));

  const plain = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_plain',
    draft_reply: 'Dạ em đây ạ',
    source_msg_id: 'm_real_mid',
  });
  await drafts.backfillSourceTimes();
  assert.equal((await drafts.getDraft(plain.id)).source_received_at, null);

  const explicit = await drafts.createDraft({
    channel: 'zalo',
    customer_user_id: 'zalo-1',
    customer_name: 'Tên cũ',
    draft_reply: 'Dạ em đây ạ',
    source_received_at: '1591234567890',
  });
  assert.equal(explicit.source_received_at, cardTime.parse(1591234567890));
  assert.equal(cardTime.receivedLabel(explicit).text, 'Nhận: ' + cardTime.absolute(explicit.source_received_at));
});

test('Messenger forwards the webhook timestamp and Graph created_time is a receivedAt', async () => {
  const seen = [];
  await messenger.processBody({
    object: 'page',
    entry: [{
      messaging: [{
        sender: { id: '555' },
        recipient: { id: '111' },
        timestamp: 1591234567890,
        message: { mid: 'm_555', text: 'xin chào' },
      }],
    }],
  }, {
    pipeline: { handleMessage: async (p) => { seen.push(p); return {}; } },
    log() {},
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].receivedAt, 1591234567890);
  assert.equal(cardTime.parse(seen[0].receivedAt), cardTime.parse(1591234567890));
  assert.equal(cardTime.platformMessageId({ message_id: 'mid.approved' }), 'mid.approved');
  assert.equal(cardTime.platformMessageId({ error: 0, data: { message_id: 'zalo-9' } }), 'zalo-9');
});
