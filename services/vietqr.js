/**
 * VietQR payment codes.
 *
 * img.vietqr.io renders a standards-compliant transfer QR straight from a URL —
 * no account, no API key. The customer scans it and their banking app is
 * pre-filled with our account, the exact amount, and the order number as the
 * transfer note, which is what lets the farm match a payment to an order.
 *
 * Docs: https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/api-tao-ma-qr/
 */

const BASE = 'https://img.vietqr.io/image';

function configured() {
  return !!(process.env.BANK_CODE && process.env.BANK_ACCOUNT);
}

/** addInfo allows no special characters — strip accents and punctuation. */
function cleanNote(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

/**
 * @param {number} amount  VND, positive integer
 * @param {string} note    transfer content, usually the order number
 * @returns {string|null}  image URL, or null if the bank details aren't set
 */
function imageUrl(amount, note) {
  if (!configured()) return null;
  const bank = process.env.BANK_CODE;            // e.g. "vietcombank" or "970436"
  const account = process.env.BANK_ACCOUNT;
  const template = process.env.BANK_QR_TEMPLATE || 'compact2';
  const params = new URLSearchParams();
  if (amount > 0) params.set('amount', String(Math.round(amount)));
  if (note) params.set('addInfo', cleanNote(note));
  if (process.env.BANK_ACCOUNT_NAME) params.set('accountName', process.env.BANK_ACCOUNT_NAME);
  return `${BASE}/${bank}-${account}-${template}.png?${params.toString()}`;
}

/**
 * Does this message ask to pay by bank transfer, or ask for our account / QR?
 *
 * Customers rarely write "chuyển khoản" in full — they write ck, stk, tk,
 * "gởi qr", "xin số tk". Relying on the model to classify this would fail
 * quietly, so the pipeline checks the raw text too.
 */
const TRANSFER_WORDS = [
  'chuyen khoan', 'chuyen tien', 'chuyenkhoan',
  'ck', 'cknh',
  'stk', 'so tk', 'so tai khoan', 'tai khoan', 'tk',
  'qr', 'qrcode', 'qr code', 'ma qr', 'vietqr', 'quet ma',
  'bank', 'banking', 'atm', 'internet banking',
];

function wantsTransfer(text) {
  const t = String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // "qr-code" → "qr code"
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return TRANSFER_WORDS.some(w => new RegExp(`(^|\\s)${w}(\\s|$)`).test(t));
}

/** Account details to send when a customer asks but has no order yet. */
function accountInfoMessage() {
  if (!configured()) return null;
  return [
    'Dạ farm gửi bạn thông tin chuyển khoản ạ 🌿',
    '',
    `Ngân hàng: ${process.env.BANK_CODE_DISPLAY || process.env.BANK_CODE}`,
    `Số tài khoản: ${process.env.BANK_ACCOUNT}`,
    process.env.BANK_ACCOUNT_NAME ? `Chủ tài khoản: ${process.env.BANK_ACCOUNT_NAME}` : null,
    '',
    'Bạn quét mã QR bên dưới cho nhanh nha. Nhớ ghi nội dung chuyển khoản là ' +
    'tên hoặc số điện thoại của bạn để farm đối soát ạ!',
  ].filter(Boolean).join('\n');
}

/** The message sent alongside the QR image. */
function caption(order) {
  const amount = Number(order.total || 0).toLocaleString('vi');
  const lines = [
    `Dạ đơn ${order.order_number} của bạn: ${amount}đ 🌿`,
    '',
    'Bạn quét mã QR để chuyển khoản, nội dung đã điền sẵn mã đơn nên farm đối soát được ngay ạ.',
  ];
  if (process.env.BANK_ACCOUNT_NAME && process.env.BANK_ACCOUNT) {
    lines.push(
      '',
      `Hoặc chuyển thủ công:`,
      `${process.env.BANK_CODE_DISPLAY || process.env.BANK_CODE} — ${process.env.BANK_ACCOUNT}`,
      `${process.env.BANK_ACCOUNT_NAME}`,
      `Nội dung: ${cleanNote(order.order_number)}`
    );
  }
  lines.push('', 'Nếu bạn chọn thanh toán khi nhận hàng (COD) thì bỏ qua mã này nha ạ!');
  return lines.join('\n');
}

module.exports = { imageUrl, caption, configured, cleanNote, wantsTransfer, accountInfoMessage };
