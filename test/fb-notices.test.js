/**
 * Facebook system notices: synthetic fixtures only.
 * A post reply becomes a short link. The automatic-greeting notice is hidden.
 * Neither is a Shop line, a DV/Sale signal, a learned keyword, or draft context.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-notices-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.FB_CLASSIFY_MODEL;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const notices = require('../public/admin/fb-notices');
const ui = require('../public/admin/thread-context');
const store = require('../services/conversationStore');
const threadLabels = require('../services/threadLabels');
const labelMoves = require('../services/labelMoves');
const ops = require('../services/ops');

const URL = 'https://www.facebook.com/story.php?story_fbid=pfbidAAA111synthetic&id=111222333';
const POST = `Minh đã trả lời về một bài viết. Xem bài viết(${URL})`;
const GREETING = 'Minh đã trả lời tin nhắn chào mừng tự động của bạn. Để thay đổi hoặc gỡ lời chào này, hãy truy cập phần Cài đặt tin nhắn.';
const LANH_NOTICE = `Lành đã trả lời về một bài viết. Xem bài viết(${URL})`;
const LONG = 'https://docmofarm.example/san-pham/nuoc-nghe-len-men?utm_source=facebook&utm_campaign=very-long-name';

beforeEach(() => {
  store.resetForTests();
  threadLabels.resetForTests();
});

test('detects post, greeting, and similar reply notices', () => {
  const post = notices.describe(POST);
  assert.equal(post.kind, 'post');
  assert.equal(post.hide, false);
  assert.equal(post.label, 'Xem bài viết');
  assert.equal(post.url, URL);
  assert.equal(post.storyId, 'pfbidAAA111synthetic');

  const greeting = notices.describe(GREETING);
  assert.equal(greeting.kind, 'greeting');
  assert.equal(greeting.hide, true);

  assert.equal(notices.describe('Minh replied to your automatic greeting.').kind, 'greeting');
  assert.equal(notices.describe('Minh đã trả lời về một quảng cáo.').kind, 'ad');
  assert.equal(notices.describe('Minh replied to your ad.').kind, 'ad');
  assert.equal(notices.describe('Minh replied to your story.').kind, 'story');
  assert.equal(notices.describe('Minh replied to a comment.').kind, 'comment');
  assert.equal(notices.describe('Minh replied to your reel.').kind, 'reel');
  assert.equal(notices.describe('Shop ơi còn dầu gội không?'), null);
  assert.equal(notices.describe('Mình đã trả lời tin nhắn của bạn rồi'), null);
  assert.equal(notices.describe(`(Doc Mo Farm) ${POST}`).kind, 'post');
});

test('a post reply renders as a chip and the greeting is omitted', () => {
  assert.equal(ui.present({ direction: 'out', sender_label: 'Shop', text: GREETING }), null);
  const chip = ui.present({ direction: 'out', sender_label: 'Shop', text: POST });
  assert.equal(chip.type, 'chip');
  assert.equal(chip.label, 'Xem bài viết');
  assert.equal(chip.url, URL);
  assert.equal(chip.storyId, 'pfbidAAA111synthetic');
  assert.equal(Object.hasOwn(chip, 'who'), false);
  assert.equal(JSON.stringify(chip).includes('Shop'), false);
  assert.equal(JSON.stringify(chip).includes(URL), true);

  const fromMeta = ui.present({
    direction: 'out',
    sender_label: 'Shop',
    text: '',
    sender_meta: {
      system_notice: 'post',
      story_url: URL,
      story_id: 'pfbidAAA111synthetic',
    },
  });
  assert.equal(fromMeta.type, 'chip');
  assert.equal(fromMeta.label, 'Xem bài viết');
  assert.equal(fromMeta.url, URL);

  const rows = [
    { text: 'một' },
    { text: 'hai' },
    { text: 'ba' },
    { text: GREETING, direction: 'out', sender_label: 'Shop' },
  ];
  assert.deepEqual(ui.visible(rows, false).map((row) => row.text), ['một', 'hai', 'ba']);
  assert.equal(ui.needsToggle(rows), false);
});

test('a long raw URL in a normal bubble becomes a short label', () => {
  const bubble = ui.present({
    direction: 'out',
    sender_label: 'Shop',
    text: `Dạ còn phòng ạ. Xem thêm tại ${LONG} nha`,
  });
  assert.equal(bubble.type, 'bubble');
  assert.equal(bubble.who, 'Shop');
  const link = bubble.parts.find((part) => part.type === 'link');
  assert.equal(link.label, 'docmofarm.example');
  assert.equal(link.url, LONG);
  assert.equal(bubble.parts.some((part) => part.type === 'text' && part.text.includes('http')), false);
  assert.equal(bubble.parts.map((part) => part.text || '').join('').includes('Dạ còn phòng'), true);
});

test('ingest stores the story url and id, including a later backfill merge', async () => {
  const first = await store.record({
    channel: 'fb',
    thread_id: 'fb_notice',
    direction: 'out',
    sender_label: 'Doc Mo Farm',
    message_text: POST,
    source_msg_id: 'notice-post',
    created_time: '2026-08-01T00:00:00.000Z',
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
  });
  assert.equal(first.inserted, true);
  const row = (await store.recent('fb', 'fb_notice', 5))[0];
  assert.equal(row.sender_meta.system_notice, 'post');
  assert.equal(row.sender_meta.story_url, URL);
  assert.equal(row.sender_meta.story_id, 'pfbidAAA111synthetic');
  assert.equal(row.sender_meta.from_name, 'Doc Mo Farm');
  assert.equal(row.message_text, POST);

  const again = await store.record({
    channel: 'fb',
    thread_id: 'fb_notice',
    direction: 'out',
    message_text: POST,
    source_msg_id: 'notice-post',
    created_time: '2026-08-01T00:00:00.000Z',
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
  });
  assert.equal(again.inserted, false);
  const merged = (await store.recent('fb', 'fb_notice', 5))[0];
  assert.equal(merged.sender_meta.story_url, URL);
  assert.equal(merged.sender_meta.story_id, 'pfbidAAA111synthetic');
});

test('system notices are not DV signatures, draft turns, or learned keywords', async () => {
  assert.equal(threadLabels.lanhAttribution([
    {
      direction: 'out',
      message_text: LANH_NOTICE,
      sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    },
  ]), null);
  assert.equal(threadLabels.lanhAttribution([
    {
      direction: 'out',
      message_text: 'Dạ còn phòng\nLành',
      sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    },
  ]), 'signature');
  assert.equal(threadLabels.decideThread([
    {
      direction: 'out',
      message_text: LANH_NOTICE,
      sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
    },
  ], null).label, 'unknown');

  const when = '2026-08-02T00:00:00.000Z';
  await store.record({
    channel: 'fb',
    thread_id: 'fb_900',
    direction: 'out',
    message_text: GREETING,
    source_msg_id: 'g1',
    created_time: when,
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_900',
    direction: 'out',
    message_text: POST,
    source_msg_id: 'p1',
    created_time: '2026-08-02T00:01:00.000Z',
  });
  await store.record({
    channel: 'fb',
    thread_id: 'fb_900',
    direction: 'in',
    message_text: 'mình muốn đặt phòng cuối tuần',
    source_msg_id: 'c1',
    created_time: '2026-08-02T00:02:00.000Z',
  });
  const turns = await store.promptTurns('fb_900', 10);
  assert.deepEqual(turns.map((turn) => turn.content), ['mình muốn đặt phòng cuối tuần']);
  const packed = JSON.stringify(turns);
  assert.equal(packed.includes('story.php'), false);
  assert.equal(packed.includes('Cài đặt tin nhắn'), false);

  const payload = threadLabels.classificationMessages([
    { direction: 'out', message_text: GREETING },
    { direction: 'out', message_text: POST },
    { direction: 'in', message_text: 'mình muốn đặt phòng' },
  ], [], {});
  const blob = JSON.stringify(payload);
  assert.equal(blob.includes('story.php'), false);
  assert.equal(blob.includes('Cài đặt tin nhắn'), false);
  assert.match(blob, /đặt phòng/);

  const shots = threadLabels.buildFewShot([
    {
      label: 'dv',
      messages: [
        { direction: 'out', message_text: POST },
        { direction: 'in', message_text: 'mình muốn đặt phòng' },
      ],
    },
  ]);
  assert.equal(JSON.stringify(shots).includes('story.php'), false);
  assert.match(shots[0].text, /đặt phòng/);

  const card = await threadLabels.contextForDraft({
    channel: 'messenger',
    customer_user_id: 'fb_900',
  });
  assert.equal(card.some((row) => String(row.text).includes('chào mừng')), false);
  const origin = card.find((row) => row.notice && row.notice.kind === 'post');
  assert.equal(origin.notice.label, 'Xem bài viết');
  assert.equal(origin.notice.url, URL);
  assert.equal(origin.notice.storyId, 'pfbidAAA111synthetic');
  assert.equal(card.some((row) => row.text === 'mình muốn đặt phòng cuối tuần'), true);

  for (const threadId of ['fb_kw1', 'fb_kw2']) {
    await store.record({
      channel: 'fb',
      thread_id: threadId,
      direction: 'in',
      message_text: POST,
      source_msg_id: `${threadId}-notice`,
      created_time: when,
    });
    await store.record({
      channel: 'fb',
      thread_id: threadId,
      direction: 'in',
      message_text: 'mình muốn thuê phòng farmstay',
      source_msg_id: `${threadId}-real`,
      created_time: '2026-08-02T00:03:00.000Z',
    });
    await store.setLabel('fb', threadId, { label: 'dv', source: 'keyword', confidence: 0.85 });
  }
  await labelMoves.record({
    channel: 'fb',
    threadId: 'fb_notice_move',
    fromLabel: 'sale',
    toLabel: 'dv',
    actor: 'manager',
    inboundText: `${POST} mình muốn thuê phòng farmstay`,
  });
  await labelMoves.record({
    channel: 'fb',
    threadId: 'fb_url_move',
    fromLabel: 'sale',
    toLabel: 'dv',
    actor: 'manager',
    inboundText: `mình muốn thuê phòng farmstay ${URL}`,
  });
  const stats = await threadLabels.stats();
  const learned = stats.keywords
    .concat(stats.learned_ngrams.dv.map((item) => item.phrase))
    .concat(stats.learned_ngrams.sale.map((item) => item.phrase))
    .map((word) => ops.normalizeText(word));
  for (const blocked of ['bai viet', 'tra loi', 'binh luan', 'facebook', 'https', 'fbid', 'story fbid', 'pfbid']) {
    assert.equal(learned.some((phrase) => phrase.includes(blocked)), false, blocked);
  }
  assert.equal(stats.learned_ngrams.dv.some((item) => item.phrase === 'phong farmstay'), true);

  await store.record({
    channel: 'fb',
    thread_id: 'fb_sig',
    direction: 'out',
    message_text: LANH_NOTICE,
    source_msg_id: 'sig-notice',
    created_time: when,
    sender_meta: { from_name: 'Doc Mo Farm', from_id: '111', page_id: '111' },
  });
  const summary = await store.attributionSummary();
  assert.equal(summary.signature_lanh_count, 0);
});
