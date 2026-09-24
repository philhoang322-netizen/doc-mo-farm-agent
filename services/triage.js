/**
 * Inbox triage for every inbound customer message.
 *
 * Runs locally, before any model call, on Zalo OA, Zalo Bot, and Messenger.
 * The existing station route (sales | faq | needs-human | other) stays.
 * This module adds one of three levels stored on the HITL draft:
 *
 *   hot    Nóng    buy intent, an order, price plus a quantity, checkout
 *   urgent Khẩn    complaint, return, exchange, refund, anger,
 *                  or a request to reach a person about a problem
 *   normal Thường  product, price, and shipping questions that are not an order
 *
 * Urgent after-sales text never becomes a model draft. The canned reply
 * only acknowledges and asks for the missing facts. It does not say the
 * return, exchange, or refund is approved. The draft stays PENDING_REVIEW
 * and the needs-human route hands the thread to whoever is on shift.
 */
const ops = require('./ops');
const drift = require('./drift');

const LEVELS = ['hot', 'urgent', 'normal'];

const LABEL = {
  hot: 'Nóng',
  urgent: 'Khẩn',
  normal: 'Thường',
};

const REFUND = ['hoan tien', 'hoan lai tien', 'refund', 'tra lai tien', 'nhan lai tien'];
const RETURN = ['doi tra', 'tra hang', 'tra lai hang', 'gui tra hang'];
const EXCHANGE = [
  'doi hang', 'doi san pham', 'doi qua', 'doi mau', 'doi size', 'doi loai',
  'doi dac biet', 'yeu cau dac biet',
];
const COMPLAINT = [
  'khieu nai', 'phan nan', 'to cao',
  'bi hong', 'hang hong', 'hong hang', 'hu hong',
  'bi hu', 'hang hu', 'vo chai', 'bi vo',
  'bi moc', 'bi thiu', 'boc mui',
  'sai hang', 'giao sai', 'gui sai', 'thieu hang', 'giao thieu',
  'kem chat luong', 'chat luong kem', 'khong dung nhu', 'that vong',
];
const ANGER = [
  'tuc gian', 'buc minh', 'buc xuc', 'gian qua', 'tuc qua',
  'lua dao', 'bom hang', 'te qua',
];
const HOT_PHRASES = [
  'dat hang', 'dat don', 'chot don', 'chot hang', 'chot luon',
  'muon mua', 'mua hang', 'mua giup', 'mua luon',
  'lay hang', 'gui hang',
  'thanh toan', 'chuyen khoan', 'checkout',
];
const PRICE = ['gia', 'bao nhieu'];
const QTY = /(?:^|\s)\d+\s*(chai|hop|lo|goi|tui|kg|gram|gr|ml|thung|phan|suat|cai|bich|loc|hu)(?:\s|$)/;
const BUY_WORD = /(?:^|\s)(mua|chot|order)(?:\s|$)/;
const CHECKOUT_WORD = /(?:^|\s)ck(?:\s|$)/;
const QTY_VERB = /(?:^|\s)(lay|gui|dat|chuyen)(?:\s|$)/;

const APPROVAL = [
  'da duyet',
  'da chap nhan',
  'da chap thuan',
  'chap thuan',
  'dong y hoan',
  'dong y doi',
  'dong y tra',
  'da hoan tien',
  'se hoan tien',
  'duoc hoan',
  'hoan tien ngay',
  'da xac nhan',
  'xac nhan yeu cau',
  'xac nhan doi',
  'xac nhan hoan',
  'xac nhan tra',
  'refund approved',
  'return approved',
  'da dong y',
  'yeu cau da duoc',
  'duoc doi hang',
  'duoc tra hang',
  'duoc hoan',
  'em da xu ly xong',
];

const SAFE_AFTERSALES = [
  'Dạ em đã nhận yêu cầu đổi, trả, hoặc hoàn tiền.',
  'Tin này chưa phải xác nhận. Farm chưa xử lý xong yêu cầu đó.',
  'Bạn gửi giúp em mã đơn hoặc số điện thoại lúc đặt, tên sản phẩm, và lý do mình muốn đổi, trả, hay nhận lại tiền.',
  'Nhân viên farm sẽ xem và trả lời trực tiếp ạ.',
].join('\n');

const SAFE_COMPLAINT = [
  'Dạ em đã nhận phản hồi của mình.',
  'Em chưa kết luận đúng sai trong tin này.',
  'Bạn mô tả giúp em sản phẩm, mã đơn nếu có, và việc mình đang gặp.',
  'Nhân viên farm sẽ xem và liên hệ lại ạ.',
].join('\n');

