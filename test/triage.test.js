/**
 * Inbox triage: Hot buy intent, Urgent refund/return with no approval
 * language, Normal FAQ still PENDING_REVIEW. No channel auto-sends.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `triage-drafts-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const triage = require('../services/triage');
const stations = require('../services/stations');
const aiAgent = require('../services/aiAgent');
const drafts = require('../services/drafts');
const pipeline = require('../services/pipeline');
const handover = require('../services/handover');

const AI = 'Dạ dầu gội bồ kết bên farm giá 150.000đ một chai ạ';

function mockAi() {
  const calls = [];
  aiAgent.respond = async (id, text) => {
    calls.push(text);
    return { text: AI, tokensUsed: 3, handoff: null, newOrder: null };
  };
  return calls;
}

function inbound(channel, uid, text) {
  const calls = [];
  const msg = {
    channel,
    externalKey: uid,
    replyTo: uid,
    text,
    msgId: `m-${uid}`,
    senderName: 'Khach A',
    send: async (to, body) => {
      calls.push({ to, body });
      return { message_id: 'should-not-send' };
    },
    log() {},
  };
  if (channel === 'bot') {
    msg.externalKey = `bot_${uid}`;
    msg.replyTo = uid;
  }
  if (channel === 'messenger') {
    msg.externalKey = `fb_${uid}`;
    msg.replyTo = uid;
  }
  return { msg, calls };
}

async function draftFor(uid) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find(d => d.customer_user_id === uid) || null;
}

describe('triage labels', () => {
  test('buy intent, order, price plus quantity, and checkout are Hot', () => {
    for (const text of [
      'Em muốn mua 2 chai nước nghệ',
      'Chốt đơn giúp mình',
      'Giá 2 hộp dầu gội bao nhiêu',
      'Mình ck khoản này nha',
    ]) {
      const out = triage.classify(text);
      assert.equal(out.level, 'hot', text);
      assert.equal(out.label, 'Nóng');
      assert.equal(out.skipModel, false);
    }
  });

  test('a price or shipping question without an order is Normal', () => {
    for (const text of [
      'Dau goi gia bao nhieu?',
      'Cách dùng và thành phần nước nghệ là gì?',
      'Phí ship về Đà Nẵng bao nhiêu?',
    ]) {
      const out = triage.classify(text);
      assert.equal(out.level, 'normal', text);
      assert.equal(out.label, 'Thường');
    }
    assert.equal(stations.filterAndRoute('Dau goi gia bao nhieu?').route, 'sales');
    assert.equal(stations.filterAndRoute('Cách dùng và thành phần nước nghệ là gì?').route, 'faq');
  });

  test('refund, return, exchange, and complaint are Urgent and do not approve', () => {
    for (const text of [
      'Tôi muốn hoàn tiền',
      'Cho mình đổi trả hàng',
      'Đổi hàng đặc biệt giúp em',
      'Tôi muốn khiếu nại chai bị hỏng',
    ]) {
      const out = triage.classify(text);
      assert.equal(out.level, 'urgent', text);
      assert.equal(out.label, 'Khẩn');
      assert.equal(out.skipModel, true);
      assert.equal(out.needsHuman, true);
      assert.equal(triage.hasApprovalLanguage(out.safeDraft), false, text);
    }
    assert.equal(triage.hasApprovalLanguage('Dạ em đã duyệt hoàn tiền cho mình'), true);
    assert.equal(stations.filterAndRoute('Tôi muốn hoàn tiền').route, 'needs-human');
    const human = triage.classify('Cho gặp người thật, hàng bị hỏng');
    assert.equal(human.level, 'urgent');
    assert.equal(human.label, 'Khẩn');
  });
});

describe('triage on the inbound pipeline', { concurrency: 1 }, () => {
  test('Hot buy intent stays PENDING_REVIEW and is not sent', async () => {
    delete process.env.HITL_REQUIRE_APPROVAL;
    const aiCalls = mockAi();
    const uid = `hot_${Date.now()}`;
    const { msg, calls } = inbound('oa', uid, 'Em muốn mua 2 chai nước nghệ, chốt đơn');
    const result = await pipeline.handleMessage(msg);

    assert.equal(result.ok, true);
    assert.equal(result.held, true);
    assert.equal(result.triage, 'hot');
    assert.equal(aiCalls.length, 1);
    assert.equal(calls.length, 0);

    const draft = await draftFor(uid);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.triage_level, 'hot');
    assert.equal(draft.triage_label, 'Nóng');
    assert.equal(draft.draft_reply, AI);
    assert.equal(draft.assigned_department, 'Sales');
    assert.equal(draft.ticket_status, 'Mới tiếp nhận');
    assert.match(draft.customer_intent, /^\[sales\] /);
  });

  test('Urgent refund and return skip the model, do not approve, and flag a human', async () => {
    delete process.env.HITL_REQUIRE_APPROVAL;
    const aiCalls = mockAi();
    const uid = `urgent_${Date.now()}`;
    const { msg, calls } = inbound('oa', uid, 'Tôi muốn hoàn tiền và đổi trả chai này');
    const result = await pipeline.handleMessage(msg);

    assert.equal(result.held, true);
    assert.equal(result.triage, 'urgent');
    assert.equal(result.needsHuman, true);
    assert.ok(result.assignee);
    assert.equal(aiCalls.length, 0, 'the model must not draft a refund');
    assert.equal(calls.length, 0, 'nothing is sent to the customer');

    const draft = await draftFor(uid);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.triage_level, 'urgent');
    assert.equal(draft.triage_label, 'Khẩn');
    assert.equal(draft.ticket_status, 'NEEDS_HUMAN');
    assert.equal(draft.assigned_department, 'Người thật');
    assert.match(draft.customer_intent, /\[needs-human\]/);
    assert.equal(triage.hasApprovalLanguage(draft.draft_reply), false);
    assert.match(draft.draft_reply, /chưa phải xác nhận/);
    assert.match(draft.draft_reply, /Nhân viên farm sẽ xem/);
    assert.doesNotMatch(draft.draft_reply, /đã duyệt|đã hoàn|đồng ý hoàn|approved/i);

    const rows = await handover.recent(20);
    assert.ok(rows.some(r => r.external_id === uid && r.label === 'NEEDS_HUMAN'));
  });

  test('Urgent exchange stays held even when auto-send is switched off', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    const aiCalls = mockAi();
    const uid = `urgent_off_${Date.now()}`;
    const { msg, calls } = inbound('bot', uid, 'Đổi hàng đặc biệt, hoàn tiền giúp em');
    const result = await pipeline.handleMessage(msg);
    assert.equal(result.held, true);
    assert.equal(result.triage, 'urgent');
    assert.equal(aiCalls.length, 0);
    assert.equal(calls.length, 0);
    const draft = await draftFor(`bot_${uid}`);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.channel, 'zalo');
    assert.equal(draft.triage_label, 'Khẩn');
    assert.equal(triage.hasApprovalLanguage(draft.draft_reply), false);
    delete process.env.HITL_REQUIRE_APPROVAL;
  });

  test('Normal FAQ draft is PENDING_REVIEW on Messenger and is not sent', async () => {
    delete process.env.HITL_REQUIRE_APPROVAL;
    delete process.env.HITL_ACK_MESSAGE;
    const aiCalls = mockAi();
    const uid = `faq_${Date.now()}`;
    const { msg, calls } = inbound('messenger', uid, 'Cách dùng và thành phần nước nghệ là gì?');
    const result = await pipeline.handleMessage(msg);

    assert.equal(result.held, true);
    assert.equal(result.triage, 'normal');
    assert.equal(aiCalls.length, 1);
    assert.equal(calls.length, 0);

    const draft = await draftFor(`fb_${uid}`);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.channel, 'messenger');
    assert.equal(draft.triage_level, 'normal');
    assert.equal(draft.triage_label, 'Thường');
    assert.equal(draft.draft_reply, AI);
    assert.equal(draft.assigned_department, 'FAQ');
    assert.match(draft.customer_intent, /^\[faq\] /);
  });

  test('the admin list can filter the three levels', async () => {
    const hot = await drafts.listDrafts({ triage: 'hot' });
    const urgent = await drafts.listDrafts({ triage: 'urgent' });
    const normal = await drafts.listDrafts({ triage: 'normal' });
    assert.ok(hot.drafts.some(d => d.triage_level === 'hot'));
    assert.ok(urgent.drafts.every(d => d.triage_level === 'urgent'));
    assert.ok(normal.drafts.some(d => d.triage_level === 'normal'));
    assert.ok(normal.drafts.every(d => d.triage_level === 'normal'));
    await assert.rejects(() => drafts.listDrafts({ triage: 'nope' }), /triage không hợp lệ/);
  });
});

test('admin queue exposes the three triage filters and badges', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  assert.match(html, /data-triage="hot"/);
  assert.match(html, /data-triage="urgent"/);
  assert.match(html, /data-triage="normal"/);
  assert.match(html, /Nóng/);
  assert.match(html, /Khẩn/);
  assert.match(html, /Thường/);
  assert.match(js, /triage_level/);
  assert.match(js, /triage_label/);
  assert.match(js, /q\.set\('triage', triage\)/);
});
