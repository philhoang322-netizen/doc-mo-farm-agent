/**
 * Inbox time sections. Buckets use Asia/Ho_Chi_Minh civil dates.
 * Week starts Monday. Today and this week are taken out of the month
 * bucket. A time just after midnight ICT must not fall on the previous UTC day.
 */
const path = require('path');
const fs = require('fs');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sections = require('../public/admin/inbox-sections');
const order = require('../public/admin/inbox-order');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'admin', 'review.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'admin', 'review.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'admin', 'review.css'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'services', 'hitlAdmin.js'), 'utf8');

test('week starts Monday, and Sunday in the same month stays in the month', () => {
  // Monday 2026-09-21 00:30 ICT.
  const now = '2026-09-20T17:30:00.000Z';
  assert.equal(sections.bucket('2026-09-20T17:10:00.000Z', now), 'today');
  assert.equal(sections.bucket('2026-09-20T16:50:00.000Z', now), 'month');
  assert.equal(sections.bucket('2026-09-01T03:00:00.000Z', now), 'month');
  assert.equal(sections.bucket('2026-08-31T10:00:00.000Z', now), 'older');
  const grouped = sections.group([
    { id: 'sun', source_received_at: '2026-09-20T16:50:00.000Z' },
    { id: 'mon', source_received_at: '2026-09-20T17:10:00.000Z' },
  ], now);
  assert.deepEqual(grouped.map(section => section.id), ['today', 'month']);
  assert.equal(grouped.find(section => section.id === 'week'), undefined);
});

test('month bucket excludes today and this week, including a Monday in the previous month', () => {
  // Thursday 2026-09-10 12:00 ICT. Week starts Monday Sep 7.
  const now = '2026-09-10T05:00:00.000Z';
  assert.equal(sections.bucket('2026-09-10T04:00:00.000Z', now), 'today');
  assert.equal(sections.bucket('2026-09-09T10:00:00.000Z', now), 'week');
  assert.equal(sections.bucket('2026-09-06T17:00:00.000Z', now), 'week');
  assert.equal(sections.bucket('2026-09-06T16:59:00.000Z', now), 'month');
  assert.equal(sections.bucket('2026-09-01T02:00:00.000Z', now), 'month');
  assert.equal(sections.bucket('2026-08-31T16:00:00.000Z', now), 'older');

  // Tuesday 2026-09-01 12:00 ICT. Monday of that week is Aug 31.
  const sep1 = '2026-09-01T05:00:00.000Z';
  assert.equal(sections.bucket('2026-09-01T00:00:00.000Z', sep1), 'today');
  assert.equal(sections.bucket('2026-08-31T11:00:00.000Z', sep1), 'week');
  assert.equal(sections.bucket('2026-08-30T16:00:00.000Z', sep1), 'older');
});

test('midnight ICT stays on the ICT day, not the previous UTC day', () => {
  // Saturday 2026-09-26 00:15 ICT.
  const now = '2026-09-25T17:15:00.000Z';
  assert.equal(sections.bucket('2026-09-25T17:05:00.000Z', now), 'today');
  assert.equal(sections.bucket('2026-09-25T16:50:00.000Z', now), 'week');
  assert.equal(sections.bucketOf({
    source_received_at: '2026-09-25T17:05:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
  }, now), 'today');
  assert.equal(sections.bucketOf({ created_at: '2026-09-25T17:05:00.000Z' }, now), 'today');
  assert.equal(sections.bucketOf({}, now), 'older');
  assert.equal(sections.bucket('', now), 'older');
});

test('group hides empty sections and keeps newest-first order', () => {
  const now = '2026-09-25T17:15:00.000Z';
  const rows = order.sort([
    { id: 'b', source_received_at: '2026-09-25T18:00:00.000Z' },
    { id: 'a', source_received_at: '2026-09-25T18:00:00.000Z' },
    { id: 'c', source_received_at: '2026-09-25T20:00:00.000Z' },
    { id: 'old', source_received_at: '2026-08-01T03:00:00.000Z' },
    { id: 'week', created_at: '2026-09-23T03:00:00.000Z' },
  ]);
  const grouped = sections.group(rows, now);
  assert.deepEqual(grouped.map(section => section.id), ['today', 'week', 'older']);
  assert.deepEqual(grouped[0].items.map(item => item.id), ['c', 'b', 'a']);
  assert.deepEqual(grouped.map(section => section.title), ['Hôm nay', 'Trong tuần', 'Cũ hơn']);
  assert.equal(sections.group([], now).length, 0);
});

test('open state is remembered per tab and today starts open', () => {
  const storage = sections.memoryStorage();
  assert.equal(sections.isOpen('zalo', 'today', storage), true);
  assert.equal(sections.isOpen('zalo', 'week', storage), false);
  assert.equal(sections.isOpen('fb-sale', 'month', storage), false);
  assert.equal(sections.isOpen('fb-dv', 'older', storage), false);
  sections.setOpen('fb-sale', 'week', true, storage);
  sections.setOpen('zalo', 'today', false, storage);
  assert.equal(sections.isOpen('fb-sale', 'week', storage), true);
  assert.equal(sections.isOpen('zalo', 'week', storage), false);
  assert.equal(sections.isOpen('fb-dv', 'week', storage), false);
  assert.equal(sections.isOpen('zalo', 'today', storage), false);
  assert.equal(sections.isOpen('fb-sale', 'today', storage), true);
  const broken = sections.memoryStorage({ 'inbox-sections': '{' });
  assert.equal(sections.isOpen('zalo', 'today', broken), true);
  assert.equal(sections.isOpen('zalo', 'older', broken), false);
});

test('inbox page loads the section script and a 48px header', () => {
  assert.match(html, /src="\/admin\/inbox-sections\.js"/);
  assert.match(admin, /\/admin\/inbox-sections\.js/);
  assert.match(js, /inbox-section-head/);
  assert.match(js, /inboxSections\.setOpen\(nhom/);
  assert.match(js, /refreshSection\(section\)/);
  assert.match(css, /body\.inbox \.inbox-section-head \{[^}]*min-height:\s*48px/s);
  assert.equal(sections.TITLES.today, 'Hôm nay');
  assert.equal(sections.TITLES.week, 'Trong tuần');
  assert.equal(sections.TITLES.month, 'Trong tháng');
  assert.equal(sections.TITLES.older, 'Cũ hơn');
});
