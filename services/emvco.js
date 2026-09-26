/**
 * NAPAS VietQR payload (EMVCo merchant-presented QR).
 * Built in-process. No image host, no VietQR HTTP API.
 *
 * CRC is CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection,
 * no final xor. EMVCo puts that 4 hex digits in tag 63.
 *
 * Merchant account (tag 38) follows NAPAS:
 *   00 GUID A000000727
 *   01 beneficiary: 00 BIN + 01 account
 *   02 service QRIBFTTA (transfer to account)
 * Transfer content is tag 62 / subtag 08, the invoice code exactly.
 */
const VCB_BIN = '970436';
const ACCOUNT = '1058437590';
const ACCOUNT_NAME = 'HTX NONG TRAI DOC MO';
const GUID = 'A000000727';
const SERVICE = 'QRIBFTTA';

function crc16(input) {
  const s = String(input);
  let crc = 0xFFFF;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      else crc = (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  const v = String(value);
  if (v.length > 99) {
    const err = new Error(`EMV field ${id} quá dài`);
    err.status = 400;
    throw err;
  }
  return String(id).padStart(2, '0') + String(v.length).padStart(2, '0') + v;
}

function amountText(amount) {
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (String(n).length > 13) {
    const err = new Error('Số tiền QR quá lớn');
    err.status = 400;
    throw err;
  }
  return String(n);
}

/**
 * Dynamic QR when amount > 0 (initiation 12 + tag 54).
 * Static account QR when the invoice is already paid in full (initiation 11, no amount).
 * addInfo is written exactly; banks show it as the transfer description.
 */
function buildPayload({ amount, addInfo, bin = VCB_BIN, account = ACCOUNT } = {}) {
  const info = String(addInfo || '').trim();
  if (!info) {
    const err = new Error('Thiếu nội dung chuyển khoản');
    err.status = 400;
    throw err;
  }
  if (info.length > 25) {
    const err = new Error('Nội dung chuyển khoản quá dài');
    err.status = 400;
    throw err;
  }
  const consumer = tlv('00', bin) + tlv('01', account);
  const merchant = tlv('00', GUID) + tlv('01', consumer) + tlv('02', SERVICE);
  const amt = amountText(amount);
  let body = tlv('00', '01') + tlv('01', amt ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
  if (amt) body += tlv('54', amt);
  body += tlv('58', 'VN') + tlv('62', tlv('08', info)) + '6304';
  return body + crc16(body);
}

function valid(payload) {
  const s = String(payload || '');
  if (!/6304[0-9A-F]{4}$/.test(s)) return false;
  return crc16(s.slice(0, -4)) === s.slice(-4);
}

function parseTlv(input) {
  const s = String(input || '');
  const out = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isFinite(len)) break;
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length !== len) break;
    out.push({ id, value });
    i += 4 + len;
  }
  return out;
}

/** Transfer description from tag 62 / subtag 08. Empty when the payload is not EMVCo. */
function readAddInfo(payload) {
  const extra = parseTlv(payload).find(field => field.id === '62');
  if (!extra) return '';
  const note = parseTlv(extra.value).find(field => field.id === '08');
  return note ? note.value : '';
}

module.exports = {
  crc16,
  tlv,
  buildPayload,
  valid,
  parseTlv,
  readAddInfo,
  VCB_BIN,
  ACCOUNT,
  ACCOUNT_NAME,
  GUID,
  SERVICE,
};
