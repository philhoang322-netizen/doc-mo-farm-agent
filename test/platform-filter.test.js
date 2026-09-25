/**
 * Tin từ filter: messaging platform (zalo / messenger) is separate from
 * sales channel. A custom sales channel named zalo must stay empty.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATABASE_URL = '';
const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-filter-'));
process.env.DRAFTS_JSON_PATH = path.join(draftDir, 'drafts.json');
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../services/drafts');

test('platform filter keeps Zalo OA and Messenger apart from sales channels', async () => {
  const zalo = await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_name: 'Bạn Lan',
    draft_reply: 'Tin Zalo OA trên @Farm',
    triage_level: 'normal',
  });
  const messenger = await drafts.createDraft({
    channel: 'messenger',
    sales_channel: 'farm',
    customer_name: 'Anh Hùng',
    draft_reply: 'Tin Messenger trên @Farm',
    triage_level: 'hot',
  });
  await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'shopee',
    customer_name: 'Khách Shopee',
    draft_reply: 'Tin Zalo trên Shopee',
    triage_level: 'urgent',
  });

  const farm = await drafts.listDrafts({ salesChannel: 'farm', ops: 'pending' });
  assert.equal(farm.drafts.length, 2);
  assert.equal(farm.platformCounts.zalo, 1);
  assert.equal(farm.platformCounts.messenger, 1);

  const onlyZalo = await drafts.listDrafts({ salesChannel: 'farm', ops: 'pending', platform: 'zalo' });
  assert.deepEqual(onlyZalo.drafts.map(d => d.id), [zalo.id]);
  assert.ok(onlyZalo.drafts.every(d => d.channel === 'zalo'));
  assert.equal(onlyZalo.platformCounts.zalo, 1);
  assert.equal(onlyZalo.platformCounts.messenger, 1);

  const onlyMessenger = await drafts.listDrafts({ salesChannel: 'farm', ops: 'pending', platform: 'messenger' });
  assert.deepEqual(onlyMessenger.drafts.map(d => d.id), [messenger.id]);
  assert.ok(onlyMessenger.drafts.every(d => d.channel === 'messenger'));

  const hotZalo = await drafts.listDrafts({ salesChannel: 'farm', ops: 'pending', platform: 'zalo', triage: 'hot' });
  assert.equal(hotZalo.drafts.length, 0);
  assert.equal(hotZalo.platformCounts.messenger, 1);
  assert.equal(hotZalo.platformCounts.zalo, 0);

  const custom = await drafts.addChannel('zalo');
  const namedZalo = await drafts.listDrafts({ salesChannel: custom.id, ops: 'pending', platform: 'zalo' });
  assert.equal(namedZalo.drafts.length, 0);
  assert.equal(namedZalo.platformCounts.zalo, 0);

  await assert.rejects(
    () => drafts.listDrafts({ platform: 'fb' }),
    /Nền tảng không hợp lệ/
  );
});

test('admin queue exposes inbox groups above Mức', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  const refresh = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'inbox-refresh.js'), 'utf8');
  const nhom = html.indexOf('Nhóm hộp thư');
  const muc = html.indexOf('>Mức<');
  assert.ok(nhom > 0 && muc > nhom);
  assert.match(html, /Kênh bán/);
  assert.match(html, /id="channel-panel"/);
  assert.doesNotMatch(html, /class="channel-row"/);
  assert.match(html, /id="hot-chip"/);
  assert.match(html, /Bộ lọc/);
  assert.match(html, /<details class="queue-stats">/);
  assert.doesNotMatch(html, /<details class="queue-stats" open>/);
  assert.match(html, /id="folder-nav"/);
  assert.match(js, /pendingGroupCounts/);
  assert.match(js, /Xóa lọc/);
  assert.match(js, /showChannelChip/);
  assert.match(html, /data-nhom="zalo"/);
  assert.match(html, /Zalo OA/);
  assert.match(html, /data-nhom="fb-sale"/);
  assert.match(html, /FB-Sale/);
  assert.match(html, /data-nhom="fb-dv"/);
  assert.match(html, /FB-DV/);
  assert.match(html, /id="refresh-now"/);
  assert.match(html, /Làm mới/);
  assert.match(html, /id="sync-missed"/);
  assert.match(html, /Đồng bộ tin bị sót/);
  assert.match(html, /Cập nhật lúc/);
  assert.match(js, /q\.set\('nhom', nhom\)/);
  assert.match(js, /Không có tin ' \+ name/);
  assert.match(js, /Zalo OA, FB-Sale hoặc FB-DV/);
  assert.match(js, /Chuyển qua Sale/);
  assert.match(js, /Chuyển qua DV/);
  assert.match(html, /inbox-refresh\.js/);
  assert.match(refresh, /Có ' \+ n \+ ' tin mới — bấm để hiện/);
  assert.match(js, /background: true/);
  assert.match(js, /listMutation\(mode, hold\)/);
  assert.doesNotMatch(js, /newEl[\s\S]{0,180}scrollIntoView/);
  assert.doesNotMatch(js, /approval_status:\s*'APPROVED'[\s\S]{0,80}send:\s*true[\s\S]{0,40}auto/);
});
