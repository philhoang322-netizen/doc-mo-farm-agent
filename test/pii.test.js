/**
 * Outbound LLM payloads lose phones, emails, IDs, bank numbers, VietQR
 * strings, and street addresses. The HITL draft keeps the original text
 * and stays PENDING_REVIEW.
 */
const path = require('path');
const os = require('os');

process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = 'test-not-used';
process.env.OPENAI_API_KEY = 'test-not-used';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `pii-drafts-${process.pid}.json`);
process.env.NODE_ENV = 'test';
delete process.env.HITL_REQUIRE_APPROVAL;
delete process.env.HITL_ACK_MESSAGE;
delete process.env.PII_MASKING_ENABLED;
delete process.env.ALERT_BOT_CHAT_ID;

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const pii = require('../services/pii');
const llm = require('../services/llm');
const aiAgent = require('../services/aiAgent');
const drafts = require('../services/drafts');
const pipeline = require('../services/pipeline');

const PHONE = '0901234567';

function inbound(uid, text, send, channel = 'oa') {
  const replyTo = channel === 'bot' ? uid.replace(/^bot_/, '') : uid;
  return {
    channel,
    externalKey: uid,
    replyTo,
    text,
    msgId: `m-${uid}-${Math.random().toString(16).slice(2)}`,
    senderName: 'Khach A',
    send,
    log() {},
  };
}

async function draftFor(uid) {
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  return rows.find(d => d.customer_user_id === uid) || null;
}

describe('PII sanitizer', () => {
  afterEach(() => {
    delete process.env.PII_MASKING_ENABLED;
    llm.setTransportForTests(null);
  });

  test('masks phones, email, ids, bank, vietqr, and a street address', () => {
    const emv = '00020101021238580010A000000727012800069704360114012345678901020208QRIBFTTA53037045802VN6304ABCD';
    const src = [
      'Lấy 2 chai dầu gội, đơn ORD-2026-000042 và HD012345678.',
      `Gọi ${PHONE} hoặc 090 123 4567, +84 901234567, email ban@docmofarm.vn.`,
      'CCCD 079203001234, CMND 123456789, stk 19034567890123.',
      'Địa chỉ 45 đường Lê Lợi, Phường Bến Nghé, Quận 1.',
      '45 Nguyễn Huệ, Quận 1.',
      'Ship nội thành Quận 7, giá 320.000đ, sku DMF-SHP-001.',
      `QR https://img.vietqr.io/image/vietcombank-0121000999888-compact2.png?amount=150000`,
      emv,
    ].join('\n');

    const out = pii.mask(src);
    assert.equal(out.enabled, true);
    assert.equal(out.text.includes(PHONE), false);
    assert.equal(out.text.includes('090 123 4567'), false);
    assert.equal(out.text.includes('+84 901234567'), false);
    assert.equal(out.text.includes('ban@docmofarm.vn'), false);
    assert.equal(out.text.includes('079203001234'), false);
    assert.equal(out.text.includes('123456789'), false);
    assert.equal(out.text.includes('19034567890123'), false);
    assert.equal(out.text.includes('0121000999888'), false);
    assert.equal(out.text.includes('000201'), false);
    assert.equal(out.text.includes('A000000727'), false);
    assert.equal(out.text.includes('45 đường Lê Lợi'), false);
    assert.equal(out.text.includes('45 Nguyễn Huệ'), false);
    assert.match(out.text, /\[PHONE\]/);
    assert.match(out.text, /\[EMAIL\]/);
    assert.match(out.text, /\[CCCD\]/);
    assert.match(out.text, /\[CMND\]/);
    assert.match(out.text, /\[BANK\]/);
    assert.match(out.text, /\[VIETQR\]/);
    assert.match(out.text, /\[ADDRESS\]/);
    assert.match(out.text, /2 chai dầu gội/);
    assert.match(out.text, /ORD-2026-000042/);
    assert.match(out.text, /HD012345678/);
    assert.match(out.text, /Quận 7/);
    assert.match(out.text, /320\.000đ/);
    assert.match(out.text, /DMF-SHP-001/);
  });

  test('PII_MASKING_ENABLED=false leaves the text unchanged', () => {
    process.env.PII_MASKING_ENABLED = 'false';
    const src = `Gọi ${PHONE} nhé, ban@docmofarm.vn`;
    const out = pii.mask(src);
    assert.equal(out.enabled, false);
    assert.equal(out.text, src);
    assert.equal(pii.maskingEnabled(), false);
  });

  test('off, 0, and no also disable masking; unset stays on', () => {
    for (const v of ['off', '0', 'no', 'OFF']) {
      process.env.PII_MASKING_ENABLED = v;
      assert.equal(pii.maskingEnabled(), false, v);
    }
    delete process.env.PII_MASKING_ENABLED;
    assert.equal(pii.maskingEnabled(), true);
  });

  test('openai and xAI requests set store false; anthropic body is not given an unknown flag', () => {
    const params = {
      model: 'gpt-4o-mini',
      store: true,
      messages: [{ role: 'user', content: `sdt ${PHONE}` }],
    };
    const openai = llm.prepareOutbound('openai', params);
    assert.equal(openai.body.store, false);
    assert.equal(JSON.stringify(openai.body).includes(PHONE), false);
    assert.match(openai.body.messages[0].content, /\[PHONE\]/);
    assert.equal(params.messages[0].content.includes(PHONE), true);

    const xai = llm.prepareOutbound('xai', { input: `mail a@b.co và ${PHONE}` });
    assert.equal(xai.body.store, false);
    assert.equal(JSON.stringify(xai.body).includes(PHONE), false);

    const anthropic = llm.prepareOutbound('anthropic', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: PHONE }],
    });
    assert.equal(Object.prototype.hasOwnProperty.call(anthropic.body, 'store'), false);
    assert.equal(JSON.stringify(anthropic.body).includes(PHONE), false);
  });

  test('mask log names the placeholder and not the raw phone', () => {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      llm.prepareOutbound('anthropic', {
        messages: [{ role: 'user', content: `goi ${PHONE}` }],
      });
    } finally {
      console.log = orig;
    }
    const joined = lines.join('\n');
    assert.match(joined, /PHONE/);
    assert.equal(joined.includes(PHONE), false);
  });
});

