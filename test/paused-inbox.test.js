/**
 * A paused customer must still land in the HITL inbox. The model is not
 * called and nothing is sent, including when auto-send is on.
 * POST /admin/api/customers/resume is the /mo equivalent for that key.
 */
const path = require('path');
const os = require('os');
const http = require('http');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `paused-inbox-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.ALERT_BOT_CHAT_ID;
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_API_KEY;

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const aiAgent = require('../services/aiAgent');
const db = require('../services/database');
const drafts = require('../services/drafts');
const handover = require('../services/handover');
const hitlAdmin = require('../services/hitlAdmin');
const notify = require('../services/notify');
const pipeline = require('../services/pipeline');

const AI = 'Dạ dầu gội bồ kết bên farm giá 150.000đ một chai ạ';
const PSID_KEY = 'fb_2624167471043867';

const originalRespond = aiAgent.respond;
const originalGetCustomer = db.getOrCreateCustomer;
const originalByKey = db.getCustomerByExternalId;
const originalResume = db.resumeBot;
const originalNotify = notify.send;

function restore() {
  aiAgent.respond = originalRespond;
  db.getOrCreateCustomer = originalGetCustomer;
  db.getCustomerByExternalId = originalByKey;
  db.resumeBot = originalResume;
  notify.send = originalNotify;
  delete process.env.HITL_REQUIRE_APPROVAL;
  delete process.env.HITL_ACK_MESSAGE;
  delete process.env.ADMIN_PASSWORD;
}

function pausedCustomer(over = {}) {
  return {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    display_name: 'Phil',
    bot_paused: true,
    ...over,
  };
}

async function draftFor(userId) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find((d) => d.customer_user_id === userId) || null;
}

describe('paused customer inbox', { concurrency: 1 }, () => {
  after(() => restore());

  test('paused Messenger text becomes PENDING_REVIEW and does not call the model or send', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    process.env.HITL_ACK_MESSAGE = 'Dạ farm đã nhận, nhân viên xem và trả lời sớm ạ';
    const sends = [];
    const notes = [];
    let aiCalls = 0;
    const events = [];
    aiAgent.respond = async () => {
      aiCalls += 1;
      throw new Error('model must not run for a paused customer');
    };
    notify.send = async (text) => {
      notes.push(text);
      return true;
    };
    db.getOrCreateCustomer = async () => pausedCustomer();
    const before = (await handover.recent(50)).length;

    const text = 'Dau goi gia bao nhieu?';
    const result = await pipeline.handleMessage({
      channel: 'messenger',
      externalKey: PSID_KEY,
      replyTo: '2624167471043867',
      text,
      msgId: `paused-fb-${Date.now()}`,
      senderName: 'Phil',
      send: async (to, body) => {
        sends.push({ to, body });
        return true;
      },
      log(event) { events.push(event); },
    });

    assert.equal(result.skipped, 'paused');
    assert.equal(result.held, true);
    assert.equal(aiCalls, 0);
    assert.equal(sends.length, 0);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /\/mo fb_2624167471043867/);
    assert.match(notes[0], /Dau goi gia bao nhieu/);

    const draft = await draftFor(PSID_KEY);
    assert.ok(draft, 'expected a PENDING_REVIEW draft');
    assert.equal(draft.id, result.draftId);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.channel, 'messenger');
    assert.equal(draft.customer_user_id, PSID_KEY);
    assert.equal(draft.customer_name, 'Phil');
    assert.match(draft.customer_intent, /Dau goi gia bao nhieu\?/);
    assert.equal(draft.draft_reply, pipeline.PAUSED_INBOX_REPLY);
    assert.equal(draft.draft_reply.includes(AI), false);
    assert.equal(draft.ticket_status, pipeline.PAUSED_REASON);
    assert.equal(draft.triage_level, null);
    assert.equal(draft.triage_label, null);
    assert.equal((await handover.recent(50)).length, before);
    const held = events.find((e) => e.type === 'paused_skipped');
    assert.ok(held);
    assert.equal(held.draft_id, draft.id);
    assert.equal(held.held, true);
  });

  test('paused Zalo refund text stays unsent with triage and urgency cleared', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    delete process.env.HITL_ACK_MESSAGE;
    const sends = [];
    let aiCalls = 0;
    aiAgent.respond = async () => {
      aiCalls += 1;
      return { text: AI, tokensUsed: 1, handoff: null, newOrder: null };
    };
    notify.send = async () => true;
    db.getOrCreateCustomer = async () => pausedCustomer({ display_name: 'Lan' });
    const before = (await handover.recent(50)).length;
    const uid = `paused_zalo_${Date.now()}`;
    const text = 'toi muon hoan tien don hom qua';

    const result = await pipeline.handleMessage({
      channel: 'oa',
      externalKey: uid,
      replyTo: uid,
      text,
      msgId: `paused-oa-${uid}`,
      senderName: 'Lan',
      send: async (_to, body) => {
        sends.push(body);
        return true;
      },
      log() {},
    });

    assert.equal(aiCalls, 0);
    assert.equal(sends.length, 0);
    assert.equal(result.held, true);
    const draft = await draftFor(uid);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.channel, 'zalo');
    assert.match(draft.customer_intent, /hoan tien/);
    assert.equal(draft.triage_level, null);
    assert.equal(draft.ticket_status, 'Bot đang tạm dừng — khách vừa nhắn');
    assert.equal(draft.draft_reply, pipeline.PAUSED_INBOX_REPLY);
    assert.equal((await handover.recent(50)).length, before);
  });

  test('an unpaused customer still reaches the model', async () => {
    delete process.env.HITL_REQUIRE_APPROVAL;
    delete process.env.HITL_ACK_MESSAGE;
    let aiCalls = 0;
    aiAgent.respond = async () => {
      aiCalls += 1;
      return { text: AI, tokensUsed: 1, handoff: null, newOrder: null };
    };
    db.getOrCreateCustomer = async () => pausedCustomer({ bot_paused: false, display_name: 'Mai' });
    const uid = `open_${Date.now()}`;
    const result = await pipeline.handleMessage({
      channel: 'oa',
      externalKey: uid,
      replyTo: uid,
      text: 'Dau goi gia bao nhieu?',
      msgId: `open-${uid}`,
      senderName: 'Mai',
      send: async () => true,
      log() {},
    });
    assert.equal(aiCalls, 1);
    assert.equal(result.held, true);
    assert.equal(result.skipped, undefined);
    const draft = await draftFor(uid);
    assert.equal(draft.draft_reply, AI);
    assert.notEqual(draft.ticket_status, pipeline.PAUSED_REASON);
  });
});

describe('POST /admin/api/customers/resume', { concurrency: 1 }, () => {
  after(() => restore());

  test('session and basic auth resume by external key; strangers are rejected', async () => {
    process.env.ADMIN_PASSWORD = 'secret';
    const resumed = [];
    db.getCustomerByExternalId = async (key) => {
      if (key !== PSID_KEY) return null;
      return pausedCustomer();
    };
    db.resumeBot = async (id) => {
      resumed.push(id);
      return true;
    };

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    hitlAdmin.mount(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    async function call(headers, body) {
      const res = await fetch(`${base}/admin/api/customers/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text };
    }

    try {
      const anon = await call({}, { external_key: PSID_KEY });
      assert.equal(anon.status, 401);

      const basic = await call({
        Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
      }, { external_key: `  ${PSID_KEY}  ` });
      assert.equal(basic.status, 200);
      assert.equal(basic.json.ok, true);
      assert.equal(basic.json.external_key, PSID_KEY);
      assert.equal(basic.json.bot_paused, false);
      assert.equal(basic.json.customer_id, pausedCustomer().id);
      assert.deepEqual(resumed, [pausedCustomer().id]);

      const missing = await call({
        Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
      }, {});
      assert.equal(missing.status, 400);

      const unknown = await call({
        Authorization: `Basic ${Buffer.from('farm:secret').toString('base64')}`,
      }, { external_key: 'fb_missing' });
      assert.equal(unknown.status, 404);

      const login = await fetch(`${base}/admin/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'secret' }),
      });
      assert.equal(login.status, 303);
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
      assert.match(cookie, /dmf_hitl=/);
      const viaSession = await call({ Cookie: cookie }, { external_key: PSID_KEY });
      assert.equal(viaSession.status, 200);
      assert.equal(viaSession.json.bot_paused, false);
      assert.equal(resumed.length, 2);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
