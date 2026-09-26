/**
 * High intent confidence keeps the normal HITL sales draft.
 * Below AI_CONFIDENCE_MIN the sales text is dropped and the thread is marked
 * NEEDS_HUMAN. Stickers and other non-text never get an invented reply.
 */
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `confidence-drafts-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;
delete process.env.AI_CONFIDENCE_MIN;

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const aiAgent = require('../services/aiAgent');
const drafts = require('../services/drafts');
const pipeline = require('../services/pipeline');
const notify = require('../services/notify');
const confidenceGate = require('../services/confidenceGate');

const SALES = 'Dạ dầu gội bồ kết 150K/chai ạ. Mình lấy một chai dùng thử nhen?';
const WRONG = 'Dạ em hiểu rồi, lấy 2 chai nước nghệ lên men giá 90K nhen, em chốt đơn luôn ạ';

const realHandoff = notify.handoff;
const realRespond = aiAgent.respond;
let handoffs = [];

function mockAi(confidence, text = SALES) {
  aiAgent.respond = async () => ({
    text,
    tokensUsed: 4,
    handoff: null,
    newOrder: null,
    stockHold: null,
    confidence,
  });
}

function inbound(uid, text, send) {
  return {
    channel: 'oa',
    externalKey: uid,
    replyTo: uid,
    text,
    msgId: `m-${uid}-${Math.random().toString(36).slice(2, 8)}`,
    senderName: 'Khach A',
    send,
    log() {},
  };
}

async function draftFor(uid) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find(d => d.customer_user_id === uid) || null;
}

describe('confidence fallback', { concurrency: 1 }, () => {
  beforeEach(() => {
    delete process.env.AI_CONFIDENCE_MIN;
    delete process.env.HITL_REQUIRE_APPROVAL;
    delete process.env.HITL_ACK_MESSAGE;
    handoffs = [];
    notify.handoff = async (info, customer, lastMessage) => {
      handoffs.push({ info, customer, lastMessage });
      return true;
    };
  });

  afterEach(() => {
    notify.handoff = realHandoff;
    aiAgent.respond = realRespond;
    delete process.env.AI_CONFIDENCE_MIN;
    delete process.env.HITL_REQUIRE_APPROVAL;
    delete process.env.HITL_ACK_MESSAGE;
  });

  test('AI_CONFIDENCE_MIN accepts a fraction, a percent, or a percent sign', () => {
    delete process.env.AI_CONFIDENCE_MIN;
    assert.equal(confidenceGate.minConfidence(), 0.6);
    assert.equal(confidenceGate.isLow(0.6), false);
    assert.equal(confidenceGate.isLow(0.59), true);
    assert.equal(confidenceGate.isLow(null), false);

    process.env.AI_CONFIDENCE_MIN = '0.55';
    assert.equal(confidenceGate.minConfidence(), 0.55);
    process.env.AI_CONFIDENCE_MIN = '60';
    assert.equal(confidenceGate.minConfidence(), 0.6);
    process.env.AI_CONFIDENCE_MIN = '60%';
    assert.equal(confidenceGate.minConfidence(), 0.6);
    process.env.AI_CONFIDENCE_MIN = '0';
    assert.equal(confidenceGate.minConfidence(), 0);
    assert.equal(confidenceGate.isLow(0), false);
    process.env.AI_CONFIDENCE_MIN = 'nope';
    assert.equal(confidenceGate.minConfidence(), 0.6);

    assert.equal(confidenceGate.edgeCase('Dau goi gia bao nhieu?'), null);
    assert.equal(confidenceGate.edgeCase('chốt 2 chai nước gừng'), null);
    assert.ok(confidenceGate.edgeCase(''));
    assert.ok(confidenceGate.edgeCase('asdfghjkl'));
    assert.ok(confidenceGate.edgeCase('hahaha'));
    assert.equal(confidenceGate.edgeCase('[sticker]').confidence < 0.6, true);
  });

  test('high confidence keeps the normal sales draft and does not send it', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'true';
    mockAi(0.92);

    const uid = `oa_high_${Date.now()}`;
    const calls = [];
    const result = await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (_to, text) => {
      calls.push(text);
      return true;
    }));

    assert.equal(result.ok, true);
    assert.equal(result.held, true);
    assert.equal(result.needsHuman, undefined);
    assert.equal(calls.length, 0);

    const draft = await draftFor(uid);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.draft_reply, SALES);
    assert.equal(draft.ticket_status, 'Mới tiếp nhận');
    assert.equal(draft.assigned_department, 'Sales');
    assert.equal(handoffs.length, 0);
  });

  test('confidence equal to the threshold still uses the normal draft', async () => {
    process.env.AI_CONFIDENCE_MIN = '0.6';
    process.env.HITL_REQUIRE_APPROVAL = 'true';
    mockAi(0.6);

    const uid = `oa_eq_${Date.now()}`;
    const result = await pipeline.handleMessage(inbound(uid, 'gia dau goi', async () => true));
    assert.equal(result.held, true);
    assert.equal(result.needsHuman, undefined);
    assert.equal((await draftFor(uid)).draft_reply, SALES);
  });

  test('low confidence holds a waiting line, not the confident wrong draft', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'true';
    process.env.HITL_ACK_MESSAGE = 'Dạ farm đã nhận, nhân viên xem và trả lời sớm ạ';
    mockAi(0.42, WRONG);

    const uid = `oa_low_${Date.now()}`;
    const calls = [];
    const result = await pipeline.handleMessage(inbound(uid, 'Dau goi gia bao nhieu?', async (_to, text) => {
      calls.push(text);
      return true;
    }));

    assert.equal(result.ok, true);
    assert.equal(result.needsHuman, true);
    assert.equal(result.held, true);
    assert.equal(result.steppedAside, 'low_confidence');
    assert.equal(calls.length, 0, 'neither the sales text nor an ack is sent');

    const draft = await draftFor(uid);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.draft_reply, confidenceGate.WAITING_REPLY);
    assert.equal(draft.draft_reply.includes('150'), false);
    assert.equal(draft.draft_reply.includes('chốt'), false);
    assert.notEqual(draft.draft_reply, WRONG);
    assert.equal(draft.ticket_status, 'NEEDS_HUMAN');
    assert.match(draft.customer_intent, /\[needs-human\]/);
    assert.match(draft.customer_intent, /Dau goi gia bao nhieu\?/);

    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].info.urgency, 'high');
    assert.match(handoffs[0].info.reason, /Cần human hỗ trợ khẩn cấp/);
    assert.match(handoffs[0].info.reason, /42%/);
  });

  test('percent threshold 80 treats 0.7 as low and 0.8 as normal', async () => {
    process.env.AI_CONFIDENCE_MIN = '80';
    process.env.HITL_REQUIRE_APPROVAL = 'true';

    const lowUid = `oa_pct_low_${Date.now()}`;
    mockAi(0.7, WRONG);
    await pipeline.handleMessage(inbound(lowUid, 'hoi gia dau goi', async () => true));
    const lowDraft = await draftFor(lowUid);
    assert.equal(lowDraft.ticket_status, 'NEEDS_HUMAN');
    assert.equal(lowDraft.draft_reply, confidenceGate.WAITING_REPLY);

    const highUid = `oa_pct_high_${Date.now()}`;
    mockAi(0.8, SALES);
    await pipeline.handleMessage(inbound(highUid, 'hoi gia dau goi nhe', async () => true));
    const highDraft = await draftFor(highUid);
    assert.equal(highDraft.draft_reply, SALES);
    assert.equal(highDraft.ticket_status, 'Mới tiếp nhận');
  });

  test('low confidence is draft-only even when HITL auto-send is off', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    mockAi(0.2, WRONG);

    const uid = `oa_low_off_${Date.now()}`;
    const calls = [];
    const result = await pipeline.handleMessage(inbound(uid, 'gia the nao vay', async (_to, text) => {
      calls.push(text);
      return true;
    }));

    assert.equal(result.needsHuman, true);
    assert.equal(result.held, true);
    assert.equal(calls.length, 0);
    const draft = await draftFor(uid);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.draft_reply, confidenceGate.WAITING_REPLY);
    assert.notEqual(draft.draft_reply, WRONG);
  });

  test('high confidence stays PENDING_REVIEW when approval flags are off', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    process.env.AUTO_SEND = 'true';
    mockAi(0.91, SALES);

    const uid = `oa_high_off_${Date.now()}`;
    const calls = [];
    const result = await pipeline.handleMessage(inbound(uid, 'gia dau goi', async (_to, text) => {
      calls.push(text);
      return true;
    }));

    assert.equal(result.held, true);
    assert.equal(calls.length, 0);
    const draft = await draftFor(uid);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.draft_reply, SALES);
    delete process.env.AUTO_SEND;
  });

  test('nonsense and empty intent skip the model and do not draft a sales reply', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'true';
    let calls = 0;
    aiAgent.respond = async () => {
      calls += 1;
      return { text: WRONG, tokensUsed: 1, confidence: 0.99, handoff: null, newOrder: null };
    };

    const nonsense = `oa_gib_${Date.now()}`;
    const sent = [];
    const result = await pipeline.handleMessage(inbound(nonsense, 'asdfghjkl', async (_to, text) => {
      sent.push(text);
      return true;
    }));
    assert.equal(calls, 0);
    assert.equal(sent.length, 0);
    assert.equal(result.needsHuman, true);
    const draft = await draftFor(nonsense);
    assert.equal(draft.draft_reply, confidenceGate.WAITING_REPLY);
    assert.equal(draft.ticket_status, 'NEEDS_HUMAN');
    assert.notEqual(draft.draft_reply, WRONG);

    const empty = `oa_empty_${Date.now()}`;
    await pipeline.handleMessage(inbound(empty, '   ', async () => {
      sent.push('sent');
      return true;
    }));
    assert.equal(calls, 0);
    assert.equal((await draftFor(empty)).ticket_status, 'NEEDS_HUMAN');
    assert.equal((await draftFor(empty)).draft_reply, confidenceGate.WAITING_REPLY);
  });

  test('sticker and unclear image use the human fallback, not an invented reply', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    const sent = [];
    async function send(_to, text) {
      sent.push(text);
      return true;
    }

    const sticker = `oa_stk_${Date.now()}`;
    const stickerResult = await pipeline.handleNonText({
      channel: 'oa',
      kind: 'sticker',
      externalKey: sticker,
      replyTo: sticker,
      msgId: `stk-${sticker}`,
      senderName: 'Khach A',
      send,
      log() {},
    });
    assert.equal(stickerResult.needsHuman, true);
    assert.equal(stickerResult.held, true);
    assert.equal(stickerResult.steppedAside, 'non_text');
    const stickerDraft = await draftFor(sticker);
    assert.equal(stickerDraft.approval_status, 'PENDING_REVIEW');
    assert.equal(stickerDraft.ticket_status, 'NEEDS_HUMAN');
    assert.equal(stickerDraft.draft_reply, confidenceGate.WAITING_REPLY);
    assert.match(stickerDraft.customer_intent, /\[needs-human\]/);
    assert.match(stickerDraft.customer_intent, /\[sticker\]/);
    assert.equal(/tư vấn gì/.test(stickerDraft.draft_reply), false);

    const image = `oa_img_${Date.now()}`;
    const imageResult = await pipeline.handleNonText({
      channel: 'oa',
      kind: 'image',
      externalKey: image,
      replyTo: image,
      msgId: `img-${image}`,
      senderName: 'Khach A',
      send,
      log() {},
    });
    assert.equal(imageResult.needsHuman, true);
    const imageDraft = await draftFor(image);
    assert.equal(imageDraft.ticket_status, 'NEEDS_HUMAN');
    assert.equal(imageDraft.draft_reply, confidenceGate.WAITING_REPLY);
    assert.equal(/ảnh sản phẩm/.test(imageDraft.draft_reply), false);
    assert.match(imageDraft.customer_intent, /\[needs-human\]/);
    assert.match(imageDraft.customer_intent, /\[image\]/);

    assert.equal(sent.length, 0, 'non-text fallback is not auto-sent');
    assert.ok(handoffs.some(h => String(h.lastMessage).includes('[sticker]')));
    assert.ok(handoffs.some(h => String(h.info.reason).includes('image')));
  });
});
