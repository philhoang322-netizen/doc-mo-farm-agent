/**
 * HITL review form: refund decision and compact ViettelPost address
 * stay on the draft and are not copied into the customer reply.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(os.tmpdir(), `review-form-${process.pid}.json`);
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../services/drafts');

test('review form saves refund decision and address without touching the reply', async () => {
  const created = await drafts.createDraft({
    channel: 'messenger',
    customer_name: 'Anh Hùng',
    customer_code: 'KH-88421',
    customer_intent: 'Muốn đổi trả đơn HD011637 — hàng bị rò, xin hoàn tiền.',
    draft_reply: 'Em đã nhận yêu cầu đổi trả. Farm chưa xử lý xong.',
    triage_level: 'urgent',
  });
  assert.equal(created.approval_status, 'PENDING_REVIEW');
  assert.equal(created.review_form.refund_decision, null);

  const saved = await drafts.updateDraft(created.id, {
    draft_reply: created.draft_reply,
    review_form: {
      refund_decision: 'hoi',
      refund_amount: '189.000đ',
      internal_note: 'Khách gửi ảnh rò — chờ Phước xác nhận trước khi hoàn.',
      kiot_ref: 'KH-88421',
      province_id: '2',
      province_name: 'TP. Hồ Chí Minh',
      district_id: '76',
      district_name: 'Quận Bình Thạnh',
      ward_id: '9121',
      ward_name: 'Phường 26',
      address_detail: '12 Nguyễn Xí',
      delivery_slot: 'sang',
    },
  });
  assert.equal(saved.draft.draft_reply, created.draft_reply);
  assert.equal(saved.draft.review_form.refund_decision, 'hoi');
  assert.equal(saved.draft.review_form.delivery_slot, 'sang');
  assert.equal(saved.draft.review_form.province_id, '2');
  assert.equal(saved.draft.review_form.ward_id, '9121');
  assert.doesNotMatch(saved.draft.draft_reply, /đã duyệt hoàn|đã hoàn tiền/i);
  assert.equal(saved.draft.approval_status, 'PENDING_REVIEW');
});

test('admin queue markup matches the approved HITL screen', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  assert.match(html, /Hàng chờ duyệt/);
  assert.match(html, /data-folder="pending"/);
  assert.match(html, /Cài đặt kênh/);
  assert.match(html, /data-triage="hot"/);
  assert.match(html, /data-triage="urgent"/);
  assert.match(html, /data-triage="normal"/);
  assert.match(js, /Duyệt & Gửi/);
  assert.match(js, /Thời gian hẹn giao/);
  assert.doesNotMatch(js, /PROVINCE_ID|DISTRICT_ID|WARDS_ID|addr-ids/);
  assert.match(js, /Không tự hoàn/);
  assert.match(js, /Tạo đơn KiotViet/);
  assert.match(js, /Điền vào đơn/);
  assert.match(js, /Tạo đơn VTP/);
  assert.match(js, /q\.set\('triage', triage\)/);
});
