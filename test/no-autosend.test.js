/**
 * Inbound Zalo OA, Zalo Bot, and Messenger webhooks only create
 * PENDING_REVIEW drafts. Customer send functions throw unless a person
 * approved that exact message. Env flags cannot turn auto-send back on.
 */
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.NODE_ENV = 'test';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `no-autosend-${process.pid}.json`);
process.env.HITL_REQUIRE_APPROVAL = 'false';
process.env.HITL_ACK_MESSAGE = 'Dạ farm đã nhận, nhân viên xem và trả lời sớm ạ';
process.env.AUTO_REPLY = '1';
process.env.AUTO_SEND = 'true';
process.env.BOT_MODE = 'auto';
process.env.MESSENGER_ENABLED = 'true';
process.env.FB_VERIFY_TOKEN = 'verify-test-token';
process.env.FB_APP_SECRET = 'app-secret-test';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-test';
process.env.FB_PAGE_ID = 'page-111';
process.env.ZALO_ACCESS_TOKEN = '';
process.env.ZALO_REFRESH_TOKEN = '';
process.env.ZALO_BOT_TOKEN = 'bot-token-test';
process.env.ZALO_OA_SECRET_KEY = '';
delete process.env.ALERT_BOT_CHAT_ID;
delete process.env.ALERT_ZALO_USER_ID;
delete process.env.FOLLOWUP_ENABLED;

const axios = require('axios');
const posts = [];
const realCreate = axios.create.bind(axios);
axios.create = function create(...args) {
  const inst = realCreate(...args);
  inst.post = async (url) => {
    posts.push(String(url));
    throw new Error('outbound http');
  };
  return inst;
};
axios.post = async (url) => {
  posts.push(String(url));
  throw new Error('outbound http');
};

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const gate = require('../services/outboundGate');
const messenger = require('../services/messenger');
const zaloService = require('../services/zaloService');
const botService = require('../services/zaloBotService');
const channelIngress = require('../services/channelIngress');
const pipeline = require('../services/pipeline');
const drafts = require('../services/drafts');
const aiAgent = require('../services/aiAgent');
const cardTime = require('../public/admin/card-time');
const fs = require('fs');

const AI = 'Dạ dầu gội bồ kết bên farm giá 150.000đ một chai ạ';
const PAGE = 'page-111';

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => {
    if (!Buffer.isBuffer(req.rawBody)) req.rawBody = buf;
  },
}));
channelIngress.mount(app, { pipeline, log() {} });
messenger.mount(app, { pipeline, log() {} });

let server;
let port;

