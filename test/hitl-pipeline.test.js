/**
 * Inbound text must become a PENDING_REVIEW draft and must not call the
 * Zalo send callback with the AI body when HITL_REQUIRE_APPROVAL is on
 * (the default). false keeps auto-send.
 */
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `hitl-drafts-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const aiAgent = require('../services/aiAgent');
const drafts = require('../services/drafts');
const pipeline = require('../services/pipeline');
const hitl = require('../services/hitlGate');
const zaloService = require('../services/zaloService');

const AI = 'Dạ dầu gội bồ kết bên farm giá 150.000đ một chai ạ';

function mockAi(impl) {
  aiAgent.respond = impl || (async () => ({
    text: AI,
    tokensUsed: 3,
    handoff: null,
    newOrder: null,
  }));
}

function inbound(uid, text, send) {
  return {
    channel: 'oa',
    externalKey: uid,
    replyTo: uid,
    text,
    msgId: `m-${uid}`,
    senderName: 'Khach A',
    send,
    log() {},
  };
}

async function draftFor(uid) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find(d => d.customer_user_id === uid) || null;
}

describe('HITL pipeline', { concurrency: 1 }, () => {
test('unset HITL_REQUIRE_APPROVAL holds the AI reply and does not send it', async () => {
  delete process.env.HITL_REQUIRE_APPROVAL;
  delete process.env.HITL_ACK_MESSAGE;
  assert.equal(hitl.hitlRequired(), true);
  mockAi();

  const uid = `oa_hold_${Date.now()}`;
  const calls = [];
  const result = await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (to, text) => {
    calls.push({ to, text });
    return { message_id: 'should-not-send' };
  }));

  assert.equal(result.ok, true);
  assert.equal(result.held, true);
  assert.equal(calls.length, 0, 'Zalo send must not be called');

  const draft = await draftFor(uid);
  assert.ok(draft, 'expected a PENDING_REVIEW draft');
  assert.equal(draft.approval_status, 'PENDING_REVIEW');
  assert.equal(draft.channel, 'zalo');
  assert.equal(draft.draft_reply, AI);
  assert.equal(draft.customer_intent, 'Dau goi gia bao nhieu?');
  assert.equal(draft.customer_name, 'Khach A');
  assert.equal(draft.customer_user_id, uid);
  assert.equal(draft.assigned_department, 'Sales');
  assert.equal(draft.ticket_status, 'Mới tiếp nhận');
});

test('bot channel stores bot_<chatId> and does not send the AI body', async () => {
  delete process.env.HITL_REQUIRE_APPROVAL;
  delete process.env.HITL_ACK_MESSAGE;
  mockAi();

  const chatId = `chat_${Date.now()}`;
  const calls = [];
  const result = await pipeline.handleMessage({
    channel: 'bot',
    externalKey: `bot_${chatId}`,
    replyTo: chatId,
    text: 'Dau goi gia bao nhieu?',
    msgId: `b-${chatId}`,
    senderName: 'Khach Bot',
    send: async (to, text) => {
      calls.push({ to, text });
      return true;
    },
    log() {},
  });

  assert.equal(result.held, true);
  assert.equal(calls.length, 0);
  const draft = await draftFor(`bot_${chatId}`);
  assert.ok(draft);
  assert.equal(draft.approval_status, 'PENDING_REVIEW');
  assert.equal(draft.draft_reply, AI);
  assert.equal(draft.channel, 'zalo');
});

test('HITL_ACK_MESSAGE sends only the ack, not the AI body', async () => {
  process.env.HITL_REQUIRE_APPROVAL = 'true';
  process.env.HITL_ACK_MESSAGE = 'Dạ farm đã nhận, nhân viên xem và trả lời sớm ạ';
  mockAi();

  const uid = `oa_ack_${Date.now()}`;
  const calls = [];
  await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (to, text) => {
    calls.push({ to, text });
    return true;
  }));

  assert.deepEqual(calls.map(c => c.text), [process.env.HITL_ACK_MESSAGE]);
  const draft = await draftFor(uid);
  assert.equal(draft.draft_reply, AI);
  assert.equal(draft.approval_status, 'PENDING_REVIEW');
  delete process.env.HITL_ACK_MESSAGE;
});

test('blank HITL_ACK_MESSAGE sends nothing', async () => {
  process.env.HITL_REQUIRE_APPROVAL = 'true';
  process.env.HITL_ACK_MESSAGE = '   ';
  mockAi();

  const uid = `oa_blank_ack_${Date.now()}`;
  const calls = [];
  await pipeline.handleMessage(inbound(uid, 'gia the nao', async (to, text) => {
    calls.push(text);
    return true;
  }));
  assert.equal(calls.length, 0);
  assert.equal((await draftFor(uid)).draft_reply, AI);
  delete process.env.HITL_ACK_MESSAGE;
});

test('HITL_REQUIRE_APPROVAL=false auto-sends and does not draft', async () => {
  process.env.HITL_REQUIRE_APPROVAL = 'false';
  delete process.env.HITL_ACK_MESSAGE;
  assert.equal(hitl.hitlRequired(), false);
  mockAi();

  const uid = `oa_auto_${Date.now()}`;
  const calls = [];
  const result = await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (to, text) => {
    calls.push({ to, text });
    return { message_id: 'sent' };
  }));

  assert.equal(result.ok, true);
  assert.equal(result.held, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, uid);
  assert.equal(calls[0].text, AI);
  assert.equal(await draftFor(uid), null);
});

test('fallback reply is drafted, not sent, when approval is required', async () => {
  process.env.HITL_REQUIRE_APPROVAL = 'true';
  delete process.env.HITL_ACK_MESSAGE;
  mockAi(async () => { throw new Error('model down'); });

  const uid = `oa_err_${Date.now()}`;
  const calls = [];
  const result = await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (to, text) => {
    calls.push(text);
    return true;
  }));

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  const draft = await draftFor(uid);
  assert.ok(draft);
  assert.equal(draft.draft_reply, pipeline.FALLBACK_REPLY);
  assert.equal(draft.approval_status, 'PENDING_REVIEW');
});

test('fallback is auto-sent when approval is off', async () => {
  process.env.HITL_REQUIRE_APPROVAL = 'false';
  mockAi(async () => { throw new Error('model down'); });

  const uid = `oa_err_off_${Date.now()}`;
  const calls = [];
  await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (to, text) => {
    calls.push(text);
    return true;
  }));
  assert.deepEqual(calls, [pipeline.FALLBACK_REPLY]);
  assert.equal(await draftFor(uid), null);
});

test('canned quick reply is held when approval is required', async () => {
  process.env.HITL_REQUIRE_APPROVAL = 'true';
  delete process.env.HITL_ACK_MESSAGE;
  const uid = `oa_ok_${Date.now()}`;
  const calls = [];
  const result = await pipeline.handleMessage(inbound(uid, 'ok', async (to, text) => {
    calls.push(text);
    return true;
  }));
  assert.equal(result.quick, true);
  assert.equal(result.held, true);
  assert.equal(calls.length, 0);
  assert.equal((await draftFor(uid)).draft_reply, 'Dạ vâng ạ 🌿');
});

test('approve/send still delivers the draft body through zaloService', async () => {
  const uid = `oa_deliver_${Date.now()}`;
  const sent = [];
  const originalSend = zaloService.sendTextMessage;
  const originalTokens = zaloService.getTokens;
  zaloService.getTokens = () => ({ accessToken: 'test-token' });
  zaloService.sendTextMessage = async (to, text) => {
    sent.push({ to, text });
    return { message_id: 'approved' };
  };
  try {
    const created = await drafts.createDraft({
      channel: 'zalo',
      customer_user_id: uid,
      customer_name: 'Khach A',
      customer_intent: 'Dau goi gia bao nhieu?',
      draft_reply: AI,
      assigned_department: 'Sales',
      ticket_status: 'Mới tiếp nhận',
    });
    assert.equal(created.approval_status, 'PENDING_REVIEW');
    const updated = await drafts.updateDraft(created.id, { send: true });
    assert.equal(updated.send.sent, true);
    assert.equal(updated.send.via, 'zalo_oa');
    assert.equal(updated.draft.approval_status, 'SENT');
    assert.deepEqual(sent, [{ to: uid, text: AI }]);
  } finally {
    zaloService.sendTextMessage = originalSend;
    zaloService.getTokens = originalTokens;
  }
});
});
