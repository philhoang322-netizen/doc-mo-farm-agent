/**
 * Messenger webhook + HITL. No live Meta credentials: Graph is mocked.
 */
const path = require('path');
const os = require('os');
const http = require('http');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.NODE_ENV = 'test';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `messenger-drafts-${process.pid}.json`);
process.env.MESSENGER_ENABLED = 'true';
process.env.FB_VERIFY_TOKEN = 'verify-test-token';
process.env.FB_APP_SECRET = 'app-secret-test';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-test';
process.env.FB_PAGE_ID = 'page-111';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const messenger = require('../services/messenger');
const drafts = require('../services/drafts');
const pipeline = require('../services/pipeline');
const aiAgent = require('../services/aiAgent');
const db = require('../services/database');
const piiHook = require('../services/piiHook');

const AI = 'Dạ dầu gội bồ kết bên farm giá 150.000đ một chai ạ';
const PAGE = 'page-111';

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
messenger.mount(app, { pipeline, log() {} });

let server;
let port;

function mockAi() {
  aiAgent.respond = async () => ({
    text: AI,
    tokensUsed: 3,
    handoff: null,
    newOrder: null,
  });
}

function pageEvent(psid, message) {
  return {
    object: 'page',
    entry: [{
      id: PAGE,
      time: Date.now(),
      messaging: [{
        sender: { id: psid },
        recipient: { id: PAGE },
        timestamp: Date.now(),
        message,
      }],
    }],
  };
}

function httpCall(method, urlPath, { raw, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

function postSigned(raw, signature) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return httpCall('POST', '/messenger/webhook', {
    raw: body,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-hub-signature-256': signature == null ? messenger.signBody(body) : signature,
    },
  });
}

async function draftFor(userId) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find((d) => d.customer_user_id === userId) || null;
}

