/**
 * Manual Sale/DV moves train topic weights. Synthetic fixtures only.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-moves-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FB_CLASSIFY_MODEL;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../services/drafts');
const store = require('../services/conversationStore');
const threadLabels = require('../services/threadLabels');
const labelMoves = require('../services/labelMoves');
const sample = require('../services/labelSample');

const fresh = '2026-08-01T00:00:00.000Z';
const PHRASE = 'mình muốn lửa trại bên suối';
const FOLDED = 'minh muon lua trai ben suoi';

beforeEach(() => {
  store.resetForTests();
  threadLabels.resetForTests();
});

test('the card move is one tap and has no confirm', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  const start = js.indexOf('async function moveLine');
  const fn = js.slice(start, js.indexOf('function threadMates', start));
  assert.match(fn, /\/biz-line/);
  assert.equal(fn.includes('confirm('), false);
  assert.match(js, /Chuyển qua Sale/);
  assert.match(js, /Chuyển qua DV/);
  assert.match(js, /Gắn Sale/);
  assert.match(js, /Gắn DV/);
  assert.match(js, /fillActionChips/);
});

test('a manual DV move labels a similar thread, sticks, and survives relabel', async () => {
  const llm = require('../services/llm');
  let calls = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.FB_CLASSIFY_MODEL = '1';
  llm.setTransportForTests(async () => {
    calls += 1;
    return { content: [{ type: 'text', text: 'sale' }] };
  });
  try {
    const before = threadLabels.decideThread([
      { direction: 'in', message_text: PHRASE },
    ], null);
    assert.equal(before.label, 'unknown');

    const learn = await drafts.createDraft({
      channel: 'messenger',
      customer_user_id: 'fb_learn',
      customer_query: PHRASE,
      draft_reply: 'Dạ ạ',
    });
    const mate = await drafts.createDraft({
      channel: 'messenger',
      customer_user_id: 'fb_learn',
      customer_query: 'xin chào shop',
      draft_reply: 'Dạ ạ',
    });
    const removed = await drafts.createDraft({
      channel: 'messenger',
      customer_user_id: 'fb_learn',
      customer_query: 'alo',
      draft_reply: 'Dạ ạ',
    });
    await drafts.softDelete(removed.id, { actor: 'manager' });
    const moved = await drafts.moveBizLine(learn.id, 'dv', { actor: 'manager' });
    assert.equal(moved.biz_line, 'dv');
    assert.equal(moved.biz_sticky, true);
    assert.equal((await drafts.getDraft(mate.id)).biz_line, 'dv');
    assert.equal((await drafts.getDraft(mate.id)).biz_sticky, true);
    assert.equal((await drafts.getDraft(removed.id)).biz_line, 'sale');

    const similar = threadLabels.decideThread([
      { direction: 'in', message_text: 'lửa trại bên suối nha' },
    ], null);
    assert.equal(similar.label, 'dv');
    assert.equal(similar.source, 'keyword');
    const live = threadLabels.classifyContext({
      channel: 'messenger',
      text: 'lửa trại bên suối nha',
      messages: [],
      label: null,
      prior: null,
    });
    assert.equal(live.biz_line, 'dv');
    assert.equal(live.source, 'keyword');

    const next = await drafts.createDraft({
      channel: 'messenger',
      customer_user_id: 'fb_learn',
      customer_query: 'mua thịt heo',
      draft_reply: 'Dạ em ghi ạ',
    });
    assert.equal(next.biz_line, 'dv');
    assert.equal(next.biz_sticky, true);
    const sticky = threadLabels.classifyContext({
      channel: 'messenger',
      text: 'mua thịt heo',
      messages: [{ direction: 'in', message_text: PHRASE }],
      label: await store.getLabel('fb', 'fb_learn'),
      prior: { biz_line: 'dv', biz_sticky: true },
    });
    assert.equal(sticky.biz_line, 'dv');
    assert.equal(sticky.source, 'manual');
    assert.equal(sticky.biz_sticky, true);

    const product = await drafts.createDraft({
      channel: 'messenger',
      customer_user_id: 'fb_manual',
      customer_query: 'xin giá dầu gội',
      draft_reply: 'Dạ ạ',
    });
    await drafts.moveBizLine(product.id, 'dv', { actor: 'manager' });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_manual',
      direction: 'in',
      message_text: 'xin giá dầu gội',
      source_msg_id: 'manual-in',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_similar',
      direction: 'in',
      message_text: 'lửa trại bên suối nha',
      source_msg_id: 'similar-in',
      created_time: fresh,
    });
    const priced = threadLabels.decideThread([
      { direction: 'in', message_text: 'xin giá dầu gội' },
    ], null);
    assert.equal(priced.label, 'sale');

    await threadLabels.relabel();
    const kept = await store.getLabel('fb', 'fb_manual');
    assert.equal(kept.label, 'dv');
    assert.equal(kept.source, 'manual');
    const learned = await store.getLabel('fb', 'fb_similar');
    assert.equal(learned.label, 'dv');
    assert.equal(learned.source, 'keyword');
    assert.equal(calls, 0);

    const stats = await threadLabels.stats();
    assert.equal(stats.manual_moves.dv, 2);
    assert.ok(stats.learned_ngrams.dv.some((item) => item.phrase === 'lua trai'));
    for (const item of stats.learned_ngrams.dv.concat(stats.learned_ngrams.sale)) {
      assert.ok(item.phrase.split(' ').length <= 2);
      assert.ok(item.weight <= labelMoves.PHRASE_CAP);
    }
    const dumped = JSON.stringify(stats);
    assert.equal(dumped.includes(PHRASE), false);
    assert.equal(dumped.includes(FOLDED), false);
    assert.equal(dumped.includes('inbound_text'), false);

    const viewed = await sample.build({ label: 'dv', reason: 'manual', limit: 5 });
    assert.equal(viewed.manual_moves.dv, 2);
    assert.ok(viewed.learned_ngrams.dv.some((item) => item.phrase === 'lua trai'));
    assert.equal(JSON.stringify(viewed).includes(FOLDED), false);
  } finally {
    llm.setTransportForTests(null);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FB_CLASSIFY_MODEL;
  }
});

test('a Zalo move covers the thread and the next message stays there', async () => {
  const first = await drafts.createDraft({
    channel: 'zalo',
    customer_user_id: 'zalo_move',
    customer_query: 'alo',
    draft_reply: 'Dạ ạ',
  });
  const second = await drafts.createDraft({
    channel: 'zalo',
    customer_user_id: 'zalo_move',
    customer_query: 'xin chào',
    draft_reply: 'Dạ ạ',
  });
  await drafts.moveBizLine(first.id, 'dv', { actor: 'manager' });
  assert.equal((await drafts.getDraft(second.id)).biz_line, 'dv');
  assert.equal((await drafts.getDraft(second.id)).biz_sticky, true);
  const next = await drafts.createDraft({
    channel: 'zalo',
    customer_user_id: 'zalo_move',
    customer_query: 'mua thịt heo',
    draft_reply: 'Dạ em ghi ạ',
  });
  assert.equal(next.biz_line, 'dv');
  assert.equal(next.biz_sticky, true);
});

test('phrase weight is capped and an old move decays', async () => {
  for (let i = 0; i < 12; i += 1) {
    await labelMoves.record({
      channel: 'fb',
      threadId: `fb_cap_${i}`,
      fromLabel: 'sale',
      toLabel: 'dv',
      actor: 'manager',
      inboundText: 'lửa trại bên suối',
    });
  }
  const capped = labelMoves.summary().learned_ngrams.dv.find((item) => item.phrase === 'lua trai');
  assert.ok(capped);
  assert.ok(capped.weight <= labelMoves.PHRASE_CAP);
  assert.equal(capped.weight, labelMoves.PHRASE_CAP);

  threadLabels.resetForTests();
  await labelMoves.record({
    channel: 'fb',
    threadId: 'fb_old',
    fromLabel: 'sale',
    toLabel: 'dv',
    actor: 'manager',
    inboundText: 'lửa trại bên suối',
    movedAt: '2020-01-01T00:00:00.000Z',
  });
  const faded = labelMoves.summary().learned_ngrams.dv.find((item) => item.phrase === 'lua trai');
  assert.ok(faded.weight < 1);
  assert.ok(faded.weight >= 0.4);
});
