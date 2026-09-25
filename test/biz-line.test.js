/**
 * Sale vs DV classifier, sticky manual move, soft delete.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-line-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const biz = require('../services/bizLine');
const drafts = require('../services/drafts');
const audit = require('../services/audit');

test('classifier is accent-insensitive and products win', () => {
  assert.equal(biz.classify('ĐẶT PHÒNG homestay'), 'dv');
  assert.equal(biz.classify('dat phong'), 'dv');
  assert.equal(biz.classify('ở lại 2 đêm'), 'dv');
  assert.equal(biz.classify('mua thịt heo'), 'sale');
  assert.equal(biz.classify('gia thit'), 'sale');
  assert.equal(biz.classify('phòng giá bao nhiêu và mua trứng'), 'sale');
  assert.equal(biz.classify('xin chào'), null);
  assert.equal(biz.resolve({ channel: 'messenger', text: 'alo', prior: null }).biz_line, 'sale');
  assert.equal(biz.resolve({ channel: 'zalo', text: 'dat phong', prior: null }).biz_line, null);
  const sticky = biz.resolve({
    channel: 'messenger',
    text: 'dat phong homestay',
    prior: { biz_line: 'sale', biz_sticky: true },
  });
  assert.equal(sticky.biz_line, 'sale');
  assert.equal(sticky.biz_sticky, true);
  const switched = biz.resolve({
    channel: 'messenger',
    text: 'o lai 2 dem',
    prior: { biz_line: 'sale', biz_sticky: false },
  });
  assert.equal(switched.biz_line, 'dv');
});

test('manual move sticks for the next message and is audited', async () => {
  const first = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_sticky',
    customer_query: 'xin chao',
    draft_reply: 'Dạ ạ',
  });
  assert.equal(first.biz_line, 'sale');
  const moved = await drafts.moveBizLine(first.id, 'dv', { actor: 'manager:Phước' });
  assert.equal(moved.biz_line, 'dv');
  assert.equal(moved.biz_sticky, true);
  const next = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_sticky',
    customer_query: 'mua thit heo',
    draft_reply: 'Dạ em ghi ạ',
  });
  assert.equal(next.biz_line, 'dv');
  assert.equal(next.biz_sticky, true);
  assert.equal((await drafts.getDraft(first.id)).biz_line, 'dv');
  const logs = await audit.list({ entity_id: first.id, action: 'draft.biz_line' });
  assert.equal(logs.logs[0].meta.from, 'sale');
  assert.equal(logs.logs[0].meta.to, 'dv');
  assert.equal(logs.logs[0].actor, 'manager:Phước');
});

test('soft delete hides the card and undo restores it', async () => {
  const d = await drafts.createDraft({
    channel: 'zalo',
    customer_user_id: 'zalo_x',
    customer_query: 'alo',
    draft_reply: 'Dạ ạ',
  });
  await drafts.softDelete(d.id, { actor: 'manager:Phước' });
  const list = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  assert.equal(list.drafts.some(item => item.id === d.id), false);
  assert.equal(list.groupCounts.zalo >= 0, true);
  await drafts.restoreDraft(d.id, { actor: 'manager:Phước' });
  const back = await drafts.listDrafts({ salesChannel: 'farm', nhom: 'zalo', hop: 'pending' });
  assert.ok(back.drafts.some(item => item.id === d.id));
  const logs = await audit.list({ entity_id: d.id, action: 'draft.deleted' });
  assert.equal(logs.logs.length, 1);
});
