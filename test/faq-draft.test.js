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
const persona = require('../services/faqPersona');
const faqAdmin = require('../services/faqAdmin');
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

test('live lookup still runs when the stored row is not a verified static answer', async () => {
  await seed([item({
    code: 'FAQ-LIVE',
    product: 'Sản phẩm mẫu A',
    question: 'Giá sản phẩm mẫu A là bao nhiêu',
    answer: 'KHONG-DOC-CAU-NAY',
    action_flag: 'LIVE',
    verify_status: 'needs_verification',
  })]);
  faqDraft.setKiotSearchForTests(async () => [{ name: 'Sản phẩm mẫu A', price: 222000 }]);
  const result = await faqDraft.compose('Giá sản phẩm mẫu A là bao nhiêu');
  assert.equal(result.reviewer.handoff, false);
  assert.match(result.text, /222\.000đ/);
  assert.equal(result.text.includes('KHONG-DOC-CAU-NAY'), false);
});

test('handoff flag keeps its reason when the row is not verified', async () => {
  await seed([item({
    code: 'FAQ-CN',
    question: 'Câu chuyển mẫu',
    answer: 'TOKEN-AN',
    action_flag: 'CHUYEN_NGUOI',
    verify_status: 'needs_verification',
  })]);
  const result = await faqDraft.compose('Câu chuyển mẫu');
  assert.equal(result.reviewer.handoff, true);
  assert.match(result.reviewer.reason, /chuyển người/);
  assert.equal(result.text.includes('TOKEN-AN'), false);
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
  assert.equal(csv.normalizeAction('TU_DONG'), 'TU_DONG');
  assert.equal(csv.normalizeAction('CHUYEN_NGUOI'), 'CHUYEN_NGUOI');
  assert.equal(csv.normalizeAction('TRA_CUU_LIVE_HOAC_CHUYEN_NGUOI'), 'LIVE');
  assert.equal(csv.normalizeAction('CHUA_BAT_BOT'), 'CHUA_BAT');
  assert.equal(csv.normalizeAction('LAM_GI_DO'), null);
  assert.equal(csv.normalizeAction(''), null);
  assert.equal(csv.normalizeVerify('cần xác minh'), 'needs_verification');
  assert.equal(csv.normalizeVerify('ĐÃ XÁC MINH'), 'verified');
  assert.equal(csv.normalizeVerify('CẦN XÁC MINH'), 'needs_verification');
  assert.equal(csv.normalizeVerify('DỮ LIỆU ĐỘNG (tra live/chuyển người)'), 'needs_verification');
  assert.equal(csv.normalizeVerify('CHUYỂN NGƯỜI (theo quy tắc)'), 'needs_verification');
  assert.equal(csv.normalizeVerify('CHƯA BẬT BOT'), 'needs_verification');
  assert.equal(csv.normalizeVerify('KHONG_RO'), null);

  const english = csv.parseFaqCsv(
    'code,group,product,question,answer,action_flag,verify_status\nEN-1,Nhóm,Món,Hỏi mẫu,Trả lời mẫu,auto,ok\n'
  );
  assert.deepEqual(english.errors, []);
  assert.equal(english.items[0].action_flag, 'TU_DONG');
  assert.equal(english.items[0].verify_status, 'verified');
  assert.equal(english.items[0].extra.notes, '');

  const rejected = csv.parseFaqCsv(
    'code,group,product,question,answer,action_flag,verify_status\nEN-2,Nhóm,Món,Hỏi mẫu,Trả lời mẫu,LAM_GI_DO,ĐÃ XÁC MINH\n'
  );
  assert.equal(rejected.items.length, 0);
  assert.match(rejected.errors[0], /Không gán TU_DONG/);
  const rejectedVerify = csv.parseFaqCsv(
    'code,group,product,question,answer,action_flag,verify_status\nEN-3,Nhóm,Món,Hỏi mẫu,Trả lời mẫu,TU_DONG,KHONG_RO\n'
  );
  assert.equal(rejectedVerify.items.length, 0);
  assert.match(rejectedVerify.errors[0], /Không gán verified/);

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
    assert.equal(previewBody.added, 6);
    assert.equal((await store.all()).length, 0);

    const saved = await fetch(base + '/admin/api/faq/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({ csv: file, confirm: true }),
    });
    assert.equal(saved.status, 200);
    const rows = await store.all();
    assert.equal(rows.length, 6);
    const flags = {};
    const verifies = {};
    for (const row of rows) {
      flags[row.action_flag] = (flags[row.action_flag] || 0) + 1;
      verifies[row.verify_status] = (verifies[row.verify_status] || 0) + 1;
    }
    assert.deepEqual(flags, { TU_DONG: 1, CHUYEN_NGUOI: 2, LIVE: 2, CHUA_BAT: 1 });
    assert.deepEqual(verifies, { verified: 1, needs_verification: 5 });
    const first = rows.find(row => row.code === 'MAU-1');
    assert.equal(first.group, 'Nhóm mẫu');
    assert.equal(first.product, 'Sản phẩm mẫu');
    assert.equal(first.extra.question_group, 'Nhóm câu mẫu');
    assert.equal(first.extra.intent, 'ý định mẫu');
    assert.equal(first.extra.confidence_label, 'Cao');
    assert.equal(first.extra.notes, 'ghi chú mẫu');
    assert.equal(first.extra.source_as_of, '01/01/2026');
    assert.equal(first.extra.action_label, 'TU_DONG');
    assert.equal(first.extra.verify_label, 'ĐÃ XÁC MINH');
    assert.equal(first.conditions, 'điều kiện mẫu');
    assert.equal(first.source, 'nguồn mẫu, bản A');
    assert.equal(first.action_flag, 'TU_DONG');
    assert.equal(first.verify_status, 'verified');

    const page = await fetch(base + '/admin/faq', { headers: { Authorization: basic } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Kiến thức FAQ/);
  } finally {
    server.close();
  }
});

test('rules import stores both files and leaves the placeholder until then', async () => {
  assert.equal((await store.currentRules()).version, 0);
  assert.equal((await store.currentRules()).body, persona.DEFAULT_RULES);
  assert.equal(
    faqAdmin.combineRuleParts({ rules: 'QUY-TAC-MAU', system_prompt: 'PROMPT-MAU' }),
    'QUY-TAC-MAU\n\n---\n\nPROMPT-MAU'
  );
  assert.equal(faqAdmin.combineRuleParts({ body: 'MOT-CHUOI' }), 'MOT-CHUOI');
  assert.equal(
    faqAdmin.combineRuleParts({ rules: 'QUY-TAC-MAU', body: 'BO-QUA' }),
    'QUY-TAC-MAU'
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  hitlAdmin.mount(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const headers = { Authorization: basic, 'Content-Type': 'application/json' };
    const saved = await fetch(base + '/admin/api/faq/rules', {
      method: 'POST',
      headers,
      body: JSON.stringify({ rules: 'QUY-TAC-MAU', system_prompt: 'PROMPT-MAU' }),
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.version, 1);
    assert.equal(body.body, 'QUY-TAC-MAU\n\n---\n\nPROMPT-MAU');
    const editor = await fetch(base + '/admin/api/faq/rules', {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: 'MOT-CHUOI' }),
    });
    assert.equal(editor.status, 200);
    assert.equal((await editor.json()).version, 2);
    const empty = await fetch(base + '/admin/api/faq/rules', {
      method: 'POST',
      headers,
      body: JSON.stringify({ rules: ' ', system_prompt: '' }),
    });
    assert.equal(empty.status, 400);
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