describe('Messenger channel', { concurrency: 1 }, () => {
  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const file = process.env.DRAFTS_JSON_PATH;
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  });

  test('GET /messenger/webhook echoes the hub challenge', async () => {
    const q = 'hub.mode=subscribe&hub.verify_token=verify-test-token&hub.challenge=918273645';
    const res = await httpCall('GET', `/messenger/webhook?${q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, '918273645');
  });

  test('GET /messenger/webhook rejects a bad verify token', async () => {
    const q = 'hub.mode=subscribe&hub.verify_token=nope&hub.challenge=918273645';
    const res = await httpCall('GET', `/messenger/webhook?${q}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.includes('918273645'), false);
  });

  test('POST /messenger/webhook rejects a bad signature and does not draft', async () => {
    const psid = `sig_${Date.now()}`;
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'gia bao nhieu' }));
    const res = await postSigned(raw, 'sha256=deadbeef');
    assert.equal(res.status, 403);
    assert.equal(await draftFor(`fb_${psid}`), null);
  });

  test('POST is ignored while MESSENGER_ENABLED is off', async () => {
    process.env.MESSENGER_ENABLED = 'false';
    const psid = `off_${Date.now()}`;
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'gia bao nhieu' }));
    try {
      const res = await postSigned(raw);
      assert.equal(res.status, 200);
      assert.match(res.body, /disabled/);
      assert.equal(await draftFor(`fb_${psid}`), null);
    } finally {
      process.env.MESSENGER_ENABLED = 'true';
    }
  });

  test('echo, delivery, and read events do not create a draft', async () => {
    const psid = `echo_${Date.now()}`;
    const raw = JSON.stringify({
      object: 'page',
      entry: [{
        messaging: [
          { sender: { id: psid }, message: { mid: 'echo1', text: 'bot said this', is_echo: true } },
          { sender: { id: psid }, delivery: { mids: ['x'], watermark: 1 } },
          { sender: { id: psid }, read: { watermark: 1 } },
        ],
      }],
    });
    const res = await postSigned(raw);
    assert.equal(res.status, 200);
    assert.equal(await draftFor(`fb_${psid}`), null);
  });

  test('inbound text creates a PENDING_REVIEW messenger draft and does not call Graph', async () => {
    delete process.env.HITL_REQUIRE_APPROVAL;
    delete process.env.HITL_ACK_MESSAGE;
    mockAi();
    const calls = [];
    const original = messenger.graphHttp.post;
    messenger.graphHttp.post = async (...args) => {
      calls.push(args);
      throw new Error('Graph must not be called for an unapproved draft');
    };
    const psid = `in_${Date.now()}`;
    const text = 'Dau goi gia bao nhieu?';
    try {
      const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
      const res = await postSigned(raw);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'expected a PENDING_REVIEW draft');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      assert.equal(draft.customer_user_id, `fb_${psid}`);
      assert.match(draft.customer_intent, /^\[sales\] Hỏi giá — Dau goi gia bao nhieu\?$/);
      assert.equal(draft.draft_reply, AI);
      assert.equal(draft.assigned_department, 'Sales');
    } finally {
      messenger.graphHttp.post = original;
    }
  });

  test('Messenger stays PENDING_REVIEW even when HITL_REQUIRE_APPROVAL is false', async () => {
    process.env.HITL_REQUIRE_APPROVAL = 'false';
    mockAi();
    const calls = [];
    const original = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const psid = `force_${Date.now()}`;
    try {
      const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'con hang khong' }));
      const res = await postSigned(raw);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft);
      assert.equal(draft.channel, 'messenger');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.draft_reply, AI);
    } finally {
      delete process.env.HITL_REQUIRE_APPROVAL;
      messenger.graphHttp.post = original;
    }
  });

  test('approve and send posts me/messages and marks the draft SENT', async () => {
    const psid = `send_${Date.now()}`;
    const seen = [];
    const original = messenger.graphHttp.post;
    messenger.graphHttp.post = async (url, data, config) => {
      seen.push({ url, data, auth: config.headers.Authorization });
      return { status: 200, data: { recipient_id: data.recipient.id, message_id: 'mid.approved' } };
    };
    try {
      const created = await drafts.createDraft({
        channel: 'messenger',
        customer_user_id: `fb_${psid}`,
        customer_name: 'Khach FB',
        customer_intent: 'Dau goi gia bao nhieu?',
        draft_reply: AI,
        assigned_department: 'Sales',
        ticket_status: 'Mới tiếp nhận',
      });
      assert.equal(created.approval_status, 'PENDING_REVIEW');
      const updated = await drafts.updateDraft(created.id, { approval_status: 'APPROVED', send: true });
      assert.equal(updated.send.sent, true);
      assert.equal(updated.send.via, 'messenger');
      assert.equal(updated.draft.approval_status, 'SENT');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, 'https://graph.facebook.com/v21.0/me/messages');
      assert.equal(seen[0].auth, 'Bearer page-token-test');
      assert.equal(seen[0].data.recipient.id, psid);
      assert.equal(seen[0].data.messaging_type, 'RESPONSE');
      assert.equal(seen[0].data.message.text, AI);
    } finally {
      messenger.graphHttp.post = original;
    }
  });

  test('a Graph error keeps the draft APPROVED and does not mark it SENT', async () => {
    const original = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => ({
      status: 400,
      data: { error: { message: '(#10) outside the window' } },
    });
    try {
      const created = await drafts.createDraft({
        channel: 'messenger',
        customer_user_id: `fb_err_${Date.now()}`,
        draft_reply: AI,
      });
      const updated = await drafts.updateDraft(created.id, { send: true });
      assert.equal(updated.send.sent, false);
      assert.equal(updated.draft.approval_status, 'APPROVED');
      assert.match(updated.draft.send_error, /outside the window/);
    } finally {
      messenger.graphHttp.post = original;
    }
  });

  test('identity keys keep Zalo OA and Bot distinct from Messenger', () => {
    assert.deepEqual(db.parseKey('fb_9988'), { channel: 'messenger', id: 'fb_9988' });
    assert.deepEqual(db.parseKey('bot_42'), { channel: 'bot', id: 'bot_42' });
    assert.deepEqual(db.parseKey('12345'), { channel: 'oa', id: '12345' });
  });

  test('PII hook masks once services/pii.js is present', () => {
    assert.equal(piiHook.available(), true);
    const masked = piiHook.maskForLlm('sdt 0901234567');
    assert.equal(masked.includes('0901234567'), false);
    assert.match(masked, /\[PHONE\]/);
  });

  test('admin draft list labels Messenger rows as FB / Messenger', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
    assert.match(src, /d\.channel === 'messenger' \? 'FB \/ Messenger'/);
  });
});