const SAFE_ANGER = [
  'Dạ farm thành thật xin lỗi mình.',
  'Em dừng trả lời tự động tại đây.',
  'Nhân viên farm sẽ nghe và xử lý. Mình nhắn thêm nội dung cần hỗ trợ giúp em ạ.',
].join('\n');

function has(text, phrases) {
  return phrases.some(p => text.includes(p));
}

function aftersalesHits(folded) {
  const hits = [];
  if (has(folded, REFUND)) hits.push('hoàn tiền');
  if (has(folded, RETURN)) hits.push('trả hàng');
  if (has(folded, EXCHANGE)) hits.push('đổi hàng');
  return hits;
}

function isHot(folded) {
  if (!folded) return false;
  if (has(folded, HOT_PHRASES) || BUY_WORD.test(folded) || CHECKOUT_WORD.test(folded)) return true;
  if (QTY.test(folded) && (has(folded, PRICE) || QTY_VERB.test(folded))) return true;
  return false;
}

function parseLevel(value) {
  if (value == null || String(value).trim() === '') return null;
  const level = String(value).trim().toLowerCase();
  if (!LABEL[level]) {
    const err = new Error('triage_level không hợp lệ');
    err.status = 400;
    throw err;
  }
  return level;
}

function labelFor(level) {
  return LABEL[level] || null;
}

/**
 * True when a draft tells the customer a return, exchange, or refund
 * was already accepted.
 */
function hasApprovalLanguage(text) {
  const folded = ops.normalizeText(text);
  if (!folded) return false;
  return APPROVAL.some(p => folded.includes(p));
}

function customerReply(triaged) {
  const text = String(triaged && triaged.safeDraft || '').trim();
  if (!text || hasApprovalLanguage(text)) return SAFE_AFTERSALES;
  return text;
}

/**
 * @param {string} text raw customer message
 * @returns {{
 *   level:'hot'|'urgent'|'normal',
 *   label:string,
 *   kind:string,
 *   reason:string,
 *   skipModel:boolean,
 *   needsHuman:boolean,
 *   safeDraft:string|null,
 * }}
 */
function classify(text) {
  const folded = ops.normalizeText(text);
  const hits = aftersalesHits(folded);

  if (hits.length) {
    return {
      level: 'urgent',
      label: LABEL.urgent,
      kind: 'aftersales',
      reason: `Khách xin ${hits.join(', ')} — chưa duyệt, cần người thật xem`,
      skipModel: true,
      needsHuman: true,
      safeDraft: SAFE_AFTERSALES,
    };
  }

  if (has(folded, COMPLAINT)) {
    return {
      level: 'urgent',
      label: LABEL.urgent,
      kind: 'complaint',
      reason: 'Khách khiếu nại — cần người thật xem, chưa kết luận',
      skipModel: true,
      needsHuman: true,
      safeDraft: SAFE_COMPLAINT,
    };
  }

  if (drift.soundsAbusive(text) || has(folded, ANGER)) {
    return {
      level: 'urgent',
      label: LABEL.urgent,
      kind: 'anger',
      reason: 'Khách đang bức xúc — cần người thật xem',
      skipModel: true,
      needsHuman: true,
      safeDraft: SAFE_ANGER,
    };
  }

  if (ops.wantsHuman(text)) {
    return {
      level: 'urgent',
      label: LABEL.urgent,
      kind: 'human',
      reason: 'Khách muốn gặp người thật',
      skipModel: false,
      needsHuman: true,
      safeDraft: null,
    };
  }

  if (isHot(folded)) {
    return {
      level: 'hot',
      label: LABEL.hot,
      kind: 'buy',
      reason: 'Khách có ý mua, đặt, hoặc thanh toán',
      skipModel: false,
      needsHuman: false,
      safeDraft: null,
    };
  }

  return {
    level: 'normal',
    label: LABEL.normal,
    kind: 'faq',
    reason: 'Hỏi thông tin sản phẩm, giá, hoặc giao hàng',
    skipModel: false,
    needsHuman: false,
    safeDraft: null,
  };
}

module.exports = {
  LEVELS,
  LABEL,
  SAFE_AFTERSALES,
  SAFE_COMPLAINT,
  SAFE_ANGER,
  parseLevel,
  labelFor,
  hasApprovalLanguage,
  customerReply,
  classify,
};
