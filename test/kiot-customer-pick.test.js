/**
 * One Kiot customer pick for preview and for the invoice.
 * Synthetic duplicates only. No live retailer calls.
 */
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.KIOTVIET_CLIENT_ID = 'test-client';
process.env.KIOTVIET_CLIENT_SECRET = 'test-secret';
process.env.KIOTVIET_RETAILER = 'demo-shop';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kiotviet = require('../services/kiotviet');

const OLDER = '2026-01-01T00:00:00.000Z';
const NEWER = '2026-09-01T00:00:00.000Z';

function row(patch) {
  return Object.assign({
    id: 1,
    code: 'KH-A',
    name: 'Khách A',
    contactNumber: '0900000000',
    address: '',
    locationName: '',
    wardName: '',
    createdDate: OLDER,
  }, patch);
}

test('a customer with an address beats a newer one without', () => {
  const picked = kiotviet.pickCustomer([
    row({ id: 2, code: 'KH-NEW', createdDate: NEWER, address: '' }),
    row({ id: 1, code: 'KH-OLD', createdDate: OLDER, address: '12 Đường Thử' }),
  ]);
  assert.equal(picked.code, 'KH-OLD');
});

test('the newest addressed customer wins among several', () => {
  const picked = kiotviet.pickCustomer([
    row({ id: 1, code: 'KH-OLD', createdDate: OLDER, wardName: 'Phường 1' }),
    row({ id: 3, code: 'KH-NEW', createdDate: NEWER, locationName: 'Quận 1' }),
  ]);
  assert.equal(picked.code, 'KH-NEW');
});

test('with no address, the newest customer wins', () => {
  const picked = kiotviet.pickCustomer([
    row({ id: 1, code: 'KH-OLD', createdDate: OLDER }),
    row({ id: 4, code: 'KH-NEW', createdDate: NEWER }),
  ]);
  assert.equal(picked.code, 'KH-NEW');
});

test('ties and missing dates are deterministic', () => {
  const sameDay = kiotviet.pickCustomer([
    row({ id: 2, code: 'KH-B', createdDate: NEWER, address: 'A' }),
    row({ id: 9, code: 'KH-A', createdDate: NEWER, address: 'B' }),
  ]);
  assert.equal(sameDay.id, 9);
  const missing = kiotviet.pickCustomer([
    row({ id: 2, code: 'KH-B', createdDate: '', address: 'A' }),
    row({ id: 8, code: 'KH-Z', createdDate: null, address: 'B' }),
  ]);
  assert.equal(missing.id, 8);
  const datedBeatsBlank = kiotviet.pickCustomer([
    row({ id: 20, code: 'KH-BLANK', createdDate: '', address: 'A' }),
    row({ id: 3, code: 'KH-DATED', createdDate: OLDER, address: 'B' }),
  ]);
  assert.equal(datedBeatsBlank.code, 'KH-DATED');
  const noId = kiotviet.pickCustomer([
    row({ id: null, code: 'KH-B', createdDate: NEWER }),
    row({ id: null, code: 'KH-A', createdDate: NEWER }),
  ]);
  assert.equal(noId.code, 'KH-A');
});

test('preview lookup and sale creation share one page of customers', async () => {
  const rows = [
    row({ id: 2, code: 'KH-NEW', name: 'Khách Mới', createdDate: NEWER }),
    row({ id: 1, code: 'KH-OLD', name: 'Khách Cũ', createdDate: OLDER, address: '12 Đường Thử' }),
  ];
  const seen = [];
  const realCall = kiotviet.call;
  kiotviet.call = async (method, path, opts) => {
    seen.push({ method, path, pageSize: opts && opts.params && opts.params.pageSize });
    assert.equal(path, '/customers');
    return { data: rows };
  };
  try {
    const looked = await kiotviet.findCustomerByPhone('0900000000');
    const created = await kiotviet.findOrCreateCustomer({
      name: 'Khách Gõ',
      phone: '0900000000',
    });
    assert.equal(looked.code, 'KH-OLD');
    assert.equal(created.id, looked.id);
    assert.equal(created.code, looked.code);
    assert.equal(created.name, looked.name);
    assert.deepEqual(seen.map(call => call.pageSize), [20, 20]);
    assert.equal(seen.some(call => call.method === 'post'), false);
  } finally {
    kiotviet.call = realCall;
  }
});
