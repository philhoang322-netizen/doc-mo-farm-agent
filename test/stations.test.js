/**
 * Filter station: local route labels, no model call, no send.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const stations = require('../services/stations');

test('price question routes to sales and keeps the customer words', () => {
  const out = stations.filterAndRoute('Dau goi gia bao nhieu?');
  assert.equal(out.route, 'sales');
  assert.equal(out.need, 'Hỏi giá');
  assert.equal(out.department, 'Sales');
  assert.equal(out.storedIntent, '[sales] Hỏi giá — Dau goi gia bao nhieu?');
});

test('usage question routes to faq', () => {
  const out = stations.filterAndRoute('Cách dùng và thành phần nước nghệ là gì?');
  assert.equal(out.route, 'faq');
  assert.equal(out.department, 'FAQ');
  assert.match(out.storedIntent, /^\[faq\] /);
});

test('asking for a person routes to needs-human', () => {
  const out = stations.filterAndRoute('Cho gặp nhân viên');
  assert.equal(out.route, 'needs-human');
  assert.equal(out.department, 'Người thật');
  assert.match(out.storedIntent, /\[needs-human\]/);
});

test('a greeting stays on other', () => {
  const out = stations.filterAndRoute('Xin chào');
  assert.equal(out.route, 'other');
  assert.equal(out.department, 'Khác');
});

test('forced route is used for step-aside even when the words look like sales', () => {
  const out = stations.filterAndRoute('giá bao nhiêu', 'needs-human');
  assert.equal(out.route, 'needs-human');
  assert.equal(out.department, 'Người thật');
});

test('prompt station keeps the Vietnamese filter instruction', () => {
  assert.match(stations.PROMPT_STATION, /Bạn là bộ lọc thông minh/);
  assert.match(stations.PROMPT_STATION, /viết câu trả lời ngắn gọn, lịch sự bằng tiếng Việt/);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'services', 'aiAgent.js'), 'utf8');
  assert.match(agent, /stations\.PROMPT_STATION/);
  assert.match(agent, /stations\.llmUserTurn/);
  const turn = stations.llmUserTurn('gia bao nhieu', stations.filterAndRoute('gia bao nhieu'));
  assert.match(turn, /Nhu cầu chính: Hỏi giá/);
  assert.match(turn, /Tuyến: sales/);
  assert.match(turn, /bản nháp/);
  assert.match(turn, /gia bao nhieu/);
});
