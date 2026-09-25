/**
 * What a grounded draft is allowed to do with the best FAQ match.
 * Local holding replies never quote unverified answers.
 */
const triage = require('./triage');
const retrieve = require('./faqRetrieve');

const CONFIDENCE_MIN = 0.45;

const HOLD = 'Dạ farm đã nhận câu hỏi của mình. Phần này cần người trực xác nhận trước, farm chưa nêu thông tin chưa chốt. Mình chờ farm một chút nhen.';
const CLARIFY = 'Dạ farm chưa khớp chắc câu này với phần đã duyệt. Mình nói rõ giúp farm mình đang muốn hỏi việc gì ạ?';
const HOURS = 'Dạ giờ mở cửa hôm nay farm cần người trực xác nhận, farm không trả theo lịch cũ trong tin này. Mình chờ farm một chút nhen.';
const COMPLAINT = 'Dạ farm xin lỗi mình. Farm đã chuyển người trực xem, chưa kết luận trong tin này.';

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isComplaint(query) {
  const text = fold(query);
  return /khieu nai|phan nan|nhan vien truc|khong online|khong tra loi|buc minh|te qua/.test(text);
}

function isHoursToday(query) {
  const text = fold(query);
  const hours = /gio mo cua|may gio mo|mo cua|dong cua|lich mo/;
  const today = /hom nay|bay gio|luc nay|dang mo/;
  return hours.test(text) && today.test(text);
}

function sensitiveReason(text) {
  const folded = fold(text);
  if (!folded) return null;
  if (/xet nghiem|ket qua xet|vietlabs|cfu|kim loai nang|chi so lab/.test(folded)) {
    return 'kết quả xét nghiệm cần người xác nhận';
  }
  if (/di ung|mang thai|co bau/.test(folded)) {
    return 'dị ứng hoặc mang thai cần người xác nhận';
  }
  if (/thanh toan|chuyen khoan|hoan tien|doi tra|tra hang|doi hang/.test(folded)) {
    return 'thanh toán hoặc đổi trả cần người xử lý';
  }
  return null;
}

function isOrderTaking(query, item) {
  const q = fold(query);
  if (/dat hang|dat don|chot don|chot hang|muon mua|muon dat/.test(q)) return true;
  if (/(?:lay|mua|dat)\s+\d+/.test(q)) return true;
  if (!item) return false;
  const answer = fold(`${item.answer || ''} ${item.conditions || ''}`);
  return /so dien thoai/.test(answer) && /dia chi|dat hang|chot don/.test(answer);
}

function itemBlob(item) {
  if (!item) return '';
  return [item.group, item.product, item.question, item.answer, item.conditions].join(' ');
}

function triageFor(query, handoff, reason) {
  const base = triage.classify(query);
  if (!handoff) return { ...base };
  const level = base.level === 'hot' ? 'hot' : 'urgent';
  return {
    ...base,
    level,
    label: triage.labelFor(level),
    needsHuman: true,
    skipModel: true,
    reason: reason || base.reason,
  };
}

function handoff(query, codes, confidenceValue, reason, text) {
  return {
    mode: 'handoff',
    handoff: true,
    reason,
    text,
    codes,
    confidence: confidenceValue,
    triage: triageFor(query, true, reason),
  };
}

/**
 * @param {string} query
 * @param {{ item: object, score: number, cover?: number }[]} hits
 */
function decide(query, hits) {
  const best = hits[0] || null;
  const second = hits[1] || null;
  const confidenceValue = retrieve.confidence(best, second);
  const codes = hits.slice(0, 5).map(hit => hit.item.code);

  if (isComplaint(query)) {
    return handoff(query, codes, confidenceValue, 'khách khiếu nại, cần người trực', COMPLAINT);
  }
  if (isHoursToday(query)) {
    return handoff(query, codes, confidenceValue, 'giờ mở cửa hôm nay cần người xác nhận', HOURS);
  }
  const asked = sensitiveReason(query);
  if (asked) return handoff(query, codes, confidenceValue, asked, HOLD);
  if (!best || confidenceValue < CONFIDENCE_MIN) {
    return handoff(query, codes, confidenceValue, 'không khớp chắc FAQ đã duyệt', CLARIFY);
  }

  const item = best.item;
  if (item.action_flag === 'CHUA_BAT') {
    return handoff(query, codes, confidenceValue, 'mục FAQ chưa bật', HOLD);
  }
  if (item.verify_status !== 'verified') {
    return handoff(query, codes, confidenceValue, 'FAQ chưa được xác minh', HOLD);
  }
  if (item.action_flag === 'CHUYEN_NGUOI') {
    return handoff(query, codes, confidenceValue, 'FAQ yêu cầu chuyển người', HOLD);
  }
  const topic = sensitiveReason(itemBlob(item));
  if (topic) return handoff(query, codes, confidenceValue, topic, HOLD);
  if (isOrderTaking(query, item)) {
    return handoff(query, codes, confidenceValue, 'câu đặt hàng chuyển người', HOLD);
  }
  if (item.action_flag === 'LIVE') {
    return {
      mode: 'live',
      handoff: false,
      reason: 'tra cứu live',
      item,
      hits,
      codes,
      confidence: confidenceValue,
      triage: triageFor(query, false),
    };
  }
  if (item.action_flag === 'TU_DONG') {
    return {
      mode: 'claude',
      handoff: false,
      reason: 'khớp FAQ đã duyệt',
      item,
      hits,
      codes,
      confidence: confidenceValue,
      triage: triageFor(query, false),
    };
  }
  return handoff(query, codes, confidenceValue, 'cờ FAQ không cho trả tự động', HOLD);
}

function reviewer(decision) {
  return {
    codes: decision.codes || [],
    confidence: decision.confidence == null ? null : decision.confidence,
    handoff: decision.handoff === true,
    reason: decision.reason || '',
  };
}

module.exports = {
  CONFIDENCE_MIN,
  HOLD,
  CLARIFY,
  HOURS,
  COMPLAINT,
  decide,
  reviewer,
  triageFor,
  isComplaint,
  isHoursToday,
  isOrderTaking,
  sensitiveReason,
  fold,
};
