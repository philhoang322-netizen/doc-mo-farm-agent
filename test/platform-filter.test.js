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

test('admin queue exposes Tin từ chips above Mức', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'review.js'), 'utf8');
  const tin = html.indexOf('Tin từ');
  const muc = html.indexOf('>Mức<');
  assert.ok(tin > 0 && muc > tin);
  assert.match(html, /Kênh bán/);
  assert.match(html, /data-platform=""/);
  assert.match(html, /data-platform="zalo"/);
  assert.match(html, /Zalo OA/);
  assert.match(html, /data-platform="messenger"/);
  assert.match(html, /Messenger/);
  assert.match(js, /d\.channel !== q\.platform|platform/);
  assert.match(js, /q\.set\('platform', platform\)/);
  assert.match(js, /Không có tin ' \+ name/);
  assert.match(js, /Zalo OA và Messenger/);
  assert.doesNotMatch(js, /approval_status:\s*'APPROVED'[\s\S]{0,80}send:\s*true[\s\S]{0,40}auto/);
});