function httpCall(method, urlPath, { raw, headers, json } = {}) {
  const body = raw != null ? raw : (json != null ? Buffer.from(JSON.stringify(json)) : null);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...(json != null ? { 'content-type': 'application/json' } : {}),
        ...(body ? { 'content-length': body.length } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function draftFor(userId) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find((d) => d.customer_user_id === userId) || null;
}

describe('no automatic customer send', { concurrency: 1 }, () => {
  before(async () => {
    aiAgent.respond = async () => ({
      text: AI,
      tokensUsed: 1,
      handoff: null,
      newOrder: null,
      confidence: 0.95,
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('Zalo OA webhook holds a draft and makes no outbound call', async () => {
    const before = posts.length;
    const uid = `oa_${Date.now()}`;
    const res = await httpCall('POST', '/webhook', {
      json: {
        event_name: 'user_send_text',
        sender: { id: uid, display_name: 'Khach OA' },
        message: { text: 'Dau goi gia bao nhieu?', msg_id: `m-${uid}` },
        timestamp: Date.now(),
      },
    });
    assert.equal(res.status, 200);
    const draft = await draftFor(uid);
    assert.ok(draft, 'expected a PENDING_REVIEW draft');
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.channel, 'zalo');
    assert.ok(draft.draft_reply);
    assert.equal(posts.length, before);
  });

  test('Zalo follow, seen, and Bot inbound do not send', async () => {
    const before = posts.length;
    const uid = `follow_${Date.now()}`;
    const seen = await httpCall('POST', '/webhook', {
      json: { event_name: 'user_seen_message', sender: { id: uid } },
    });
    assert.equal(seen.status, 200);
    assert.equal(await draftFor(uid), null);

    const follow = await httpCall('POST', '/webhook', {
      json: {
        event_name: 'follow',
        sender: { id: uid, display_name: 'Khach OA' },
      },
    });
    assert.equal(follow.status, 200);
    const greeted = await draftFor(uid);
    assert.ok(greeted);
    assert.equal(greeted.approval_status, 'PENDING_REVIEW');

    const chatId = `bot_${Date.now()}`;
    const bot = await httpCall('POST', '/bot/webhook', {
      json: {
        event_name: 'message.text.received',
        message: {
          text: 'Dau goi gia bao nhieu?',
          message_id: `b-${chatId}`,
          chat: { id: chatId },
          from: { id: chatId, display_name: 'Khach Bot' },
        },
      },
    });
    assert.equal(bot.status, 200);
    const botDraft = await draftFor(`bot_${chatId}`);
    assert.ok(botDraft);
    assert.equal(botDraft.approval_status, 'PENDING_REVIEW');
    assert.equal(botDraft.channel, 'zalo');
    assert.equal(posts.length, before);
  });

  test('Messenger webhook holds a draft and does not call Graph', async () => {
    const before = posts.length;
    const psid = `9${Date.now()}`;
    const raw = JSON.stringify({
      object: 'page',
      entry: [{
        id: PAGE,
        messaging: [{
          sender: { id: psid },
          recipient: { id: PAGE },
          timestamp: Date.now(),
          message: { mid: `m-${psid}`, text: 'Dau goi gia bao nhieu?' },
        }],
      }],
    });
    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.FB_APP_SECRET).update(raw).digest('hex');
    const res = await httpCall('POST', '/messenger/webhook', {
      raw: Buffer.from(raw),
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
      },
    });
    assert.equal(res.status, 200);
    const draft = await draftFor(`fb_${psid}`);
    assert.ok(draft);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.equal(draft.channel, 'messenger');
    assert.equal(posts.length, before);
  });

  test('every customer send function throws without an approval token', async () => {
    const before = posts.length;
    const calls = [
      () => messenger.sendText('123', 'xin chao'),
      () => messenger.sendImage('123', 'https://example.com/a.png'),
      () => zaloService.sendTextMessage('123', 'xin chao'),
      () => zaloService.sendImageMessage('123', { buffer: Buffer.from('png') }),
      () => zaloService.sendQuickReply('123', 'xin chao', [{ title: 'Ok', payload: 'ok' }]),
      () => botService.sendMessage('123', 'xin chao'),
      () => botService.sendPhoto('123', 'https://example.com/a.png', 'hoa don'),
      () => botService.sendTyping('123'),
    ];
    for (const call of calls) {
      await assert.rejects(call, (err) => {
        assert.equal(err.name, 'OutboundRefused');
        assert.match(err.message, /missing_approval/);
        return true;
      });
    }
    assert.equal(posts.length, before);
  });

  test('an approved draft records reviewed_by and can pass the gate', async () => {
    const token = gate.issue({
      draftId: '11111111-1111-1111-1111-111111111111',
      reviewerUserId: 'user-42',
      action: 'Gửi khách hàng',
    });
    assert.equal(token.reviewerUserId, 'user-42');
    assert.ok(token.reviewedAt);

    zaloService.setTokens('oa-test-token', 'refresh');
    const before = posts.length;
    await assert.rejects(
      () => zaloService.sendTextMessage('uid-1', 'Dạ xin chào', token),
      /outbound http/
    );
    assert.ok(posts.length > before);

    const created = await drafts.createDraft({
      channel: 'zalo',
      customer_user_id: `reviewed_${Date.now()}`,
      draft_reply: 'Dạ em gửi ạ',
    });
    const original = zaloService.sendTextMessage;
    zaloService.sendTextMessage = async (to, text, approval) => {
      gate.assertApproval(approval);
      assert.equal(approval.reviewerUserId, 'manager:Minh');
      assert.equal(approval.action, 'Gửi khách hàng');
      return { error: 0, message_id: 'ok' };
    };
    zaloService.getTokens = () => ({ accessToken: 'oa-test-token' });
    try {
      const updated = await drafts.updateDraft(created.id, { send: true }, {
        actorName: 'Minh',
        reviewerUserId: 'manager:Minh',
      });
      assert.equal(updated.send.sent, true);
      assert.equal(updated.draft.approval_status, 'SENT');
      assert.equal(updated.draft.reviewed_by, 'manager:Minh');
      assert.ok(updated.draft.reviewed_at);
      const label = cardTime.sentLabel(updated.draft);
      assert.match(label.text, /Gửi:/);
      assert.equal(label.who, 'manager:Minh');
    } finally {
      zaloService.sendTextMessage = original;
    }
  });

  test('/admin renders the reviewer on a sent draft', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
    assert.match(js, /Người duyệt/);
    assert.match(js, /reviewed_by/);
  });
});
