/**
 * Grounded FAQ drafts. Fixtures are synthetic: no farm prices or lab results.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.ADMIN_PASSWORD = 'secret';
process.env.NODE_ENV = 'test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-draft-'));
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.TRAINING_LOG_PATH = path.join(dir, 'training.json');
process.env.ADMIN_USERS_PATH = path.join(dir, 'users.json');
delete process.env.ADMIN_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const store = require('../services/faqStore');
const csv = require('../services/faqCsv');
const faqDraft = require('../services/faqDraft');
const faqPrompt = require('../services/faqPrompt');
const faqText = require('../services/faqText');
const drafts = require('../services/drafts');
const trainingLog = require('../services/trainingLog');
const pipeline = require('../services/pipeline');
const users = require('../services/adminUsers');
const hitlAdmin = require('../services/hitlAdmin');

const basic = 'Basic ' + Buffer.from('farm:secret').toString('base64');

beforeEach(() => {
  store.resetForTests();
  faqDraft.setCompleterForTests(null);
  faqDraft.setKiotSearchForTests(null);
});

async function seed(items) {
  await store.replaceAll(items);
}

function item(partial) {
  return {
    code: 'FAQ-MAU',
    group: 'Nhóm mẫu',
    product: 'Sản phẩm mẫu',
    question: 'Câu hỏi mẫu',
    variants: '',
    answer: 'Câu trả lời mẫu.',
    conditions: '',
    action_flag: 'TU_DONG',
    verify_status: 'verified',
    source: 'test',
    enabled: true,
    ...partial,
  };
}

test('verified TU_DONG match drafts from the FAQ and keeps training examples first', async () => {
  await seed([item({
    code: 'FAQ-U',
    question: 'Ủ mẫu mất bao lâu',
    answer: 'Ủ mẫu trong 48 giờ, không đổi điều kiện.',
  })]);
  await trainingLog.storeOnApprove({
    id: 'ex-u',
    sales_channel: 'farm',
    customer_query: 'Ủ mẫu mất bao lâu',
    ai_draft_version: 'Bản máy dài dòng',
    draft_reply: 'Dạ farm nói ngắn gọn ạ.',
  }, { actor: 'manager:test', learn: true });

  let system = '';
  faqDraft.setCompleterForTests(async (prompt) => {
    system = prompt;
    return 'Dạ farm ủ mẫu trong 48 giờ, không đổi điều kiện ạ.\n[Người duyệt]\nMã FAQ: FAQ-U\nĐộ tin: 0.9\nChuyển người: không';
  });
  const result = await faqDraft.compose('Ủ mẫu mất bao lâu');
  assert.equal(result.handled, true);
  assert.equal(result.reviewer.handoff, false);
  assert.ok(result.reviewer.codes.includes('FAQ-U'));
  assert.ok(result.reviewer.confidence >= 0.45);
  assert.match(result.text, /48/);
  assert.doesNotMatch(result.text, /Người duyệt/);
  assert.doesNotMatch(result.text, /Độ tin/);
  const trainAt = system.indexOf('CÂU QUẢN LÝ');
  const faqAt = system.indexOf('QUY TẮC VĂN MƠ');
  assert.ok(trainAt >= 0 && faqAt > trainAt);
  assert.match(system, /48 giờ/);
});

test('needs verification becomes a handoff and hides the answer', async () => {
  await seed([item({
    code: 'FAQ-CHUA',
    question: 'Mẫu này để được bao lâu',
    answer: 'CHUA-XAC-MINH trong vòng mẫu.',
    verify_status: 'needs_verification',
  })]);
  let calls = 0;
  faqDraft.setCompleterForTests(async () => {
    calls += 1;
    return 'CHUA-XAC-MINH';
  });
  const result = await faqDraft.compose('Mẫu này để được bao lâu');
  assert.equal(calls, 0);
  assert.equal(result.reviewer.handoff, true);
  assert.match(result.reviewer.reason, /xác minh/);
  assert.equal(result.text.includes('CHUA-XAC-MINH'), false);
  assert.equal(result.triage.level === 'urgent' || result.triage.level === 'hot', true);
  const block = await faqPrompt.promptBlock('Mẫu này để được bao lâu');
  assert.equal(block.includes('CHUA-XAC-MINH'), false);
  assert.match(block, /KHÔNG DÙNG/);
});

test('opening hours today hands off instead of quoting the stored hours', async () => {
  await seed([item({
    code: 'FAQ-GIO',
    question: 'Mấy giờ mở cửa',
    answer: 'Mở cửa theo mốc mẫu MOC-GIO-88.',
  })]);
  const result = await faqDraft.compose('Hôm nay mấy giờ mở cửa?');
  assert.equal(result.reviewer.handoff, true);
  assert.match(result.reviewer.reason, /hôm nay|giờ mở cửa/i);
  assert.equal(result.text.includes('MOC-GIO-88'), false);
  assert.equal(result.triage.level === 'urgent' || result.triage.level === 'hot', true);
});

test('nhân viên trực không online is a complaint handoff', async () => {
  await seed([item({
    code: 'FAQ-TRUC',
    question: 'Nhân viên trực online không',
    answer: 'TOKEN-TRUC nhân viên đang trực.',
  })]);
  const result = await faqDraft.compose('nhân viên trực không online');
  assert.equal(result.reviewer.handoff, true);
  assert.match(result.reviewer.reason, /khiếu nại/);
  assert.equal(result.text.includes('TOKEN-TRUC'), false);
  assert.equal(result.triage.level === 'urgent' || result.triage.level === 'hot', true);
});

test('day trip versus overnight is answered and not asked again', async () => {
  await seed([item({
    code: 'FAQ-TOUR',
    product: 'Chuyến mẫu',
    question: 'Đi trong ngày khác qua đêm thế nào',
    answer: 'Đi trong ngày farm đón ở mốc mẫu. Ở lại đêm farm có chỗ nghỉ mẫu.',
  })]);
  faqDraft.setCompleterForTests(async () => 'Mình đi trong ngày hay qua đêm ạ?');
  const result = await faqDraft.compose('Đi trong ngày khác qua đêm thế nào');
  assert.equal(result.reviewer.handoff, false);
  assert.match(result.text, /chỗ nghỉ mẫu/);
  assert.doesNotMatch(result.text, /hay qua đêm/i);
});

test('reviewer block is stripped from the customer body', async () => {
  const raw = 'Dạ farm chào mình.\n[Người duyệt]\nMã FAQ: FAQ-TEST-1\nĐộ tin: 0.91\nChuyển người: không\nLý do: khớp';
  assert.equal(faqText.customerFacingReply(raw), 'Dạ farm chào mình.');
  assert.equal(faqText.stripReviewerBlock(raw).includes('FAQ-TEST-1'), false);
  const draft = await drafts.createDraft({
    channel: 'zalo',
    customer_name: 'Khách mẫu',
    customer_query: 'Xin chào',
    draft_reply: raw,
    faq_review: { codes: ['FAQ-TEST-1'], confidence: 0.91, handoff: false, reason: 'khớp' },
  });
  assert.equal(draft.approval_status, 'PENDING_REVIEW');
  assert.equal(draft.draft_reply.includes('Người duyệt'), false);
  assert.equal(draft.draft_reply.includes('FAQ-TEST-1'), false);
  assert.deepEqual(draft.faq_review.codes, ['FAQ-TEST-1']);
  assert.equal(draft.faq_review.handoff, false);
  assert.equal(drafts.customerFacingReply(draft).includes('Người duyệt'), false);
});

test('KiotViet price overrides the FAQ snapshot', async () => {
  await seed([item({
    code: 'FAQ-GIA',
    product: 'Sản phẩm mẫu A',
    question: 'Giá sản phẩm mẫu A là bao nhiêu',
    answer: 'Giá lưu mẫu là 111000.',
    action_flag: 'LIVE',
  })]);
  faqDraft.setKiotSearchForTests(async () => [{ name: 'Sản phẩm mẫu A', price: 222000 }]);
  const result = await faqDraft.compose('Giá sản phẩm mẫu A là bao nhiêu');
  assert.equal(result.reviewer.handoff, false);
  assert.match(result.text, /222\.000đ/);
  assert.equal(result.text.includes('111000'), false);
  assert.equal(result.text.includes('111.000'), false);
});

test('order-taking question hands off without repeating a phone number', async () => {
  await seed([item({
    code: 'FAQ-DAT',
    question: 'Cách đặt hàng mẫu',
    answer: 'Để đặt hàng, nhắn số điện thoại và địa chỉ.',
  })]);
  const result = await faqDraft.compose('Cách đặt hàng mẫu 0901234567');
  assert.equal(result.reviewer.handoff, true);
  assert.equal(result.text.includes('0901234567'), false);
  assert.doesNotMatch(result.text, /số điện thoại/i);
});

test('low confidence is a handoff, not a weak auto draft', async () => {
  await seed([item({
    code: 'FAQ-U',
    question: 'Ủ mẫu mất bao lâu',
    answer: 'Ủ mẫu trong 48 giờ.',
  })]);
  let calls = 0;
  faqDraft.setCompleterForTests(async () => {
    calls += 1;
    return 'Ủ mẫu trong 48 giờ.';
  });
  const result = await faqDraft.compose('xyzabc qwerty không liên quan');
  assert.equal(calls, 0);
  assert.equal(result.reviewer.handoff, true);
  assert.equal(result.text.includes('48'), false);
});

test('import validates CSV headers and previews a replace', async () => {
  const bad = await csv.parseFaqCsv('foo,bar\n1,2\n');
  assert.ok(bad.errors.length);
  assert.match(bad.errors[0], /Thiếu cột/);
  assert.equal(csv.normalizeAction('tra cứu live hoặc chuyển người'), 'LIVE');
  assert.equal(csv.normalizeAction('chưa bật'), 'CHUA_BAT');
  assert.equal(csv.normalizeAction('chuyển người'), 'CHUYEN_NGUOI');
  assert.equal(csv.normalizeVerify('cần xác minh'), 'needs_verification');

  const file = fs.readFileSync(path.join(__dirname, 'fixtures', 'faq-synthetic.csv'), 'utf8');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  hitlAdmin.mount(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const denied = await fetch(base + '/admin/api/faq/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: file }),
    });
    assert.equal(denied.status, 401);

    const sale = await users.create({ username: 'lanfaq', password: 'matkhau1', role: 'sale', display_name: 'Lan' });
    assert.equal(sale.role, 'sale');
    const login = await fetch(base + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'lanfaq', password: 'matkhau1' }),
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const saleRes = await fetch(base + '/admin/api/faq/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ csv: file, confirm: true }),
    });
    assert.equal(saleRes.status, 403);

    const headers = { Authorization: basic, 'Content-Type': 'application/json' };
    const invalid = await fetch(base + '/admin/api/faq/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv: 'foo,bar\n1,2\n', confirm: true }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.match(invalidBody.error, /Thiếu cột/);

    const preview = await fetch(base + '/admin/api/faq/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv: file, confirm: false }),
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.preview, true);
    assert.equal(previewBody.added, 1);
    assert.equal((await store.all()).length, 0);

    const saved = await fetch(base + '/admin/api/faq/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv: file, confirm: true }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await store.all()).length, 1);

    const page = await fetch(base + '/admin/faq', { headers: { Authorization: basic } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Kiến thức FAQ/);
  } finally {
    server.close();
  }
});

test('messenger day-trip draft stays pending and is not the clarify re-ask', async () => {
  await seed([item({
    code: 'FAQ-TOUR',
    product: 'Chuyến mẫu',
    question: 'Đi trong ngày khác qua đêm thế nào',
    answer: 'Đi trong ngày farm đón ở mốc mẫu. Ở lại đêm farm có chỗ nghỉ mẫu.',
  })]);
  const calls = [];
  const result = await pipeline.handleMessage({
    channel: 'messenger',
    externalKey: 'fb_faq_tour',
    replyTo: 'faq_tour',
    text: 'Đi trong ngày khác qua đêm thế nào',
    msgId: 'faq-tour-1',
    senderName: 'Khách mẫu',
    send: async (to, text) => {
      calls.push({ to, text });
      return { ok: true };
    },
    log() {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.held, true);
  assert.equal(result.faq, true);
  assert.equal(calls.length, 0);
  const { drafts: rows } = await drafts.listDrafts('PENDING_REVIEW');
  const draft = rows.find(row => row.customer_user_id === 'fb_faq_tour');
  assert.ok(draft);
  assert.equal(draft.approval_status, 'PENDING_REVIEW');
  assert.match(draft.draft_reply, /chỗ nghỉ mẫu/);
  assert.doesNotMatch(draft.draft_reply, /ngày đến/);
  assert.doesNotMatch(draft.draft_reply, /Người duyệt/);
  assert.equal(draft.faq_review.handoff, false);
  assert.ok(draft.faq_review.codes.includes('FAQ-TOUR'));
});
