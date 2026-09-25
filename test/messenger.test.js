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
delete process.env.FB_APP_SECRET_ALT;
delete process.env.FB_CLIENT_TOKEN;
delete process.env.MESSENGER_SKIP_VERIFY;
delete process.env.MESSENGER_SIG_CAPTURE;
delete process.env.MESSENGER_VERIFY_MODE;

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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
  verify: (req, _res, buf) => {
    if (!Buffer.isBuffer(req.rawBody)) {
      req.rawBody = buf;
      req.messengerRawSource = 'verify_hook';
    }
  },
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

function clearSignatureDiagEnv() {
  delete process.env.FB_APP_SECRET_ALT;
  delete process.env.FB_CLIENT_TOKEN;
  delete process.env.MESSENGER_SKIP_VERIFY;
  delete process.env.MESSENGER_SIG_CAPTURE;
  delete process.env.MESSENGER_VERIFY_MODE;
}

function assertLogsOmit(errors, parts) {
  const dumped = JSON.stringify(errors);
  for (const part of parts) assert.equal(dumped.includes(part), false);
}

function postSigned(raw, signature, extraHeaders) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return httpCall('POST', '/messenger/webhook', {
    raw: body,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-hub-signature-256': signature == null ? messenger.signBody(body) : signature,
      ...(extraHeaders || {}),
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
    const body = Buffer.from(raw);
    const wrong = `sha256=${'0123456789abcdef'.repeat(4)}`;
    const errors = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const res = await postSigned(raw, wrong);
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad_signature' });
      assert.equal(await draftFor(`fb_${psid}`), null);
      const line = errors.find((args) => args[0] === 'messenger_bad_signature');
      assert.ok(line, 'expected a messenger_bad_signature log');
      assert.equal(line[1].reason, 'mismatch');
      assert.equal(line[1].scheme, 'sha256');
      assert.equal(line[1].gotLen, 64);
      assert.equal(line[1].gotPrefix, '01234567');
      assert.equal(line[1].expectedPrefix, messenger.signBody(body).slice(7, 15));
      assert.equal(line[1].bodySha256Prefix, crypto.createHash('sha256').update(body).digest('hex').slice(0, 8));
      assert.notEqual(line[1].gotPrefix, line[1].expectedPrefix);
      assert.equal(line[1].rawBodyLength, body.length);
      assert.equal(line[1].signatureHeaderPresent, true);
      assert.equal(line[1].contentType, 'application/json');
      assert.equal(line[1].triedPrimary, true);
      assert.equal(line[1].triedAlt, false);
      assert.equal(line[1].triedClientToken, false);
      const dumped = JSON.stringify(errors);
      assert.equal(dumped.includes('app-secret-test'), false);
      assert.equal(dumped.includes('gia bao nhieu'), false);
      assert.equal(dumped.includes('0123456789abcdef0123'), false);
      assert.equal(dumped.includes(wrong), false);
    } finally {
      console.error = original;
    }
  });

  test('a missing signature header is logged with rawBodyLength and no secret', async () => {
    const psid = `nosig_${Date.now()}`;
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'secret-body-text' }));
    const errors = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const body = Buffer.from(raw);
      const res = await httpCall('POST', '/messenger/webhook', {
        raw: body,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
        },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad_signature' });
      const line = errors.find((args) => args[0] === 'messenger_bad_signature');
      assert.equal(line[1].reason, 'missing_header');
      assert.equal(line[1].signatureHeaderPresent, false);
      assert.equal(line[1].rawBodyLength, body.length);
      assert.equal(line[1].expectedPrefix, undefined);
      assert.equal(line[1].gotPrefix, undefined);
      assert.equal(line[1].reason === 'mismatch', false);
      assert.equal(JSON.stringify(errors).includes('app-secret-test'), false);
      assert.equal(JSON.stringify(errors).includes('secret-body-text'), false);
    } finally {
      console.error = original;
    }
  });

  test('verifySignature accepts any hex case and separates mismatch from a missing header', () => {
    const raw = Buffer.from('{"object":"page","text":"\\u00e4"}');
    const good = messenger.signBody(raw);
    const hex = good.slice('sha256='.length);
    assert.equal(messenger.verifySignature(raw, `SHA256=${hex.toUpperCase()}`).ok, true);
    assert.equal(messenger.verifySignature(raw, `Sha256=${hex.slice(0, 8).toUpperCase()}${hex.slice(8)}`).ok, true);
    assert.equal(messenger.verifySignature(raw, `  sha256=${hex}  `).ok, true);
    assert.equal(messenger.verifySignature(raw, `sha1=abcd, SHA256=${hex.toUpperCase()}`).ok, true);

    const missing = messenger.verifySignature(raw, undefined);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing_header');
    assert.equal(missing.expectedPrefix, undefined);

    const short = messenger.verifySignature(raw, 'sha256=deadbeef');
    assert.equal(short.reason, 'mismatch');
    assert.equal(short.gotLen, 8);
    assert.equal(short.gotPrefix, undefined);
    assert.equal(JSON.stringify(short).includes('deadbeef'), false);
    assert.equal(JSON.stringify(short).includes('app-secret-test'), false);

    const wrongHex = '0123456789abcdef'.repeat(4);
    const primary = messenger.verifySignature(raw, good);
    assert.equal(primary.ok, true);
    assert.equal(primary.matched, 'primary');
    assert.equal(primary.triedPrimary, true);
    assert.equal(primary.triedAlt, false);
    assert.equal(primary.triedClientToken, false);

    const mismatch = messenger.verifySignature(raw, `sha256=${wrongHex}`);
    assert.equal(mismatch.reason, 'mismatch');
    assert.equal(mismatch.triedPrimary, true);
    assert.equal(mismatch.triedAlt, false);
    assert.equal(mismatch.triedClientToken, false);
    assert.equal(mismatch.gotPrefix, '01234567');
    assert.equal(mismatch.expectedPrefix, hex.slice(0, 8));
    assert.notEqual(mismatch.gotPrefix, mismatch.expectedPrefix);
    assert.equal(mismatch.bodySha256Prefix.length, 8);
    assert.equal(JSON.stringify(mismatch).includes(wrongHex), false);

    const prefixed = messenger.verifySignature(raw, `sha1=${hex}`);
    assert.equal(prefixed.reason, 'bad_prefix');
    assert.equal(prefixed.scheme, 'sha1');
    assert.equal(JSON.stringify(prefixed).includes(hex), false);
  });

  test('an uppercase SHA256= signature is accepted and stays PENDING_REVIEW', async () => {
    mockAi();
    const calls = [];
    const original = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const psid = `case_${Date.now()}`;
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'Dau goi gia bao nhieu?' }));
    const upper = `SHA256=${messenger.signBody(raw).slice(7).toUpperCase()}`;
    try {
      const res = await postSigned(raw, upper);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'case-normalized signature must still draft');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
    } finally {
      messenger.graphHttp.post = original;
    }
  });

  test('a sha1= prefix is bad_prefix, not a digest mismatch', async () => {
    const psid = `pre_${Date.now()}`;
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'gia bao nhieu' }));
    const header = `sha1=${messenger.signBody(raw).slice(7)}`;
    const errors = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const res = await postSigned(raw, header);
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad_signature' });
      assert.equal(await draftFor(`fb_${psid}`), null);
      const line = errors.find((args) => args[0] === 'messenger_bad_signature');
      assert.equal(line[1].reason, 'bad_prefix');
      assert.equal(line[1].scheme, 'sha1');
      assert.equal(line[1].reason === 'mismatch', false);
      const dumped = JSON.stringify(errors);
      assert.equal(dumped.includes(header), false);
      assert.equal(dumped.includes('app-secret-test'), false);
      assert.equal(dumped.includes('gia bao nhieu'), false);
    } finally {
      console.error = original;
    }
  });

  test('primary FB_APP_SECRET match drafts PENDING_REVIEW and does not send', async () => {
    clearSignatureDiagEnv();
    mockAi();
    const calls = [];
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    const psid = `pri_${Date.now()}`;
    const text = 'Dau goi gia bao nhieu?';
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
    try {
      const res = await postSigned(raw);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      assert.equal(draft.draft_reply, AI);
      const names = errors.map((args) => args[0]);
      assert.equal(names.includes('messenger_sig_matched_alt'), false);
      assert.equal(names.includes('messenger_sig_matched_client_token'), false);
      assert.equal(names.includes('messenger_skip_verify_enabled'), false);
      assert.equal(names.includes('messenger_bad_signature'), false);
      assertLogsOmit(errors, ['app-secret-test', text, messenger.signBody(raw)]);
    } finally {
      console.error = originalError;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('FB_APP_SECRET_ALT match is accepted when the primary secret is wrong', async () => {
    clearSignatureDiagEnv();
    process.env.FB_APP_SECRET_ALT = 'alt-secret-test';
    mockAi();
    const calls = [];
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    const psid = `alt_${Date.now()}`;
    const text = 'alt key pipeline text';
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
    const signature = messenger.signBody(raw, 'alt-secret-test');
    try {
      const checked = messenger.verifySignature(raw, signature);
      assert.equal(checked.ok, true);
      assert.equal(checked.matched, 'alt');
      assert.equal(messenger.verifySignature(raw, messenger.signBody(raw)).matched, 'primary');
      const res = await postSigned(raw, signature);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'alt HMAC must still create a held draft');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      const line = errors.find((args) => args[0] === 'messenger_sig_matched_alt');
      assert.ok(line, 'expected messenger_sig_matched_alt');
      assert.deepEqual(line[1], {
        triedPrimary: true,
        triedAlt: true,
        triedClientToken: false,
      });
      const names = errors.map((args) => args[0]);
      assert.equal(names.includes('messenger_sig_matched_client_token'), false);
      assert.equal(names.includes('messenger_skip_verify_enabled'), false);
      assert.equal(names.includes('messenger_bad_signature'), false);
      assertLogsOmit(errors, ['app-secret-test', 'alt-secret-test', text, signature, signature.slice(7)]);
    } finally {
      console.error = originalError;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('FB_CLIENT_TOKEN match is accepted only after primary and alt both fail', async () => {
    clearSignatureDiagEnv();
    process.env.FB_APP_SECRET_ALT = 'alt-secret-wrong';
    process.env.FB_CLIENT_TOKEN = 'client-token-test';
    mockAi();
    const calls = [];
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    const psid = `cli_${Date.now()}`;
    const text = 'client token pipeline text';
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
    const signature = messenger.signBody(raw, 'client-token-test');
    try {
      const checked = messenger.verifySignature(raw, signature);
      assert.equal(checked.ok, true);
      assert.equal(checked.matched, 'client_token');
      assert.equal(checked.triedPrimary, true);
      assert.equal(checked.triedAlt, true);
      assert.equal(checked.triedClientToken, true);
      const res = await postSigned(raw, signature);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'client-token HMAC must still create a held draft');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      const line = errors.find((args) => args[0] === 'messenger_sig_matched_client_token');
      assert.ok(line, 'expected messenger_sig_matched_client_token');
      assert.deepEqual(line[1], {
        triedPrimary: true,
        triedAlt: true,
        triedClientToken: true,
      });
      const names = errors.map((args) => args[0]);
      assert.equal(names.includes('messenger_sig_matched_alt'), false);
      assert.equal(names.includes('messenger_skip_verify_enabled'), false);
      assertLogsOmit(errors, [
        'app-secret-test',
        'alt-secret-wrong',
        'client-token-test',
        text,
        signature,
        signature.slice(7),
      ]);
    } finally {
      console.error = originalError;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('MESSENGER_SKIP_VERIFY accepts a failed HMAC and still holds the draft', async () => {
    clearSignatureDiagEnv();
    process.env.FB_APP_SECRET_ALT = 'alt-secret-wrong';
    process.env.FB_CLIENT_TOKEN = 'client-token-test';
    process.env.MESSENGER_SKIP_VERIFY = '1';
    mockAi();
    const calls = [];
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    const psid = `skip_${Date.now()}`;
    const text = 'skip verify pipeline text';
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
    const signature = `sha256=${'abcdef0123456789'.repeat(4)}`;
    try {
      const res = await postSigned(raw, signature);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'skip-verify must create a held draft');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      assert.equal(draft.draft_reply, AI);
      const line = errors.find((args) => args[0] === 'messenger_skip_verify_enabled');
      assert.ok(line, 'expected messenger_skip_verify_enabled');
      assert.match(line[1].warning, /TEMPORARY/);
      assert.match(line[1].warning, /10-minute/);
      assert.equal(line[1].reason, 'mismatch');
      assert.equal(line[1].scheme, 'sha256');
      assert.equal(line[1].gotLen, 64);
      assert.equal(line[1].triedPrimary, true);
      assert.equal(line[1].triedAlt, true);
      assert.equal(line[1].triedClientToken, true);
      assert.equal(line[1].gotPrefix, 'abcdef01');
      assert.equal(typeof line[1].expectedPrefix, 'string');
      assert.equal(line[1].expectedPrefix.length, 8);
      const names = errors.map((args) => args[0]);
      assert.equal(names.includes('messenger_bad_signature'), false);
      assertLogsOmit(errors, [
        'app-secret-test',
        'alt-secret-wrong',
        'client-token-test',
        text,
        signature,
        signature.slice(7),
      ]);

      process.env.MESSENGER_SKIP_VERIFY = 'true';
      const psidTrue = `skiptrue_${Date.now()}`;
      const rawTrue = JSON.stringify(pageEvent(psidTrue, { mid: `m-${psidTrue}`, text: 'skip true text' }));
      const resTrue = await postSigned(rawTrue, signature);
      assert.equal(resTrue.status, 200);
      assert.equal(calls.length, 0);
      const draftTrue = await draftFor(`fb_${psidTrue}`);
      assert.ok(draftTrue);
      assert.equal(draftTrue.approval_status, 'PENDING_REVIEW');
    } finally {
      console.error = originalError;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('a mismatch is still rejected when every candidate fails and skip is off', async () => {
    clearSignatureDiagEnv();
    process.env.FB_APP_SECRET_ALT = 'alt-secret-wrong';
    process.env.FB_CLIENT_TOKEN = 'client-token-test';
    process.env.MESSENGER_SKIP_VERIFY = '0';
    const psid = `none_${Date.now()}`;
    const text = 'rejected pipeline text';
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
    const signature = `sha256=${'fedcba9876543210'.repeat(4)}`;
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const res = await postSigned(raw, signature);
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'bad_signature' });
      assert.equal(await draftFor(`fb_${psid}`), null);
      const line = errors.find((args) => args[0] === 'messenger_bad_signature');
      assert.ok(line, 'expected messenger_bad_signature');
      assert.equal(line[1].reason, 'mismatch');
      assert.equal(line[1].scheme, 'sha256');
      assert.equal(line[1].gotLen, 64);
      assert.equal(line[1].gotPrefix, 'fedcba98');
      assert.equal(line[1].triedPrimary, true);
      assert.equal(line[1].triedAlt, true);
      assert.equal(line[1].triedClientToken, true);
      assert.equal(line[1].expectedPrefix.length, 8);
      assert.equal(line[1].bodySha256Prefix.length, 8);
      assert.notEqual(line[1].gotPrefix, line[1].expectedPrefix);
      const names = errors.map((args) => args[0]);
      assert.equal(names.includes('messenger_skip_verify_enabled'), false);
      assert.equal(names.includes('messenger_sig_matched_alt'), false);
      assert.equal(names.includes('messenger_sig_matched_client_token'), false);
      assertLogsOmit(errors, [
        'app-secret-test',
        'alt-secret-wrong',
        'client-token-test',
        text,
        signature,
        signature.slice(7),
      ]);
    } finally {
      console.error = originalError;
      clearSignatureDiagEnv();
    }
  });

  test('MESSENGER_SIG_CAPTURE is off by default and does not log keys or the body', async () => {
    clearSignatureDiagEnv();
    const secrets = ['app-secret-test', 'alt-secret-wrong', 'client-token-test', 'page-token-test', 'verify-test-token'];
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => { errors.push(args); };
    try {
      for (const value of [undefined, '0', 'yes', 'on']) {
        if (value == null) delete process.env.MESSENGER_SIG_CAPTURE;
        else process.env.MESSENGER_SIG_CAPTURE = value;
        const psid = `capoff_${value || 'unset'}_${Date.now()}`;
        const text = `capture off ${value || 'unset'}`;
        const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
        const res = await postSigned(raw);
        assert.equal(res.status, 200);
        assert.equal(errors.some((args) => args[0] === 'messenger_sig_capture'), false);
        assertLogsOmit(errors, secrets.concat(text));
      }
    } finally {
      console.error = originalError;
      clearSignatureDiagEnv();
    }
  });

  test('MESSENGER_SIG_CAPTURE logs the signed bytes and match booleans without key material', async () => {
    clearSignatureDiagEnv();
    process.env.MESSENGER_SIG_CAPTURE = '1';
    process.env.FB_APP_SECRET_ALT = 'alt-secret-wrong';
    mockAi();
    const calls = [];
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    const psid = `cap_${Date.now()}`;
    const text = 'capture on pipeline text';
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text }));
    const signature = messenger.signBody(raw);
    const metaObj = { link: 'https://x.test/a', text: 'Dầu' };
    const metaRaw = '{"link":"https:\\/\\/x.test\\/a","text":"D\\u1ea7u"}';
    try {
      assert.equal(messenger.metaEscapedJson(JSON.stringify(metaObj)), metaRaw);
      const rebuilt = messenger.buildSigCapture({
        rawBody: '{"a":1}',
        body: { a: 1 },
        get() { return null; },
      });
      assert.equal(rebuilt.rawBodySource, 'reconstructed');
      assert.equal(Buffer.from(rebuilt.rawBodyBase64, 'base64').toString('utf8'), '{"a":1}');
      assert.equal(JSON.stringify(rebuilt).includes('app-secret-test'), false);
      const res = await postSigned(raw, signature, { 'user-agent': 'sig-capture-test' });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      const lines = errors.filter((args) => args[0] === 'messenger_sig_capture');
      assert.equal(lines.length, 1);
      const cap = lines[0][1];
      assert.equal(cap.xHubSignature256, signature);
      assert.equal(cap.xHubSignature, null);
      assert.equal(Buffer.from(cap.rawBodyBase64, 'base64').toString('utf8'), raw);
      assert.equal(cap.rawBodyLength, Buffer.byteLength(raw));
      assert.equal(cap.contentType, 'application/json');
      assert.equal(cap.contentLength, String(Buffer.byteLength(raw)));
      assert.equal(cap.contentEncoding, null);
      assert.equal(cap.transferEncoding, null);
      assert.equal(cap.userAgent, 'sig-capture-test');
      assert.equal(cap.rawBodySource, 'verify_hook');
      assert.equal(cap.sha1Raw.FB_APP_SECRET, false);
      assert.equal(cap.sha1Raw.FB_APP_SECRET_ALT, false);
      assert.equal(cap.sha1Raw.FB_CLIENT_TOKEN, undefined);
      assert.equal(cap.sha256JsonStringify.FB_APP_SECRET, true);
      assert.equal(cap.sha256JsonStringify.FB_APP_SECRET_ALT, false);
      assert.equal(cap.sha256JsonStringify.FB_CLIENT_TOKEN, undefined);
      assert.equal(cap.sha256MetaEscaped.FB_APP_SECRET, true);
      assert.equal(cap.sha256MetaEscaped.FB_CLIENT_TOKEN, undefined);
      assertLogsOmit(errors, [
        'app-secret-test',
        'alt-secret-wrong',
        'client-token-test',
        'page-token-test',
        'verify-test-token',
      ]);

      process.env.MESSENGER_SIG_CAPTURE = 'true';
      process.env.FB_CLIENT_TOKEN = 'client-token-test';
      const sha1 = 'sha1=' + crypto.createHmac('sha1', 'app-secret-test').update(metaRaw).digest('hex');
      const metaSig = messenger.signBody(metaRaw);
      const resMeta = await postSigned(metaRaw, metaSig, { 'x-hub-signature': sha1 });
      assert.equal(resMeta.status, 200);
      assert.equal(calls.length, 0);
      const metaLine = errors.filter((args) => args[0] === 'messenger_sig_capture').at(-1);
      assert.ok(metaLine);
      assert.equal(metaLine[1].xHubSignature, sha1);
      assert.equal(metaLine[1].xHubSignature256, metaSig);
      assert.equal(Buffer.from(metaLine[1].rawBodyBase64, 'base64').toString('utf8'), metaRaw);
      assert.equal(metaLine[1].sha1Raw.FB_APP_SECRET, true);
      assert.equal(metaLine[1].sha1Raw.FB_APP_SECRET_ALT, false);
      assert.equal(metaLine[1].sha1Raw.FB_CLIENT_TOKEN, false);
      assert.equal(metaLine[1].sha256JsonStringify.FB_APP_SECRET, false);
      assert.equal(metaLine[1].sha256MetaEscaped.FB_APP_SECRET, true);
      assert.equal(metaLine[1].sha256MetaEscaped.FB_APP_SECRET_ALT, false);
      assert.equal(metaLine[1].sha256MetaEscaped.FB_CLIENT_TOKEN, false);
      assert.equal(metaLine[1].sha256JsonStringify.FB_CLIENT_TOKEN, false);
      assertLogsOmit(errors, [
        'app-secret-test',
        'alt-secret-wrong',
        'client-token-test',
        'page-token-test',
        'verify-test-token',
      ]);
    } finally {
      console.error = originalError;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('capture_raw records the express.raw buffer, not a reconstructed body', async () => {
    clearSignatureDiagEnv();
    process.env.MESSENGER_SIG_CAPTURE = '1';
    const rawApp = express();
    rawApp.use('/messenger/webhook', messenger.captureRawBody);
    rawApp.use(express.json({
      verify: (req, _res, buf) => {
        if (!Buffer.isBuffer(req.rawBody)) {
          req.rawBody = buf;
          req.messengerRawSource = 'verify_hook';
        }
      },
    }));
    messenger.mount(rawApp, { pipeline, log() {} });
    const rawServer = http.createServer(rawApp);
    await new Promise((resolve) => rawServer.listen(0, '127.0.0.1', resolve));
    const rawPort = rawServer.address().port;
    const raw = Buffer.from('{"object":"page","text":"D\\u1ea7u g\\u1ed9i"}');
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: rawPort,
          path: '/messenger/webhook',
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'content-encoding': 'identity',
            'content-length': raw.length,
            'user-agent': 'meta-capture-test',
            'x-hub-signature-256': messenger.signBody(raw),
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.on('error', reject);
        req.write(raw);
        req.end();
      });
      assert.equal(res.status, 200);
      const line = errors.find((args) => args[0] === 'messenger_sig_capture');
      assert.ok(line, 'expected messenger_sig_capture');
      assert.equal(line[1].rawBodySource, 'capture_raw');
      assert.equal(line[1].rawBodySource === 'reconstructed', false);
      assert.deepEqual(Buffer.from(line[1].rawBodyBase64, 'base64'), raw);
      assert.equal(line[1].contentType, 'application/json; charset=UTF-8');
      assert.equal(line[1].contentEncoding, 'identity');
      assert.equal(line[1].contentLength, String(raw.length));
      assert.equal(line[1].userAgent, 'meta-capture-test');
      assert.equal(line[1].sha256JsonStringify.FB_APP_SECRET, false);
      assertLogsOmit(errors, ['app-secret-test', 'page-token-test', 'verify-test-token']);
    } finally {
      console.error = originalError;
      clearSignatureDiagEnv();
      await new Promise((resolve) => rawServer.close(resolve));
    }
  });

  test('bytes survive a non-json content type when capture runs before express.json', async () => {
    mockAi();
    const rawApp = express();
    rawApp.use('/messenger/webhook', messenger.captureRawBody);
    rawApp.use(express.json({
      verify: (req, _res, buf) => {
        if (!Buffer.isBuffer(req.rawBody)) {
          req.rawBody = buf;
          req.messengerRawSource = 'verify_hook';
        }
      },
    }));
    messenger.mount(rawApp, { pipeline, log() {} });
    const rawServer = http.createServer(rawApp);
    await new Promise((resolve) => rawServer.listen(0, '127.0.0.1', resolve));
    const rawPort = rawServer.address().port;
    const psid = `raw_${Date.now()}`;
    const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'Dau goi gia bao nhieu?' }));
    const body = Buffer.from(raw);
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: rawPort,
          path: '/messenger/webhook',
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            'content-length': body.length,
            'x-hub-signature-256': messenger.signBody(body),
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      assert.equal(res.status, 200);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'non-json content type must still draft from the raw bytes');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
    } finally {
      await new Promise((resolve) => rawServer.close(resolve));
    }
  });

  test('escaped unicode bytes are verified as sent, including charset and uppercase hex', async () => {
    mockAi();
    const rawApp = express();
    rawApp.use('/messenger/webhook', messenger.captureRawBody);
    rawApp.use(express.json({
      verify: (req, _res, buf) => {
        if (!Buffer.isBuffer(req.rawBody)) {
          req.rawBody = buf;
          req.messengerRawSource = 'verify_hook';
        }
      },
    }));
    messenger.mount(rawApp, { pipeline, log() {} });
    const rawServer = http.createServer(rawApp);
    await new Promise((resolve) => rawServer.listen(0, '127.0.0.1', resolve));
    const rawPort = rawServer.address().port;
    const psid = `esc_${Date.now()}`;
    // Meta signs the escaped form. Hashing a re-serialized UTF-8 body would 403.
    const raw = Buffer.from(
      `{"object":"page","entry":[{"id":"${PAGE}","time":1,"messaging":[{"sender":{"id":"${psid}"},"recipient":{"id":"${PAGE}"},"timestamp":1,"message":{"mid":"m-${psid}","text":"D\\u1ea7u g\\u1ed9i"}}]}]}`,
    );
    const signature = `SHA256=${messenger.signBody(raw).slice(7).toUpperCase()}`;
    const calls = [];
    const original = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      calls.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: rawPort,
          path: '/messenger/webhook',
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'content-length': raw.length,
            'x-hub-signature-256': signature,
          },
        }, (response) => {
          const chunks = [];
          response.on('data', (c) => chunks.push(c));
          response.on('end', () => resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.on('error', reject);
        req.write(raw);
        req.end();
      });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft, 'escaped unicode payload must draft from the raw bytes');
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      assert.match(draft.customer_intent, /Dầu gội/);
    } finally {
      messenger.graphHttp.post = original;
      await new Promise((resolve) => rawServer.close(resolve));
    }
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

  test('hmac_or_graph keeps a message Graph confirms and does not auto-send', async () => {
    clearSignatureDiagEnv();
    process.env.MESSENGER_VERIFY_MODE = 'hmac_or_graph';
    mockAi();
    const psid = `gv_${Date.now()}`;
    const mid = `m_graphverify_${psid}`;
    const text = 'Dau goi gia bao nhieu?';
    const gets = [];
    const sends = [];
    const originalGet = messenger.graphHttp.get;
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.get = async (url, config) => {
      gets.push({ url, auth: config.headers.Authorization });
      return {
        status: 200,
        data: {
          id: mid,
          message: text,
          from: { id: psid },
          to: { data: [{ id: PAGE }] },
          created_time: '2026-09-25T00:00:00+0000',
        },
      };
    };
    messenger.graphHttp.post = async () => {
      sends.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const raw = JSON.stringify(pageEvent(psid, { mid, text }));
      const res = await postSigned(raw, `sha256=${'0123456789abcdef'.repeat(4)}`);
      assert.equal(res.status, 200);
      assert.equal(sends.length, 0);
      assert.equal(gets.length, 1);
      assert.equal(gets[0].url, messenger.messageLookupUrl(mid));
      assert.equal(gets[0].url.includes('access_token'), false);
      assert.equal(gets[0].url.includes('page-token-test'), false);
      assert.equal(gets[0].auth, 'Bearer page-token-test');
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.equal(draft.channel, 'messenger');
      assert.equal(draft.draft_reply, AI);
      const line = errors.find((args) => args[0] === 'messenger_graph_verified');
      assert.ok(line, 'expected messenger_graph_verified');
      assert.equal(line[1].midPrefix, mid.slice(0, 8));
      assert.equal(line[1].exists, true);
      assert.equal(line[1].fromMatch, true);
      assert.equal(line[1].pageMatch, true);
      assert.equal(line[1].textCompared, true);
      assert.equal(line[1].textMatch, true);
      assert.equal(JSON.stringify(line[1]).includes(mid), false);
      assertLogsOmit(errors, ['page-token-test', 'app-secret-test', 'verify-test-token', mid]);
    } finally {
      console.error = originalError;
      messenger.graphHttp.get = originalGet;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('hmac_or_graph drops sender, page, and text mismatches', async () => {
    clearSignatureDiagEnv();
    process.env.MESSENGER_VERIFY_MODE = 'hmac_or_graph';
    const originalGet = messenger.graphHttp.get;
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.post = async () => {
      throw new Error('Graph send must not run');
    };
    const cases = [
      {
        name: 'sender_mismatch',
        from: 'other-psid',
        to: PAGE,
        message: 'same text',
      },
      {
        name: 'page_mismatch',
        from: null,
        to: 'page-999',
        message: 'same text',
      },
      {
        name: 'text_mismatch',
        from: null,
        to: PAGE,
        message: 'different text',
      },
    ];
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      for (const item of cases) {
        const psid = `bad_${item.name}_${Date.now()}`;
        const mid = `m_${item.name}_0123456789`;
        const text = 'same text';
        messenger.graphHttp.get = async () => ({
          status: 200,
          data: {
            id: mid,
            message: item.message,
            from: { id: item.from || psid },
            to: { data: [{ id: item.to }] },
          },
        });
        const raw = JSON.stringify(pageEvent(psid, { mid, text }));
        const res = await postSigned(raw, `sha256=${'fedcba9876543210'.repeat(4)}`);
        assert.equal(res.status, 200, item.name);
        assert.equal(await draftFor(`fb_${psid}`), null, item.name);
        const line = errors.filter((args) => args[0] === 'messenger_graph_verify_failed').at(-1);
        assert.equal(line[1].reason, item.name);
        assert.equal(line[1].midPrefix, mid.slice(0, 8));
        assert.equal(JSON.stringify(line[1]).includes(mid), false);
        assert.equal(JSON.stringify(line[1]).includes('page-999'), false);
        assert.equal(JSON.stringify(line[1]).includes('other-psid'), false);
        if (item.name === 'text_mismatch') {
          assert.equal(line[1].textCompared, true);
          assert.equal(line[1].textMatch, false);
        }
        if (item.name === 'sender_mismatch') assert.equal(line[1].fromMatch, false);
        if (item.name === 'page_mismatch') assert.equal(line[1].pageMatch, false);
      }
      assertLogsOmit(errors, ['page-token-test', 'app-secret-test']);
    } finally {
      console.error = originalError;
      messenger.graphHttp.get = originalGet;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('hmac_or_graph drops Graph 4xx, timeout, and a missing mid', async () => {
    clearSignatureDiagEnv();
    process.env.MESSENGER_VERIFY_MODE = 'hmac_or_graph';
    const originalGet = messenger.graphHttp.get;
    const originalPost = messenger.graphHttp.post;
    const gets = [];
    messenger.graphHttp.post = async () => {
      throw new Error('Graph send must not run');
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      const psid = `g4_${Date.now()}`;
      const mid = `m_graph4xx_0123456789`;
      messenger.graphHttp.get = async () => {
        gets.push(1);
        return {
          status: 400,
          data: { error: { message: 'Invalid page-token-test', code: 190 } },
        };
      };
      const raw = JSON.stringify(pageEvent(psid, { mid, text: 'gia bao nhieu' }));
      const res = await postSigned(raw, `sha256=${'0011223344556677'.repeat(4)}`);
      assert.equal(res.status, 200);
      assert.equal(await draftFor(`fb_${psid}`), null);
      const failed = errors.find((args) => args[0] === 'messenger_graph_verify_failed' && args[1].reason === 'graph_error');
      assert.ok(failed);
      assert.equal(failed[1].status, 400);
      assert.equal(failed[1].errorCode, 190);
      assert.equal(failed[1].midPrefix, mid.slice(0, 8));
      assert.equal(JSON.stringify(errors).includes('page-token-test'), false);
      assert.equal(JSON.stringify(errors).includes('Invalid page-token-test'), false);
      assert.equal(JSON.stringify(failed[1]).includes(mid), false);

      const timeout = new Error('timeout of 10000ms exceeded');
      timeout.code = 'ECONNABORTED';
      messenger.graphHttp.get = async () => { throw timeout; };
      const psidT = `gto_${Date.now()}`;
      const midT = `m_timeout_0123456789`;
      const resT = await postSigned(
        JSON.stringify(pageEvent(psidT, { mid: midT, text: 'timeout text' })),
        `sha256=${'8899aabbccddeeff'.repeat(4)}`,
      );
      assert.equal(resT.status, 200);
      assert.equal(await draftFor(`fb_${psidT}`), null);
      const timed = errors.find((args) => args[0] === 'messenger_graph_verify_failed' && args[1].reason === 'timeout');
      assert.ok(timed);
      assert.equal(timed[1].status, undefined);
      assert.equal(timed[1].midPrefix, midT.slice(0, 8));
      assert.equal(JSON.stringify(timed[1]).includes('10000'), false);
      assert.equal(JSON.stringify(timed[1]).includes(midT), false);

      gets.length = 0;
      messenger.graphHttp.get = async () => {
        gets.push(1);
        throw new Error('missing mid must not call Graph');
      };
      const psidM = `gmid_${Date.now()}`;
      const resM = await postSigned(
        JSON.stringify(pageEvent(psidM, { text: 'no mid on this event' })),
        `sha256=${'abcdeffedcba9876'.repeat(4)}`,
      );
      assert.equal(resM.status, 200);
      assert.equal(gets.length, 0);
      assert.equal(await draftFor(`fb_${psidM}`), null);
      const missing = errors.find((args) => args[0] === 'messenger_graph_verify_failed' && args[1].reason === 'missing_mid');
      assert.ok(missing);
      assert.equal(missing[1].midPrefix, undefined);
    } finally {
      console.error = originalError;
      messenger.graphHttp.get = originalGet;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
    }
  });

  test('a passing HMAC does not call Graph, and skip-verify still bypasses hmac_or_graph', async () => {
    clearSignatureDiagEnv();
    process.env.MESSENGER_VERIFY_MODE = 'hmac_or_graph';
    mockAi();
    const gets = [];
    const sends = [];
    const originalGet = messenger.graphHttp.get;
    const originalPost = messenger.graphHttp.post;
    messenger.graphHttp.get = async () => {
      gets.push(1);
      throw new Error('Graph lookup must not run when HMAC matches');
    };
    messenger.graphHttp.post = async () => {
      sends.push(1);
      return { status: 200, data: { message_id: 'should-not-send' } };
    };
    try {
      const psid = `hmacok_${Date.now()}`;
      const raw = JSON.stringify(pageEvent(psid, { mid: `m-${psid}`, text: 'Dau goi gia bao nhieu?' }));
      const res = await postSigned(raw);
      assert.equal(res.status, 200);
      assert.equal(gets.length, 0);
      assert.equal(sends.length, 0);
      const draft = await draftFor(`fb_${psid}`);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');

      process.env.MESSENGER_SKIP_VERIFY = '1';
      messenger.graphHttp.get = async () => {
        gets.push(1);
        throw new Error('skip-verify must not call Graph');
      };
      const psidS = `skipg_${Date.now()}`;
      const rawS = JSON.stringify(pageEvent(psidS, { mid: `m-${psidS}`, text: 'Dau goi gia bao nhieu?' }));
      const resS = await postSigned(rawS, `sha256=${'1111222233334444'.repeat(4)}`);
      assert.equal(resS.status, 200);
      assert.equal(gets.length, 0);
      assert.equal(sends.length, 0);
      const skipped = await draftFor(`fb_${psidS}`);
      assert.ok(skipped);
      assert.equal(skipped.approval_status, 'PENDING_REVIEW');
    } finally {
      messenger.graphHttp.get = originalGet;
      messenger.graphHttp.post = originalPost;
      clearSignatureDiagEnv();
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
