/**
 * On-shift selection, off-hours fallback, and handover when the customer
 * asks for a person or a draft is marked NEEDS_HUMAN / claim.
 * A normal sales draft is not assigned and is not auto-sent.
 */
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.NODE_ENV = 'test';
if (!process.env.DRAFTS_JSON_PATH) {
  process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `roster-drafts-${process.pid}.json`);
}
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;
delete process.env.OWNER_DISPLAY_NAME;

const { describe, test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const roster = require('../services/roster');
const handover = require('../services/handover');
const pipeline = require('../services/pipeline');
const drafts = require('../services/drafts');
const aiAgent = require('../services/aiAgent');
const bot = require('../services/zaloBotService');
const hitlAdmin = require('../services/hitlAdmin');
const rosterPage = require('../services/rosterPage');

const THU_10 = new Date('2026-09-24T10:00:00+07:00');
const THU_17 = new Date('2026-09-24T17:00:00+07:00');
const FRI_22 = new Date('2026-09-25T22:00:00+07:00');
const SAT_23 = new Date('2026-09-26T23:00:00+07:00');
const SUN_03 = new Date('2026-09-27T03:00:00+07:00');
const SUN_20 = new Date('2026-09-27T20:00:00+07:00');

const sent = [];
const originalSend = bot.sendStaffNotice;
const originalRespond = aiAgent.respond;

function ictShift(partial) {
  return roster.upsert({
    timezone: 'Asia/Ho_Chi_Minh',
    active: true,
    online: false,
    ...partial,
  });
}

describe('staff roster and handover', { concurrency: 1 }, () => {
  beforeEach(() => {
    roster.resetForTests();
    handover.resetForTests();
    sent.length = 0;
    process.env.ALERT_BOT_CHAT_ID = 'owner-chat';
    delete process.env.HITL_REQUIRE_APPROVAL;
    delete process.env.HITL_ACK_MESSAGE;
    delete process.env.OWNER_DISPLAY_NAME;
    bot.sendStaffNotice = async (chatId, text) => {
      sent.push({ chatId: String(chatId), text: String(text) });
      return { ok: true };
    };
  });

  afterEach(() => {
    bot.sendStaffNotice = originalSend;
    aiAgent.respond = originalRespond;
    delete process.env.ALERT_BOT_CHAT_ID;
    delete process.env.ADMIN_PASSWORD;
  });

  test('cron-like window parses and overnight hours stay on the shift that started them', () => {
    const day = roster.parseWindow('mon-fri 8-17');
    assert.deepEqual(day.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(day.start_min, 8 * 60);
    assert.equal(day.end_min, 17 * 60);

    const overnight = roster.parseWindow('6 22:00-06:00');
    const shift = {
      active: true,
      weekdays: overnight.weekdays,
      start_min: overnight.start_min,
      end_min: overnight.end_min,
      timezone: 'Asia/Ho_Chi_Minh',
    };
    assert.equal(roster.covers(shift, SAT_23), true);
    assert.equal(roster.covers(shift, SUN_03), true);
    assert.equal(roster.covers(shift, SUN_20), false);
    assert.equal(roster.covers({ ...shift, weekdays: day.weekdays, start_min: day.start_min, end_min: day.end_min }, THU_17), false);
  });

  test('on-shift pick prefers the online person, otherwise anyone on shift', async () => {
    const lan = await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '1-5 08:00-17:00', online: false });
    const minh = await ictShift({ name: 'Minh', notify_target: 'chat-minh', window: '1-5 08:00-17:00', online: true });
    const weekend = await ictShift({ name: 'An', notify_target: 'chat-an', window: '6 09:00-12:00', online: true });

    const picked = roster.select([lan, minh, weekend], THU_10);
    assert.equal(picked.mode, 'online');
    assert.equal(picked.staff.name, 'Minh');

    minh.online = false;
    const anyOnShift = roster.select([lan, minh, weekend], THU_10);
    assert.equal(anyOnShift.mode, 'on_shift');
    assert.equal(anyOnShift.staff.name, 'Lan');
  });

  test('off-hours falls forward to the next shift, or the owner when the roster is empty', async () => {
    const lan = await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '1-5 08:00-17:00' });
    const next = roster.select([lan], FRI_22);
    assert.equal(next.mode, 'next_shift');
    assert.equal(next.staff.name, 'Lan');
    assert.equal(next.next_label, 'T2 08:00');

    const owner = roster.select([], SUN_20);
    assert.equal(owner.mode, 'owner');
    assert.equal(owner.staff.name, 'Chủ farm');
    assert.equal(owner.staff.notify_target, null);

    await roster.remove(lan.id);
    const assigned = await handover.escalate({
      ticketStatus: 'NEEDS_HUMAN',
      externalId: 'off-hours-owner',
      reason: 'Ngoài giờ',
      lastMessage: 'cần người',
    }, SUN_20);
    assert.equal(assigned.mode, 'owner');
    assert.equal(assigned.label, 'NEEDS_HUMAN');
    assert.equal(assigned.assignee_name, 'Chủ farm');
    assert.deepEqual(sent.map(m => m.chatId), ['owner-chat']);
    assert.match(sent[0].text, /Chủ farm/);
    assert.match(sent[0].text, /NEEDS_HUMAN/);
  });

  test('NEEDS_HUMAN and claim assign the on-shift agent and notify both chats', async () => {
    await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '* 00:00-24:00', online: true });

    const fromTicket = await handover.escalate({
      ticketStatus: 'NEEDS_HUMAN',
      externalId: 'needs-1',
      customer: { display_name: 'Chị Hoa', phone: '0901' },
      lastMessage: 'đơn này sai',
    });
    assert.equal(fromTicket.source, 'needs_human');
    assert.equal(fromTicket.label, 'NEEDS_HUMAN');
    assert.equal(fromTicket.mode, 'online');
    assert.equal(fromTicket.assignee_name, 'Lan');
    assert.deepEqual(sent.map(m => m.chatId).sort(), ['chat-lan', 'owner-chat']);
    assert.match(sent[0].text, /Giao cho: Lan/);
    assert.match(sent[0].text, /NEEDS_HUMAN/);

    const again = await handover.escalate({
      ticketStatus: 'NEEDS_HUMAN',
      externalId: 'needs-1',
      lastMessage: 'đơn này sai',
    });
    assert.equal(again.deduped, true);
    assert.equal(sent.length, 2);

    sent.length = 0;
    const claimed = await handover.escalate({
      claim: true,
      externalId: 'claim-1',
      lastMessage: 'tôi nhận ca này',
    });
    assert.equal(claimed.source, 'claim');
    assert.equal(claimed.label, 'NEEDS_HUMAN');
    assert.equal(claimed.assignee_name, 'Lan');
    assert.equal(handover.classifyHumanNeed({ ticketStatus: 'Mới tiếp nhận' }), null);
  });

  test('customer human-request intent hands off and does not send the reply', async () => {
    await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '* 00:00-24:00', online: true });
    const uid = `human_${Date.now()}`;
    const calls = [];
    const result = await pipeline.handleMessage({
      channel: 'oa',
      externalKey: uid,
      replyTo: uid,
      text: 'Tôi muốn gặp người thật',
      msgId: `m-${uid}`,
      senderName: 'Chị Hoa',
      send: async (_to, text) => {
        calls.push(text);
        return true;
      },
      log() {},
    });

    assert.equal(result.stopped, true);
    assert.equal(result.held, true);
    assert.equal(result.assignee, 'Lan');
    assert.equal(calls.length, 0, 'human-request reply must stay a draft');

    const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
    const draft = rows.find(d => d.customer_user_id === uid);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.ticket_status, 'NEEDS_HUMAN');
    assert.match(draft.draft_reply, /dừng trả lời tự động/);
    assert.doesNotMatch(draft.draft_reply, /150|chốt đơn/);

    const [row] = await handover.recent(5);
    assert.equal(row.source, 'wants_human');
    assert.equal(row.label, 'NEEDS_HUMAN');
    assert.equal(row.assignee_name, 'Lan');
    assert.ok(sent.some(m => m.chatId === 'chat-lan' && /gặp người thật/i.test(m.text)));
  });

  test('approve flow marks NEEDS_HUMAN or claim, and a normal send does not', async () => {
    await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '* 00:00-24:00', online: false });
    const sales = await drafts.createDraft({
      channel: 'zalo',
      customer_user_id: `sales_${Date.now()}`,
      customer_name: 'Khach A',
      customer_intent: 'gia dau goi',
      draft_reply: 'Dạ dầu gội 150.000đ một chai ạ',
      assigned_department: 'Sales',
      ticket_status: 'Mới tiếp nhận',
    });
    const sentDraft = await drafts.updateDraft(sales.id, { send: true });
    assert.equal(sentDraft.draft.approval_status === 'SENT' || sentDraft.draft.approval_status === 'APPROVED', true);
    assert.equal((await handover.recent(10)).length, 0);
    assert.equal(sent.length, 0);

    const urgent = await drafts.createDraft({
      channel: 'zalo',
      customer_user_id: `urgent_${Date.now()}`,
      customer_name: 'Khach B',
      customer_intent: 'ảnh không rõ',
      draft_reply: 'Dạ mình kiểm tra lại giúp ạ',
      assigned_department: 'Sales',
      ticket_status: 'Mới tiếp nhận',
    });
    await drafts.updateDraft(urgent.id, { ticket_status: 'NEEDS_HUMAN' });
    const [marked] = await handover.recent(5);
    assert.equal(marked.source, 'needs_human');
    assert.equal(marked.label, 'NEEDS_HUMAN');
    assert.equal(marked.assignee_name, 'Lan');
    assert.equal(marked.mode, 'on_shift');
    assert.equal(urgent.approval_status, 'PENDING_REVIEW');

    sent.length = 0;
    const claimDraft = await drafts.createDraft({
      channel: 'zalo',
      customer_user_id: `claim_${Date.now()}`,
      customer_name: 'Khach C',
      customer_intent: 'nhận xử lý',
      draft_reply: 'Dạ em ghi nhận ạ',
      ticket_status: 'Mới tiếp nhận',
    });
    await drafts.updateDraft(claimDraft.id, { claim: true });
    const rows = await handover.recent(5);
    assert.ok(rows.some(r => r.source === 'claim' && r.external_id === claimDraft.customer_user_id));
    assert.equal(claimDraft.approval_status, 'PENDING_REVIEW');
  });

  test('a normal sales turn is not assigned', async () => {
    await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '* 00:00-24:00', online: true });
    const reply = 'Dạ dầu gội bồ kết bên farm giá 150.000đ một chai ạ';
    aiAgent.respond = async () => ({ text: reply, tokensUsed: 1, handoff: null, newOrder: null });
    const uid = `sales_turn_${Date.now()}`;
    const calls = [];
    const result = await pipeline.handleMessage({
      channel: 'oa',
      externalKey: uid,
      replyTo: uid,
      text: 'Dau goi gia bao nhieu?',
      msgId: `m-${uid}`,
      senderName: 'Khach A',
      send: async (_to, text) => {
        calls.push(text);
        return true;
      },
      log() {},
    });
    assert.equal(result.held, true);
    assert.equal(result.handoff, false);
    assert.equal(calls.length, 0);
    const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
    const draft = rows.find(d => d.customer_user_id === uid);
    assert.equal(draft.draft_reply, reply);
    assert.equal(draft.ticket_status, 'Mới tiếp nhận');
    assert.equal((await handover.recent(10)).length, 0);
    assert.equal(sent.length, 0);
  });

  test('Omni Sale DMF roster page lists a shift and who received the handoff', async () => {
    const lan = await ictShift({ name: 'Lan', notify_target: 'chat-lan', window: '1-5 08:00-17:00', online: true });
    await handover.escalate({
      wantsHuman: true,
      externalId: 'page-1',
      reason: 'Khách yêu cầu gặp người thật',
      lastMessage: 'cho gặp nhân viên',
    }, THU_10);
    const html = rosterPage.render({
      shifts: await roster.list(),
      handoffs: await handover.recent(5),
      flash: null,
      error: null,
    });
    assert.match(html, /Omni Sale DMF/);
    assert.match(html, /Lan/);
    assert.match(html, /chat-lan/);
    assert.match(html, /NEEDS_HUMAN/);
    assert.match(html, /Asia\/Ho_Chi_Minh/);
    assert.match(html, /Zalo Bot/);
    assert.equal(lan.timezone, 'Asia/Ho_Chi_Minh');

    process.env.ADMIN_PASSWORD = 'secret';
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    hitlAdmin.mount(app);
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      const headers = {
        Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
      };
      const locked = await fetch(`${base}/admin/roster`, { redirect: 'manual' });
      assert.equal(locked.status, 303);

      const page = await fetch(`${base}/admin/roster`, { headers });
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.match(body, /Omni Sale DMF/);
      assert.match(body, />Lan</);

      const created = await fetch(`${base}/admin/roster`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          action: 'save',
          name: 'Minh',
          notify_target: 'chat-minh',
          weekdays: 'mon-fri',
          start: '09:00',
          end: '18:00',
          active: '1',
        }),
      });
      assert.equal(created.status, 303);
      const names = (await roster.list()).map(s => s.name).sort();
      assert.deepEqual(names, ['Lan', 'Minh']);
      const minh = (await roster.list()).find(s => s.name === 'Minh');
      assert.equal(minh.online, false);
      assert.equal(minh.active, true);
      assert.deepEqual(minh.weekdays, [1, 2, 3, 4, 5]);

      const on = await fetch(`${base}/admin/roster`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ action: 'online', id: minh.id, online: '1' }),
      });
      assert.equal(on.status, 303);
      assert.equal((await roster.list()).find(s => s.id === minh.id).online, true);
    } finally {
      await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    }
  });
});

after(() => {
  bot.sendStaffNotice = originalSend;
  delete process.env.ALERT_BOT_CHAT_ID;
  delete process.env.ADMIN_PASSWORD;
});
