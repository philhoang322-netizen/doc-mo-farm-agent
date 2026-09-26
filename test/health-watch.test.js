/**
 * Connection alerts: burst, silence inside 07:00–22:00 ICT, token failures,
 * throttle, recovery, and a public /health body with no secrets or PII.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const health = require('../services/healthWatch');

const MIN = 60 * 1000;
const MORNING = Date.parse('2026-09-25T03:00:00Z'); // 10:00 ICT
const NIGHT = Date.parse('2026-09-25T16:00:00Z'); // 23:00 ICT

function keys(changes) {
  return changes.map(change => change.key + ':' + change.kind);
}

test('signature and graph bursts throttle, then recover', () => {
  health.resetForTests();
  for (let i = 0; i < 4; i += 1) health.noteFailure('messenger', 'verify', MORNING);
  assert.deepEqual(keys(health.tick(MORNING).changes), []);
  health.noteFailure('messenger', 'verify', MORNING);
  assert.deepEqual(keys(health.tick(MORNING).changes), ['messenger_verify:fire']);
  assert.equal(health.tick(MORNING + MIN).changes.length, 0);
  for (let i = 0; i < 5; i += 1) health.noteFailure('messenger', 'verify', MORNING + 46 * MIN);
  assert.deepEqual(keys(health.tick(MORNING + 46 * MIN).changes), ['messenger_verify:fire']);

  health.resetForTests();
  for (let i = 0; i < 5; i += 1) health.noteFailure('messenger', 'graph_verify', MORNING);
  assert.ok(keys(health.tick(MORNING).changes).includes('messenger_graph:fire'));
  assert.ok(keys(health.tick(MORNING + 16 * MIN).changes).includes('messenger_graph:recover'));
});

test('silence only during open hours, and sticky token alerts recover', () => {
  health.resetForTests();
  health.noteInbound('messenger', MORNING - 7 * 60 * MIN);
  assert.ok(keys(health.tick(MORNING).changes).includes('silence_messenger:fire'));
  assert.equal(health.tick(MORNING + MIN).changes.length, 0);
  assert.ok(keys(health.tick(MORNING + 46 * MIN).changes).includes('silence_messenger:fire'));
  const overnight = health.tick(NIGHT);
  assert.equal(overnight.changes.filter(change => change.kind === 'recover').length, 0);
  health.noteInbound('messenger', NIGHT);
  assert.ok(keys(health.tick(NIGHT).changes).includes('silence_messenger:recover'));

  health.resetForTests();
  health.noteInbound('zalo', NIGHT - 8 * 60 * MIN);
  assert.equal(health.tick(NIGHT).changes.filter(change => change.key === 'silence_zalo').length, 0);

  health.resetForTests();
  health.noteFailure('zalo', 'expiring', MORNING);
  assert.ok(keys(health.tick(MORNING).changes).includes('zalo_token:fire'));
  health.noteSuccess('zalo', MORNING + MIN);
  assert.ok(keys(health.tick(MORNING + MIN).changes).includes('zalo_token:recover'));

  health.resetForTests();
  health.noteFailure('kiotviet', 'timeout', MORNING);
  health.noteFailure('kiotviet', 'timeout', MORNING);
  assert.equal(health.tick(MORNING).changes.length, 0);
  health.noteFailure('kiotviet', 'timeout', MORNING);
  assert.ok(keys(health.tick(MORNING).changes).includes('kiotviet:fire'));

  health.resetForTests();
  health.noteFailure('kiotviet', 'auth', MORNING);
  assert.ok(keys(health.tick(MORNING).changes).includes('kiotviet:fire'));
  health.noteSuccess('kiotviet', MORNING + MIN);
  assert.ok(keys(health.tick(MORNING + MIN).changes).includes('kiotviet:recover'));

  health.resetForTests();
  health.noteFailure('graph', 'invalid', MORNING);
  health.noteFailure('llm', 'exception', MORNING);
  health.noteFailure('pipeline', 'exception', MORNING);
  const many = keys(health.tick(MORNING).changes);
  assert.ok(many.includes('graph_token:fire'));
  assert.ok(many.includes('llm:fire'));
  assert.ok(many.includes('pipeline:fire'));
  health.noteSuccess('graph', MORNING + MIN);
  health.noteSuccess('llm', MORNING + MIN);
  health.noteSuccess('pipeline', MORNING + MIN);
  const done = keys(health.tick(MORNING + MIN).changes);
  assert.ok(done.includes('graph_token:recover'));
  assert.ok(done.includes('llm:recover'));
  assert.ok(done.includes('pipeline:recover'));
});

test('public health and outbound alerts omit secrets and phone numbers', async () => {
  health.resetForTests();
  health.noteFailure('graph', 'invalid', MORNING);
  health.tick(MORNING);
  const body = health.publicView(MORNING);
  const packed = JSON.stringify(body);
  assert.equal(body.status, 'degraded');
  assert.equal(body.ok, false);
  assert.equal(body.integrations.find(row => row.name === 'graph').failureCode, 'invalid');
  assert.doesNotMatch(packed, /bearer|access_token|secret|0901234567|Đã hồi/i);

  const zalo = require('../services/zaloService');
  const axios = require('axios');
  const sent = [];
  const posts = [];
  const origSend = zalo.sendTextMessage;
  const origPost = axios.post;
  const prevZalo = process.env.ALERT_ZALO_USER_ID;
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  process.env.ALERT_ZALO_USER_ID = 'owner-zalo-id';
  process.env.TELEGRAM_BOT_TOKEN = '123456:telegram-secret-token';
  process.env.TELEGRAM_CHAT_ID = '4242';
  zalo.sendTextMessage = async (id, text) => {
    sent.push({ id, text });
    return { error: 0 };
  };
  axios.post = async (url, payload) => {
    posts.push({ url, text: payload && payload.text });
    return { data: { ok: true } };
  };
  try {
    const out = await health.push('Lỗi bearer abcdefghijklmnop cho khách 0901234567');
    assert.equal(sent.length, 0, 'Zalo OA must not carry a connection alert');
    assert.equal(out.delivered.zalo, false);
    assert.doesNotMatch(out.text, /abcdefghijklmnop|0901234567/);
    assert.doesNotMatch(posts[0].text, /abcdefghijklmnop|0901234567/);
    assert.match(posts[0].url, /telegram-secret-token/);
    assert.doesNotMatch(out.text, /telegram-secret-token/);
    assert.equal(JSON.stringify(health.publicView(MORNING)).includes('telegram-secret-token'), false);
  } finally {
    zalo.sendTextMessage = origSend;
    axios.post = origPost;
    if (prevZalo == null) delete process.env.ALERT_ZALO_USER_ID;
    else process.env.ALERT_ZALO_USER_ID = prevZalo;
    if (prevToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChat;
    health.resetForTests();
  }
});
