/**
 * Channel display names. Graph and Zalo are mocked. A failed lookup
 * leaves the card usable and does not include the page token.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-names-'));
process.env.DATABASE_URL = '';
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.CHANNEL_NAMES_PATH = path.join(dir, 'channel_names.json');
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'secret';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-test';
delete process.env.ZALO_ACCESS_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const names = require('../services/channelNames');
const messenger = require('../services/messenger');
const zaloService = require('../services/zaloService');
const kiotviet = require('../services/kiotviet');
const drafts = require('../services/drafts');
const hitlAdmin = require('../services/hitlAdmin');

const realGet = messenger.graphHttp.get;
const realProfile = zaloService.getUserProfile;

function restore() {
  messenger.graphHttp.get = realGet;
  zaloService.getUserProfile = realProfile;
}

test('Messenger and Zalo names are cached, and a Graph error does not block', async () => {
  let graphCalls = 0;
  messenger.graphHttp.get = async (url, config) => {
    graphCalls += 1;
    assert.equal(String(url).includes('page-token-test'), false);
    assert.equal(config.params.access_token, 'page-token-test');
    assert.equal(config.params.fields, 'first_name,last_name,name,profile_pic');
    const err = new Error('permission');
    err.response = { status: 400, data: { error: { code: 10, message: 'permission' } } };
    throw err;
  };
  const missed = await names.forDraft({
    channel: 'messenger',
    customer_user_id: 'fb_1001',
    customer_name: 'Khách cũ',
  });
  assert.deepEqual(missed, []);
  assert.equal(graphCalls, 1);
  const again = await names.forDraft({ channel: 'messenger', customer_user_id: 'fb_1001' });
  assert.deepEqual(again, []);
  assert.equal(graphCalls, 1);

  messenger.graphHttp.get = async () => ({
    data: {
      first_name: 'Lan',
      last_name: 'Pham',
      name: 'Lan Pham',
      profile_pic: 'https://example.com/lan.jpg',
    },
  });
  const staleAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await names.remember('fb_1001', { fb: { name: null, fetched_at: staleAt } });
  const fb = await names.forDraft({ channel: 'messenger', customer_user_id: 'fb_1001' });
  assert.equal(fb[0].label, 'Tên FB');
  assert.equal(fb[0].name, 'Lan Pham');
  assert.equal(fb[0].avatar, 'https://example.com/lan.jpg');
  assert.equal(fb[0].own, true);
  const cached = await names.forDraft({ channel: 'messenger', customer_user_id: 'fb_1001' });
  assert.equal(cached[0].name, 'Lan Pham');

  zaloService.setTokens('oa-token-test', null);
  let zaloCalls = 0;
  zaloService.getUserProfile = async (userId) => {
    zaloCalls += 1;
    assert.equal(userId, 'zalo-9');
    return { error: 0, data: { display_name: 'Chị Hoa', avatar: 'https://example.com/hoa.jpg' } };
  };
  const zalo = await names.forDraft({ channel: 'zalo', customer_user_id: 'zalo-9' });
  assert.equal(zalo[0].label, 'Tên Zalo');
  assert.equal(zalo[0].name, 'Chị Hoa');
  assert.equal(zalo[0].avatar, 'https://example.com/hoa.jpg');
  await names.forDraft({ channel: 'zalo', customer_user_id: 'zalo-9' });
  assert.equal(zaloCalls, 1);

  zaloService.getUserProfile = async () => ({ error: -213, message: 'no profile' });
  await names.remember('zalo-miss', {
    zalo: { name: null, fetched_at: staleAt },
  });
  const quiet = await names.forDraft({
    channel: 'zalo',
    customer_user_id: 'zalo-miss',
    customer_name: 'Tên cũ',
  });
  assert.deepEqual(quiet, []);

  await names.remember('linked-1', {
    zalo: { name: 'Chị Hoa', avatar: 'https://example.com/hoa.jpg', fetched_at: new Date().toISOString() },
    fb: { name: 'Lan Pham', avatar: 'http://insecure.example/a.jpg', fetched_at: new Date().toISOString() },
  });
  const both = await names.forDraft({ channel: 'zalo', customer_user_id: 'linked-1' });
  assert.deepEqual(both.map(item => item.label), ['Tên Zalo', 'Tên FB']);
  assert.equal(both[1].avatar, null);

  const typed = names.formName({
    managerName: 'Tên quản lý',
    kiotName: 'Tên Kiot',
    channelNames: both,
    draftName: 'Tên cũ',
  });
  assert.equal(typed.name, 'Tên quản lý');
  assert.equal(typed.hint, '');
  const fromKiot = names.formName({ kiotName: 'Tên Kiot', channelNames: both, draftName: 'Tên cũ' });
  assert.equal(fromKiot.name, 'Tên Kiot');
  assert.equal(fromKiot.hint, '');
  const fromChannel = names.formName({ channelNames: both, draftName: 'Tên cũ' });
  assert.equal(fromChannel.name, 'Chị Hoa');
  assert.equal(fromChannel.hint, 'lấy từ Tên Zalo');
  const fbHint = names.formName({
    channelNames: both.map(item => ({ ...item, own: item.source === 'fb' })),
  });
  assert.equal(fbHint.hint, 'lấy từ Tên FB');
  assert.equal(names.formName({ draftName: 'Tên cũ' }).name, 'Tên cũ');
  assert.equal(names.kiotComment(both), 'Zalo: Chị Hoa');
  assert.equal(names.kiotComment(both.map(item => ({ ...item, own: item.source === 'fb' }))), 'FB: Lan Pham');
  restore();
});

test('the inbox list attaches names and the Kiot form prefers a matched customer', async () => {
  messenger.graphHttp.get = async () => ({ data: { name: 'Mai FB', profile_pic: 'https://example.com/mai.jpg' } });
  const draft = await drafts.createDraft({
    channel: 'messenger',
    customer_user_id: 'fb_2002',
    customer_name: 'Mai nháp',
    customer_phone: '0901234567',
    customer_query: 'Đặt rau',
    draft_reply: 'Dạ',
  });
  const realFind = kiotviet.findCustomerByPhone;
  kiotviet.findCustomerByPhone = async () => ({ id: 7, name: 'Mai Kiot' });
  const app = express();
  app.use(express.json());
  hitlAdmin.mount(app);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Basic ' + Buffer.from('farm:secret').toString('base64') };
  try {
    const list = await fetch(base + '/admin/api/drafts?kenh=farm', { headers });
    const body = await list.json();
    const row = body.drafts.find(item => item.id === draft.id);
    assert.ok(row);
    assert.equal(row.channel_names[0].label, 'Tên FB');
    assert.equal(row.channel_names[0].name, 'Mai FB');
    assert.equal(row.approval_status, 'PENDING_REVIEW');

    const pre = await fetch(base + '/admin/api/drafts/' + draft.id + '/kiotviet', { headers });
    const form = await pre.json();
    assert.equal(form.customer_name, 'Mai Kiot');
    assert.equal(form.name_hint, '');

    kiotviet.findCustomerByPhone = async () => null;
    const channelForm = await (await fetch(base + '/admin/api/drafts/' + draft.id + '/kiotviet', { headers })).json();
    assert.equal(channelForm.customer_name, 'Mai FB');
    assert.equal(channelForm.name_hint, 'lấy từ Tên FB');
    assert.equal(JSON.stringify(channelForm).includes('page-token-test'), false);
  } finally {
    kiotviet.findCustomerByPhone = realFind;
    restore();
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
