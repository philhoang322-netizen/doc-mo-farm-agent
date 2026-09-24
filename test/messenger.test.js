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

function clearSignatureDiagEnv() {
  delete process.env.FB_APP_SECRET_ALT;
  delete process.env.FB_CLIENT_TOKEN;
  delete process.env.MESSENGER_SKIP_VERIFY;
}

function assertLogsOmit(errors, parts) {
  const dumped = JSON.stringify(errors);
  for (const part of parts) assert.equal(dumped.includes(part), false);
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

  test('bytes survive a non-json content type when capture runs before express.json', async () => {
    mockAi();
    const rawApp = express();
    rawApp.use('/messenger/webhook', messenger.captureRawBody);
    rawApp.use(express.json({
      verify: (req, _res, buf) => {
        if (!Buffer.isBuffer(req.rawBody)) req.rawBody = buf;
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
        if (!Buffer.isBuffer(req.rawBody)) req.rawBody = buf;
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
