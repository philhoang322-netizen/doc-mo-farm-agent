/**
 * Live KiotViet stock before chốt đơn.
 * Enough stock continues the draft/order path (still PENDING_REVIEW).
 * Low stock drafts a “sắp hết” warning and does not confirm.
 * Zero or insufficient stock blocks the order.
 */
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `stock-drafts-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;
delete process.env.KIOTVIET_CLIENT_ID;
delete process.env.KIOTVIET_CLIENT_SECRET;
delete process.env.KIOTVIET_RETAILER;
delete process.env.STOCK_LOW_THRESHOLD;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const aiAgent = require('../services/aiAgent');
const db = require('../services/database');
const drafts = require('../services/drafts');
const kiotviet = require('../services/kiotviet');
const pipeline = require('../services/pipeline');
const stockGate = require('../services/stockGate');

const realEnabled = kiotviet.enabled;
const realGetOnHand = kiotviet.getOnHand;
const realPush = kiotviet.pushOrder;
const realCreate = db.createOrderNew;
const realRespond = aiAgent.respond;

const CUSTOMER = { id: 'cust-1', display_name: 'Lan', phone: null };

function stock(available, extra = {}) {
  const onHand = extra.onHand != null ? extra.onHand : available;
  const reserved = extra.reserved || 0;
  return {
    ok: true,
    sku: extra.sku || 'DMF-NGM-001',
    name: extra.name || 'Nước gừng lên men',
    onHand,
    reserved,
    available,
    productId: 11,
    branchId: 1,
  };
}

function orderInput(quantity, extra = {}) {
  return {
    items: [{
      product_name: extra.product_name || 'Nước gừng lên men',
      sku: extra.sku || 'DMF-NGM-001',
      quantity,
      unit_price: 95000,
    }],
    payment_method: 'cod',
  };
}

function inbound(uid, text, send) {
  return {
    channel: 'oa',
    externalKey: uid,
    replyTo: uid,
    text,
    msgId: `m-${uid}`,
    senderName: 'Lan',
    send,
    log() {},
  };
}

async function draftFor(uid) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find(d => d.customer_user_id === uid) || null;
}

function useStock(getOnHand) {
  kiotviet.enabled = () => true;
  kiotviet.getOnHand = getOnHand;
}

function restore() {
  kiotviet.enabled = realEnabled;
  kiotviet.getOnHand = realGetOnHand;
  kiotviet.pushOrder = realPush;
  db.createOrderNew = realCreate;
  aiAgent.respond = realRespond;
  delete process.env.STOCK_LOW_THRESHOLD;
  delete process.env.HITL_REQUIRE_APPROVAL;
  delete process.env.HITL_ACK_MESSAGE;
}

describe('KiotViet on-hand parsing', () => {
  test('uses onHand minus reserved at the branch, and accepts onhand', () => {
    const parsed = kiotviet.sellableFromInventories([
      { branchId: 1, onHand: 10, reserved: 4 },
      { branchId: 2, onHand: 80, reserved: 0 },
    ], 1);
    assert.deepEqual(parsed, { onHand: 10, reserved: 4, available: 6 });

    const lower = kiotviet.sellableFromInventories([
      { branchId: 1, onhand: 3, reserved: 1 },
    ], 1);
    assert.equal(lower.available, 2);

    assert.deepEqual(
      kiotviet.sellableFromInventories([{ branchId: 2, onHand: 9, reserved: 0 }], 1),
      { onHand: 0, reserved: 0, available: 0 }
    );
    assert.equal(kiotviet.sellableFromInventories([], 1), null);
    assert.equal(
      kiotviet.sellableFromInventories([{ branchId: 1, onHand: 1, reserved: 5 }], 1).available,
      0
    );
  });

  test('getOnHand stays local when the retailer is not configured', async () => {
    const result = await kiotviet.getOnHand({ sku: 'DMF-NGM-001', name: 'Nước gừng lên men' });
    assert.deepEqual(result, { ok: false, reason: 'disabled' });
  });
});

describe('STOCK_LOW_THRESHOLD', () => {
  test('defaults to 5 and splits ok / low / blocked', () => {
    delete process.env.STOCK_LOW_THRESHOLD;
    assert.equal(stockGate.threshold(), 5);
    const limit = stockGate.threshold();
    assert.equal(stockGate.classifyLine({ available: 5, requested: 1, threshold: limit }), 'ok');
    assert.equal(stockGate.classifyLine({ available: 4, requested: 1, threshold: limit }), 'low');
    assert.equal(stockGate.classifyLine({ available: 1, requested: 1, threshold: limit }), 'low');
    assert.equal(stockGate.classifyLine({ available: 0, requested: 1, threshold: limit }), 'blocked');
    assert.equal(stockGate.classifyLine({ available: 3, requested: 5, threshold: limit }), 'blocked');
  });
});

describe('order confirm stock gate', { concurrency: 1 }, () => {
  test('enough stock proceeds to the order and a PENDING_REVIEW draft', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    delete process.env.HITL_REQUIRE_APPROVAL;
    const events = [];
    let pushed = 0;
    useStock(async () => {
      events.push('stock');
      return stock(12);
    });
    db.createOrderNew = async () => {
      events.push('create');
      return { order_number: 'ORD-OK-1', id: 1 };
    };
    kiotviet.pushOrder = async () => {
      pushed += 1;
      return { ok: true, kiotOrderCode: 'DH0001' };
    };

    const uid = `stock_ok_${Date.now()}`;
    try {
      const outcome = await aiAgent.attemptCreateOrder(CUSTOMER, orderInput(2), uid);
      assert.equal(outcome.decision, 'ok');
      assert.deepEqual(events, ['stock', 'create']);
      assert.match(outcome.toolResult, /ORD-OK-1/);
      assert.doesNotMatch(outcome.toolResult, /CHƯA TẠO ĐƠN/);

      const modelText = 'Dạ em đã lên đơn ORD-OK-1, tổng 190.000đ ạ.';
      const flags = aiAgent.finalizeReply(uid, modelText);
      assert.equal(flags.text, modelText);
      assert.equal(flags.stockHold, null);
      assert.equal(flags.newOrder.order_number, 'ORD-OK-1');

      aiAgent.respond = async () => ({
        text: flags.text,
        tokensUsed: 4,
        handoff: flags.handoff,
        newOrder: flags.newOrder,
        stockHold: flags.stockHold,
      });
      const calls = [];
      const result = await pipeline.handleMessage(inbound(uid, 'chốt 2 chai nước gừng', async (_to, text) => {
        calls.push(text);
        return { message_id: 'should-not-send' };
      }));

      assert.equal(result.ok, true);
      assert.equal(result.held, true);
      assert.equal(result.order, 'ORD-OK-1');
      assert.equal(calls.length, 0, 'Zalo send must not run');
      assert.equal(pushed, 1);

      const draft = await draftFor(uid);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.draft_reply, modelText);
      assert.equal(draft.assigned_department, 'Sales');
    } finally {
      restore();
    }
  });

  test('low stock drafts a sắp hết warning and does not confirm', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    delete process.env.HITL_REQUIRE_APPROVAL;
    let created = 0;
    let pushed = 0;
    useStock(async () => stock(3));
    db.createOrderNew = async () => {
      created += 1;
      return { order_number: 'ORD-SHOULD-NOT' };
    };
    kiotviet.pushOrder = async () => {
      pushed += 1;
      return { ok: true };
    };

    const uid = `stock_low_${Date.now()}`;
    try {
      const outcome = await aiAgent.attemptCreateOrder(CUSTOMER, orderInput(1), uid);
      assert.equal(outcome.decision, 'low');
      assert.equal(created, 0);
      assert.match(outcome.toolResult, /CHƯA TẠO ĐƠN/);
      assert.doesNotMatch(outcome.toolResult, /Đã tạo đơn/);
      assert.match(outcome.draftReply, /sắp hết/);
      assert.match(outcome.draftReply, /chưa chốt/);
      assert.doesNotMatch(outcome.draftReply, /Đã tạo đơn|còn đủ hàng/);

      const flags = aiAgent.finalizeReply(uid, 'Dạ em đã chốt đơn cho mình ạ');
      assert.equal(flags.text, outcome.draftReply);
      assert.equal(flags.newOrder, null);
      assert.equal(flags.stockHold.decision, 'low');
      assert.equal(flags.handoff.urgency, 'high');
      assert.match(flags.handoff.reason, /Sắp hết/);

      aiAgent.respond = async () => ({
        text: flags.text,
        tokensUsed: 2,
        handoff: flags.handoff,
        newOrder: flags.newOrder,
        stockHold: flags.stockHold,
      });
      const calls = [];
      const result = await pipeline.handleMessage(inbound(uid, 'lấy 1 chai nước gừng', async (_to, text) => {
        calls.push(text);
        return true;
      }));

      assert.equal(result.held, true);
      assert.equal(result.order, null);
      assert.equal(result.stock, 'low');
      assert.equal(calls.length, 0);
      assert.equal(pushed, 0);
      assert.equal(created, 0);

      const draft = await draftFor(uid);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.draft_reply, outcome.draftReply);
      assert.equal(draft.ticket_status, 'Cần đối soát kho');
      assert.match(draft.kiot_summary, /DMF-NGM-001/);
      assert.match(draft.kiot_summary, /tồn 3/);
    } finally {
      restore();
    }
  });

  test('low-stock warning stays PENDING_REVIEW even if auto-send is on', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    const warning =
      'Dạ em vừa kiểm tồn kho, Nước gừng lên men (kho còn 2, mình đặt 1) đang sắp hết hàng ạ. ' +
      'Em chưa chốt đơn giúp mình — nhân viên farm sẽ đối soát kho gấp và nhắn lại ngay khi xác nhận được số lượng 🌿';
    const uid = `stock_low_force_${Date.now()}`;
    aiAgent.respond = async () => ({
      text: warning,
      tokensUsed: 1,
      handoff: null,
      newOrder: null,
      stockHold: { decision: 'low', summary: 'Sắp hết hàng (ngưỡng 5) — chưa chốt đơn. DMF-NGM-001: tồn 2, đặt 1 (low)', draftReply: warning },
    });
    const calls = [];
    try {
      const result = await pipeline.handleMessage(inbound(uid, 'lấy 1 chai', async (_to, text) => {
        calls.push(text);
        return { message_id: 'nope' };
      }));
      assert.equal(result.held, true);
      assert.equal(calls.length, 0);
      const draft = await draftFor(uid);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.match(draft.draft_reply, /sắp hết/);
    } finally {
      restore();
    }
  });

  test('zero stock blocks confirm and does not invent availability', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    let created = 0;
    useStock(async () => stock(0));
    db.createOrderNew = async () => {
      created += 1;
      return { order_number: 'ORD-NO' };
    };
    const uid = `stock_zero_${Date.now()}`;
    try {
      const outcome = await aiAgent.attemptCreateOrder(CUSTOMER, orderInput(1), uid);
      assert.equal(outcome.decision, 'blocked');
      assert.equal(created, 0);
      assert.match(outcome.draftReply, /hết hàng/);
      assert.match(outcome.draftReply, /chưa tạo đơn/i);
      assert.doesNotMatch(outcome.draftReply, /Đã tạo đơn|còn hàng nhé|sẵn hàng/);
      assert.match(outcome.toolResult, /CHƯA TẠO ĐƠN/);

      const flags = aiAgent.finalizeReply(uid, 'Dạ còn hàng, em chốt cho mình nha');
      assert.equal(flags.text, outcome.draftReply);
      assert.equal(flags.newOrder, null);

      aiAgent.respond = async () => ({
        text: flags.text,
        tokensUsed: 1,
        handoff: flags.handoff,
        newOrder: null,
        stockHold: flags.stockHold,
      });
      const calls = [];
      const result = await pipeline.handleMessage(inbound(uid, 'lấy 1 chai nước gừng', async (_to, text) => {
        calls.push(text);
        return true;
      }));
      assert.equal(result.held, true);
      assert.equal(result.stock, 'blocked');
      assert.equal(calls.length, 0);
      const draft = await draftFor(uid);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.match(draft.draft_reply, /hết hàng/);
      assert.equal(draft.ticket_status, 'Cần đối soát kho');
    } finally {
      restore();
    }
  });

  test('insufficient qty blocks confirm even when some units remain', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    let created = 0;
    useStock(async () => stock(2));
    db.createOrderNew = async () => {
      created += 1;
      return { order_number: 'ORD-NO' };
    };
    const uid = `stock_short_${Date.now()}`;
    try {
      const outcome = await aiAgent.attemptCreateOrder(CUSTOMER, orderInput(5), uid);
      assert.equal(outcome.decision, 'blocked');
      assert.equal(created, 0);
      assert.match(outcome.draftReply, /còn 2/);
      assert.match(outcome.draftReply, /chưa đủ 5/);
      assert.match(outcome.draftReply, /chưa tạo đơn/i);
      assert.doesNotMatch(outcome.toolResult, /Đã tạo đơn/);
      aiAgent.finalizeReply(uid, 'ignored');
    } finally {
      restore();
    }
  });

  test('a failed lookup blocks confirm instead of guessing', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    let created = 0;
    useStock(async () => ({ ok: false, reason: 'not_found', sku: 'DMF-NGM-001' }));
    db.createOrderNew = async () => {
      created += 1;
      return { order_number: 'ORD-NO' };
    };
    const uid = `stock_miss_${Date.now()}`;
    try {
      const outcome = await aiAgent.attemptCreateOrder(CUSTOMER, orderInput(1), uid);
      assert.equal(outcome.decision, 'blocked');
      assert.equal(created, 0);
      assert.match(outcome.draftReply, /chưa đối được tồn kho/);
      assert.doesNotMatch(outcome.draftReply, /còn \d|hết hàng|Đã tạo đơn/);
      aiAgent.finalizeReply(uid, 'ignored');
    } finally {
      restore();
    }
  });

  test('zero stock blocks the KiotViet push even if an order object exists', async () => {
    process.env.STOCK_LOW_THRESHOLD = '5';
    delete process.env.HITL_REQUIRE_APPROVAL;
    let pushed = 0;
    useStock(async () => stock(0));
    kiotviet.pushOrder = async () => {
      pushed += 1;
      return { ok: true, kiotOrderCode: 'DH-SHOULD-NOT' };
    };
    const uid = `stock_push_${Date.now()}`;
    aiAgent.respond = async () => ({
      text: 'Dạ em đã tạo đơn ORD-RACE',
      tokensUsed: 1,
      handoff: null,
      newOrder: {
        order_number: 'ORD-RACE',
        total: 95000,
        items: [{ sku: 'DMF-NGM-001', product_name: 'Nước gừng lên men', quantity: 1, unit_price: 95000 }],
        payment: 'cod',
        customerName: 'Lan',
      },
      stockHold: null,
    });
    const calls = [];
    try {
      const result = await pipeline.handleMessage(inbound(uid, 'chốt đơn', async (_to, text) => {
        calls.push(text);
        return true;
      }));
      assert.equal(pushed, 0);
      assert.equal(calls.length, 0);
      assert.equal(result.held, true);
      const draft = await draftFor(uid);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
    } finally {
      restore();
    }
  });
});