describe('PII on the customer reply path', () => {
  afterEach(() => {
    delete process.env.PII_MASKING_ENABLED;
    delete process.env.HITL_REQUIRE_APPROVAL;
    llm.setTransportForTests(null);
  });

  test('a phone still becomes PENDING_REVIEW and is absent from the model prompt', async () => {
    delete process.env.PII_MASKING_ENABLED;
    delete process.env.HITL_REQUIRE_APPROVAL;
    const captured = [];
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    llm.setTransportForTests(async (prepared) => {
      captured.push(prepared.body);
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Dạ em ghi nhận, farm sẽ xem tin gốc ạ' }],
        usage: { input_tokens: 2, output_tokens: 2 },
      };
    });

    const uid = `oa_pii_${Date.now()}`;
    const calls = [];
    const text = `Lấy 2 chai dầu gội, đơn HD012345. Gọi ${PHONE} nha`;
    try {
      const result = await pipeline.handleMessage(inbound(uid, text, async (to, body) => {
        calls.push({ to, body });
        return true;
      }));

      assert.equal(result.ok, true);
      assert.equal(result.held, true);
      assert.equal(calls.length, 0);
      assert.ok(captured.length >= 1);

      const payload = JSON.stringify(captured);
      assert.equal(payload.includes(PHONE), false);
      assert.match(payload, /\[PHONE\]/);
      assert.match(payload, /2 chai dầu gội/);
      assert.match(payload, /HD012345/);

      const draft = await draftFor(uid);
      assert.ok(draft);
      assert.equal(draft.approval_status, 'PENDING_REVIEW');
      assert.match(draft.customer_intent, /Lấy 2 chai dầu gội/);
      assert.match(draft.customer_intent, new RegExp(PHONE));
      assert.equal(draft.customer_intent.includes('[PHONE]'), false);
      assert.match(draft.pii_note, /PHONE/);
      assert.equal(draft.pii_note.includes(PHONE), false);
      assert.equal(lines.join('\n').includes(PHONE), false);
    } finally {
      console.log = orig;
      llm.setTransportForTests(null);
    }
  });

  test('bot channel uses the same mask and still holds the draft', async () => {
    const captured = [];
    llm.setTransportForTests(async (prepared) => {
      captured.push(prepared.body);
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Dạ em ghi nhận ạ' }],
        usage: {},
      };
    });
    const chatId = `chat_${Date.now()}`;
    const uid = `bot_${chatId}`;
    const calls = [];
    const text = `Mình lấy 1 gói kẹo chuối, sđt 0912345678`;
    const result = await pipeline.handleMessage({
      ...inbound(uid, text, async () => {
        calls.push(true);
        return true;
      }, 'bot'),
      replyTo: chatId,
    });
    assert.equal(result.held, true);
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(captured).includes('0912345678'), false);
    assert.match(JSON.stringify(captured), /\[PHONE\]/);
    const draft = await draftFor(uid);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.match(draft.customer_intent, /0912345678/);
    assert.equal(draft.customer_intent.includes('[PHONE]'), false);
    assert.equal(draft.channel, 'zalo');
  });

  test('disabling the flag lets the raw phone reach the model payload', async () => {
    process.env.PII_MASKING_ENABLED = 'off';
    const captured = [];
    llm.setTransportForTests(async (prepared) => {
      captured.push(prepared.body);
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Dạ ạ' }],
        usage: {},
      };
    });
    const uid = `oa_pii_off_${Date.now()}`;
    await pipeline.handleMessage(inbound(uid, `Gọi ${PHONE}`, async () => true));
    assert.match(JSON.stringify(captured), new RegExp(PHONE));
    const draft = await draftFor(uid);
    assert.equal(draft.approval_status, 'PENDING_REVIEW');
    assert.match(draft.pii_note, /tắt/);
  });
});

describe('aiAgent wires the sanitizer', () => {
  afterEach(() => llm.setTransportForTests(null));

  test('respond does not forward a phone that is only in the user turn', async () => {
    const captured = [];
    llm.setTransportForTests(async (prepared) => {
      captured.push(prepared.body);
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Dạ ạ' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });
    const result = await aiAgent.respond('pii_direct', `email a@b.co sdt ${PHONE}`);
    assert.equal(JSON.stringify(captured).includes(PHONE), false);
    assert.match(result.piiNote, /PHONE/);
    assert.match(result.piiNote, /EMAIL/);
    assert.equal(result.piiNote.includes(PHONE), false);
  });
});
