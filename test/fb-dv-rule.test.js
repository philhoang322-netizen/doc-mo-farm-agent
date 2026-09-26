/**
 * Topic FB-DV rule. Synthetic fixtures only. No model calls.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dv-rule-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FB_CLASSIFY_MODEL;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const lanh = require('../services/lanhMark');
const fbDvRule = require('../services/fbDvRule');
const threadLabels = require('../services/threadLabels');
const store = require('../services/conversationStore');
const faqStore = require('../services/faqStore');
const ops = require('../services/ops');

const fresh = '2026-08-01T00:00:00.000Z';
const page = { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' };

function out(text) {
  return { direction: 'out', message_text: text, sender_meta: page };
}

beforeEach(() => {
  store.resetForTests();
  threadLabels.resetForTests();
  faqStore.resetForTests();
});

test('a signature is a sign-off, not an inline or lowercase adjective', () => {
  assert.equal(lanh.isSignoff('Dạ còn phòng\nLành'), true);
  assert.equal(lanh.isSignoff('Dạ còn phòng Lành nha'), true);
  assert.equal(lanh.isSignoff('Dạ còn phòng Lành nhé'), true);
  assert.equal(lanh.isSignoff('Dạ còn phòng Lành ạa'), true);
  assert.equal(lanh.isSignoff('Còn phòng ạ. Lành 🌿'), true);
  assert.equal(lanh.isSignoff('lành'), true);
  assert.equal(lanh.isSignoff('LANH'), true);
  assert.equal(lanh.isSignoff('Chị Lành sẽ gọi lại cho mình'), false);
  assert.equal(lanh.isSignoff('Em tên Lành đây, shop gửi giá'), false);
  assert.equal(lanh.isSignoff('Bạn hiền lành'), false);
  assert.equal(lanh.isSignoff('Bạn lành tính lắm'), false);
  assert.equal(lanh.isSignoff('Dạ em gửi lành'), false);
  assert.equal(lanh.isSignoff('Dạ hôm nay trời lạnh quá'), false);
  assert.equal(threadLabels.lanhAttribution([out('Chị Lành sẽ gọi lại')]), null);
  assert.equal(threadLabels.lanhAttribution([out('Dạ còn phòng\nLành')]), 'signature');
  assert.equal(threadLabels.lanhAttribution([
    {
      direction: 'out',
      message_text: 'Dạ còn phòng',
      sender_meta: { from_name: 'Lành', from_id: '111', page_id: '111' },
    },
  ]), 'staff_lanh');
});

test('topic decides, a sign-off is only a tiebreaker, and a manual label wins', async () => {
  const priced = threadLabels.decideThread([
    { direction: 'in', message_text: 'xin giá dầu gội' },
    out('Dạ 120k một chai\nLành'),
  ], null);
  assert.equal(priced.label, 'sale');
  assert.equal(priced.source, 'keyword');

  const rooms = threadLabels.decideThread([
    { direction: 'in', message_text: 'còn phòng không shop' },
    { direction: 'out', message_text: 'Dạ còn phòng ạ', sender_meta: page },
  ], null);
  assert.equal(rooms.label, 'dv');
  assert.equal(rooms.source, 'keyword');

  const moved = threadLabels.decideThread([
    { direction: 'in', message_text: 'còn phòng farmstay không' },
    out('Dạ còn phòng'),
    { direction: 'in', message_text: 'thôi mình lấy dầu gội' },
  ], null);
  assert.equal(moved.label, 'sale');
  assert.equal(moved.source, 'keyword');

  const backToRooms = threadLabels.decideThread([
    { direction: 'in', message_text: 'xin giá dầu gội' },
    out('Dạ 120k'),
    { direction: 'in', message_text: 'thôi mình đặt phòng qua đêm' },
  ], null);
  assert.equal(backToRooms.label, 'dv');
  assert.equal(backToRooms.source, 'keyword');

  const priceOfRoom = threadLabels.decideThread([
    { direction: 'in', message_text: 'xin giá phòng' },
  ], null);
  assert.equal(priceOfRoom.label, 'dv');

  const goodsLater = threadLabels.decideThread([
    { direction: 'in', message_text: 'ở farmstay và mua nước nghệ lên men' },
    out('Dạ còn phòng\nLành'),
  ], null);
  assert.equal(goodsLater.label, 'sale');
  assert.equal(goodsLater.source, 'keyword');

  const customerTopic = threadLabels.decideThread([
    { direction: 'in', message_text: 'mình muốn thuê phòng' },
    out('Dạ dầu gội còn chai\nLành'),
  ], null);
  assert.equal(customerTopic.label, 'dv');
  assert.equal(customerTopic.source, 'keyword');

  const pageOnly = threadLabels.decideThread([
    { direction: 'in', message_text: 'alo' },
    out('Dạ còn phòng farmstay'),
  ], null);
  assert.equal(pageOnly.label, 'dv');
  assert.equal(pageOnly.source, 'keyword');

  const tie = threadLabels.decideThread([
    { direction: 'in', message_text: 'alo' },
    out('Dạ em chào\nLành'),
  ], null);
  assert.equal(tie.label, 'dv');
  assert.equal(tie.source, 'signature');

  const named = threadLabels.decideThread([
    { direction: 'in', message_text: 'alo' },
    {
      direction: 'out',
      message_text: 'Dạ em chào',
      sender_meta: { from_name: 'Lành', from_id: '111', page_id: '111' },
    },
  ], null);
  assert.equal(named.label, 'unknown');
  assert.equal(named.source, 'keyword');

  const manual = threadLabels.decideThread([
    { direction: 'in', message_text: 'xin giá dầu gội' },
    out('Dạ 120k một chai\nLành'),
  ], { label: 'dv', source: 'manual', confidence: 1 });
  assert.equal(manual.label, 'dv');
  assert.equal(manual.source, 'manual');

  const live = threadLabels.classifyContext({
    channel: 'messenger',
    text: 'lấy thêm một chai',
    messages: [
      { direction: 'in', message_text: 'mình lấy nước nghệ lên men' },
      out('Dạ còn chai\nLành'),
    ],
    label: { label: 'dv', source: 'signature', confidence: 0.9 },
    prior: null,
  });
  assert.equal(live.biz_line, 'sale');
  assert.equal(live.source, 'keyword');
});

test('relabel learns service words only and drops catalog and sales words', async () => {
  const llm = require('../services/llm');
  let calls = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.FB_CLASSIFY_MODEL = '1';
  llm.setTransportForTests(async () => {
    calls += 1;
    return { content: [{ type: 'text', text: 'dv' }] };
  });
  try {
    await faqStore.replaceAll([
      {
        code: 'siro',
        product: 'Siro gừng nhà',
        question: 'siro gừng nhà giá sao',
        answer: 'Dạ còn ạ',
        action_flag: 'answer',
        verify_status: 'approved',
      },
      {
        code: 'suoi',
        group: 'Dịch vụ',
        product: 'Suối đêm riêng',
        question: 'suối đêm riêng còn không',
        answer: 'Dạ còn ạ',
        action_flag: 'answer',
        verify_status: 'approved',
      },
    ]);

    for (const id of ['fb_stay_a', 'fb_stay_b']) {
      await store.record({
        channel: 'fb',
        thread_id: id,
        direction: 'in',
        message_text: 'mình muốn thuê phòng farmstay team building',
        source_msg_id: `${id}-in`,
        created_time: fresh,
      });
      await store.record({
        channel: 'fb',
        thread_id: id,
        direction: 'out',
        message_text: 'Dạ còn phòng\nLành',
        sender_meta: page,
        source_msg_id: `${id}-out`,
        created_time: fresh,
      });
    }
    await store.record({
      channel: 'fb',
      thread_id: 'fb_product',
      direction: 'in',
      message_text: 'lấy giúp siro gừng nhà',
      source_msg_id: 'prod-in',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_product',
      direction: 'out',
      message_text: 'Dạ còn chai\nLành',
      sender_meta: page,
      source_msg_id: 'prod-out',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_inline',
      direction: 'out',
      message_text: 'Chị Lành sẽ gọi lại',
      sender_meta: page,
      source_msg_id: 'inline-out',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_inline',
      direction: 'in',
      message_text: 'mình muốn đặt phòng qua đêm',
      source_msg_id: 'inline-in',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_rooms',
      direction: 'in',
      message_text: 'còn phòng không shop',
      source_msg_id: 'rooms-in',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_rooms',
      direction: 'out',
      message_text: 'Dạ còn phòng ạ',
      sender_meta: page,
      source_msg_id: 'rooms-out',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_moved',
      direction: 'in',
      message_text: 'còn phòng farmstay không',
      source_msg_id: 'moved-in-1',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_moved',
      direction: 'in',
      message_text: 'thôi mình lấy dầu gội',
      source_msg_id: 'moved-in-2',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_faq',
      direction: 'in',
      message_text: 'mình hỏi suối đêm riêng',
      source_msg_id: 'faq-in',
      created_time: fresh,
    });
    for (const id of ['fb_sign_a', 'fb_sign_b']) {
      await store.record({
        channel: 'fb',
        thread_id: id,
        direction: 'in',
        message_text: 'alo xyzokhang',
        source_msg_id: `${id}-in`,
        created_time: fresh,
      });
      await store.record({
        channel: 'fb',
        thread_id: id,
        direction: 'out',
        message_text: 'Dạ em chào\nLành',
        sender_meta: page,
        source_msg_id: `${id}-out`,
        created_time: fresh,
      });
    }
    await store.record({
      channel: 'fb',
      thread_id: 'fb_named',
      direction: 'in',
      message_text: 'alo',
      source_msg_id: 'named-in',
      created_time: fresh,
    });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_named',
      direction: 'out',
      message_text: 'Dạ em chào',
      sender_meta: { from_name: 'Lành', from_id: '111', page_id: '111' },
      source_msg_id: 'named-out',
      created_time: fresh,
    });

    await store.setLabel('fb', 'fb_manual', { label: 'sale', source: 'manual', confidence: 1 });
    await store.record({
      channel: 'fb',
      thread_id: 'fb_manual',
      direction: 'out',
      message_text: 'Dạ còn phòng farmstay\nLành',
      sender_meta: page,
      source_msg_id: 'man-out',
      created_time: fresh,
    });

    const result = await threadLabels.relabel();
    assert.equal(calls, 0);
    assert.equal((await store.getLabel('fb', 'fb_stay_a')).label, 'dv');
    assert.equal((await store.getLabel('fb', 'fb_stay_a')).source, 'keyword');
    assert.equal((await store.getLabel('fb', 'fb_product')).label, 'sale');
    assert.equal((await store.getLabel('fb', 'fb_product')).source, 'keyword');
    assert.equal((await store.getLabel('fb', 'fb_inline')).source, 'keyword');
    assert.equal((await store.getLabel('fb', 'fb_inline')).label, 'dv');
    assert.equal((await store.getLabel('fb', 'fb_rooms')).label, 'dv');
    assert.equal((await store.getLabel('fb', 'fb_rooms')).source, 'keyword');
    assert.equal((await store.getLabel('fb', 'fb_moved')).label, 'sale');
    assert.equal((await store.getLabel('fb', 'fb_moved')).source, 'keyword');
    assert.equal((await store.getLabel('fb', 'fb_faq')).label, 'dv');
    assert.equal((await store.getLabel('fb', 'fb_faq')).source, 'keyword');
    assert.equal((await store.getLabel('fb', 'fb_sign_a')).label, 'dv');
    assert.equal((await store.getLabel('fb', 'fb_sign_a')).source, 'signature');
    assert.equal((await store.getLabel('fb', 'fb_named')).label, 'unknown');
    assert.equal((await store.getLabel('fb', 'fb_manual')).source, 'manual');
    assert.equal((await store.getLabel('fb', 'fb_manual')).label, 'sale');

    const folded = result.keywords.map((word) => ops.normalizeText(word));
    assert.equal(folded.includes('team building'), true);
    assert.equal(folded.includes('xyzokhang'), false);
    for (const blocked of ['len men', 'nuoc nghe', 'nghe len', 'dau goi', 'xin gia', 'siro gung', 'gia', 'ship', 'dat', 'mua']) {
      assert.equal(folded.includes(blocked), false, blocked);
    }
    assert.equal(fbDvRule.blockedKeyword('xin giá'), true);
    assert.equal(fbDvRule.blockedKeyword('siro gừng'), true);
    assert.equal(fbDvRule.hasService('suối đêm riêng'), true);
    assert.equal([...fbDvRule.productPhrases()].some((phrase) => phrase.includes('suoi dem')), false);
    assert.equal(fbDvRule.hasService('mình muốn check-in và booking'), true);
    assert.equal(fbDvRule.hasService('check-in lúc 14h'), false);
    assert.equal(fbDvRule.hasService('lấy nước nghệ lên men'), false);
  } finally {
    llm.setTransportForTests(null);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FB_CLASSIFY_MODEL;
  }
});
