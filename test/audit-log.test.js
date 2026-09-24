/**
 * Audit trail for the HITL path:
 * customer message → AI draft → manager edit (before/after) → approve/send
 * → KiotViet push. Drafts stay PENDING_REVIEW until a person sends them.
 */
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `audit-drafts-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;
delete process.env.KIOTVIET_CLIENT_ID;
delete process.env.KIOTVIET_CLIENT_SECRET;
delete process.env.KIOTVIET_RETAILER;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const aiAgent = require('../services/aiAgent');
const audit = require('../services/audit');
const drafts = require('../services/drafts');
const kiotviet = require('../services/kiotviet');
const pipeline = require('../services/pipeline');
const stockGate = require('../services/stockGate');
const zaloService = require('../services/zaloService');

const realRespond = aiAgent.respond;
const realPush = kiotviet.pushOrder;
const realAssess = stockGate.assessItems;
const realSend = zaloService.sendTextMessage;
const realTokens = zaloService.getTokens;

const SECRET = 'super-secret-token';

function restore() {
  aiAgent.respond = realRespond;
  kiotviet.pushOrder = realPush;
  stockGate.assessItems = realAssess;
  zaloService.sendTextMessage = realSend;
  zaloService.getTokens = realTokens;
  delete process.env.KIOTVIET_CLIENT_ID;
  delete process.env.KIOTVIET_CLIENT_SECRET;
  delete process.env.KIOTVIET_RETAILER;
  delete process.env.HITL_REQUIRE_APPROVAL;
  delete process.env.HITL_ACK_MESSAGE;
}

async function makeDraft(uid, reply) {
  return drafts.createDraft({
    channel: 'zalo',
    customer_user_id: uid,
    customer_name: 'Khach A',
    customer_intent: 'Hỏi giá dầu gội',
    draft_reply: reply,
  });
}

describe('audit log', { concurrency: 1 }, () => {
  test('creating a draft writes an AI audit row and stays PENDING_REVIEW', async () => {
    const uid = `audit_draft_${Date.now()}`;
    const reply = 'Dạ dầu gội 150.000đ một chai ạ';
    const draft = await makeDraft(uid, reply);

    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    const { logs } = await audit.list({ entity_id: draft.id, action: 'draft.created' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].actor, 'ai');
    assert.equal(logs[0].entity_type, 'draft');
    assert.equal(logs[0].before, null);
    assert.equal(logs[0].after.draft_reply, reply);
    assert.equal(logs[0].after.approval_status, 'PENDING_REVIEW');
    assert.equal(logs[0].meta.conversation_id, uid);
  });

  test('a manager edit stores before and after text', async () => {
    const uid = `audit_edit_${Date.now()}`;
    const before = 'Dạ tổng đơn 150.000đ ạ';
    const after = 'Dạ tổng đơn 160.000đ ạ';
    const draft = await makeDraft(uid, before);

    const saved = await drafts.updateDraft(draft.id, { draft_reply: after }, { actorName: 'Hoa' });
    assert.equal(saved.draft.approval_status, 'PENDING_REVIEW');
    assert.equal(saved.draft.draft_reply, after);

    const { logs } = await audit.list({ entity_id: draft.id, action: 'draft.edited' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].actor, 'manager:Hoa');
    assert.equal(logs[0].before.draft_reply, before);
    assert.equal(logs[0].after.draft_reply, after);
    assert.equal(logs[0].before.approval_status, 'PENDING_REVIEW');
  });

  test('approve and send writes audit rows and does not auto-send before that', async () => {
    const uid = `audit_send_${Date.now()}`;
    const reply = 'Dạ em gửi xác nhận đơn 150.000đ ạ';
    const draft = await makeDraft(uid, reply);
    const pending = await audit.list({ entity_id: draft.id, action: 'draft.sent' });
    assert.equal(pending.logs.length, 0);

    zaloService.getTokens = () => ({ accessToken: SECRET });
    zaloService.sendTextMessage = async () => ({ message_id: 'sent-1' });
    try {
      const result = await drafts.updateDraft(draft.id, { send: true }, { actorName: 'Minh' });
      assert.equal(result.draft.approval_status, 'SENT');
      assert.equal(result.send.sent, true);

      const approved = await audit.list({ entity_id: draft.id, action: 'draft.approved' });
      const sent = await audit.list({ entity_id: draft.id, action: 'draft.sent' });
      assert.equal(approved.logs.length, 1);
      assert.equal(approved.logs[0].actor, 'manager:Minh');
      assert.equal(approved.logs[0].before.approval_status, 'PENDING_REVIEW');
      assert.equal(approved.logs[0].after.draft_reply, reply);
      assert.equal(sent.logs.length, 1);
      assert.equal(sent.logs[0].actor, 'manager:Minh');
      assert.equal(sent.logs[0].after.approval_status, 'SENT');
      assert.equal(JSON.stringify(sent.logs).includes(SECRET), false);
      assert.equal(JSON.stringify(approved.logs).includes(SECRET), false);
    } finally {
      restore();
    }
  });

  test('inbound, AI draft, and KiotViet push share one trail', async () => {
    const uid = `audit_chain_${Date.now()}`;
    const calls = [];
    process.env.KIOTVIET_CLIENT_ID = 'client';
    process.env.KIOTVIET_CLIENT_SECRET = SECRET;
    process.env.KIOTVIET_RETAILER = 'shop';
    delete process.env.HITL_REQUIRE_APPROVAL;
    stockGate.assessItems = async () => ({ decision: 'ok', lines: [], summary: 'đủ hàng' });
    kiotviet.pushOrder = async () => ({
      ok: true,
      kiotOrderCode: 'DH001',
      raw: { access_token: SECRET },
    });
    aiAgent.respond = async () => ({
      text: 'Dạ em đã lên đơn ORD-AUDIT-1 tổng 150.000đ',
      tokensUsed: 1,
      handoff: null,
      newOrder: {
        order_number: 'ORD-AUDIT-1',
        total: 150000,
        payment: 'cod',
        customerName: 'Khach A',
        access_token: SECRET,
        items: [{ sku: 'DMF-DG-001', product_name: 'Dầu gội', quantity: 1, unit_price: 150000 }],
      },
      stockHold: null,
    });

    try {
      const result = await pipeline.handleMessage({
        channel: 'oa',
        externalKey: uid,
        replyTo: uid,
        text: 'Chốt 1 chai dầu gội 150.000đ',
        msgId: `m-${uid}`,
        senderName: 'Khach A',
        send: async (_to, text) => {
          calls.push(text);
          return true;
        },
        log() {},
      });

      assert.equal(result.held, true);
      assert.equal(result.order, 'ORD-AUDIT-1');
      assert.equal(calls.length, 0, 'AI reply must stay unsent');

      const { logs } = await audit.list({ conversation: uid });
      const actions = logs.map(row => row.action);
      assert.equal(actions.includes('message.received'), true);
      assert.equal(actions.includes('draft.created'), true);
      assert.equal(actions.includes('order.pushed'), true);

      const message = logs.find(row => row.action === 'message.received');
      assert.equal(message.actor, 'system');
      assert.match(message.after.summary, /dầu gội/i);
      assert.ok(message.after.received_at);

      const draft = logs.find(row => row.action === 'draft.created');
      assert.equal(draft.actor, 'ai');
      assert.equal(draft.after.approval_status, 'PENDING_REVIEW');
      assert.match(draft.after.draft_reply, /150\.000đ/);

      const pushed = logs.find(row => row.action === 'order.pushed');
      assert.equal(pushed.actor, 'system');
      assert.equal(pushed.entity_type, 'order');
      assert.equal(pushed.entity_id, 'ORD-AUDIT-1');
      assert.equal(pushed.after.kiot_order_code, 'DH001');
      assert.equal(pushed.after.items[0].unit_price, 150000);
      assert.equal(pushed.meta.order_number, 'ORD-AUDIT-1');
      assert.equal(pushed.meta.automated, true);

      const byOrder = await audit.list({ order: 'ORD-AUDIT-1' });
      assert.equal(byOrder.logs.some(row => row.action === 'order.pushed'), true);
      assert.equal(JSON.stringify(logs).includes(SECRET), false);
      assert.equal(JSON.stringify(byOrder.logs).includes(SECRET), false);

      const receivedAt = actions.indexOf('message.received');
      const draftedAt = actions.indexOf('draft.created');
      const pushedAt = actions.indexOf('order.pushed');
      assert.equal(receivedAt < draftedAt, true);
      assert.equal(draftedAt < pushedAt, true);
    } finally {
      restore();
    }
  });

  test('snapshots redact tokens and passwords', async () => {
    const id = `audit_redact_${Date.now()}`;
    const row = await audit.record({
      actor: 'system',
      action: 'draft.created',
      entity_type: 'draft',
      entity_id: id,
      before: { access_token: SECRET, draft_reply: 'Dạ 150.000đ' },
      after: { authorization: `Bearer ${SECRET}`, note: 'giá 150.000đ' },
      meta: { password: 'p@ss', conversation_id: id },
    });
    assert.ok(row);
    assert.equal(row.before.access_token, '[redacted]');
    assert.equal(row.before.draft_reply, 'Dạ 150.000đ');
    assert.equal(row.after.authorization, '[redacted]');
    assert.equal(row.meta.password, '[redacted]');
    assert.equal(JSON.stringify(row).includes(SECRET), false);
    assert.equal(JSON.stringify(row).includes('p@ss'), false);

    const edited = await audit.record({
      actor: 'manager:Hoa',
      action: 'draft.edited',
      entity_type: 'draft',
      entity_id: `${id}_inline`,
      before: null,
      after: { draft_reply: `access_token=${SECRET} tổng 150.000đ` },
      meta: {},
    });
    assert.match(edited.after.draft_reply, /150\.000đ/);
    assert.equal(edited.after.draft_reply.includes(SECRET), false);
  });

  test('list query binds each filter and rejects a bad date', async () => {
    const q = audit.queryFrom({
      conversation: 'u1',
      order: 'ORD-1',
      from: '2026-09-01',
      to: '2026-09-24',
      limit: 50,
    });
    const built = audit.buildListQuery(q);
    assert.match(built.sql, /LIMIT \$9/);
    assert.match(built.sql, /ORDER BY at ASC/);
    assert.deepEqual(built.params.slice(0, 6), ['u1', 'u1', 'u1', 'u1', 'ORD-1', 'ORD-1']);
    assert.equal(built.params[8], 50);

    const recent = audit.buildListQuery(audit.queryFrom({}));
    assert.match(recent.sql, /ORDER BY at DESC/);
    assert.deepEqual(recent.params, [100]);

    await assert.rejects(
      () => audit.list({ from: 'not-a-date' }),
      (err) => err.status === 400
    );
    assert.equal(audit.orderStatusAction('confirmed'), 'order.confirmed');
    assert.equal(audit.orderStatusAction('packed'), 'order.status_changed');
    assert.equal(audit.staffActor('Lan'), 'staff:Lan');
    assert.equal(audit.managerActor(''), 'manager');
  });
});
