/**
 * Sale vs dịch vụ (DV) for the HITL inbox.
 *
 * Facebook only: products / ordering → sale, even if a room is also mentioned.
 * Only room, stay, or event talk → dv. Greetings and anything unclear → null
 * (the caller keeps the conversation's current group, or sale when it is new).
 * Zalo stays in the Zalo OA tab; this module does not auto-tag it.
 */
const ops = require('./ops');

const SALE_PHRASES = [
  'mua',
  'dat hang',
  'dat mua',
  'order',
  'gio hang',
  'giao hang',
  'phi ship',
  'ship',
  'van chuyen',
  'con hang',
  'het hang',
  'ton kho',
  'san pham',
  'nong san',
  'thit',
  'trung',
  'rau',
  'heo',
  'mat ong',
  'combo',
  'gia si',
  'xuat hang',
  'xuc xich',
  'hai san',
  'ga ta',
  'thit heo',
  'thit bo',
  'dau goi',
  'nuoc nghe',
];

const DV_PHRASES = [
  'phong',
  'dat phong',
  'homestay',
  'o lai',
  'ngu lai',
  'qua dem',
  'check in',
  'check out',
  'tham quan',
  'tour',
  'su kien',
  'tiec',
  'team building',
  'teambuilding',
  'cam trai',
  'workshop',
  'luu tru',
  'nha nghi',
  'nghi duong',
  'villa',
  'bungalow',
];

/** Staff review this. It is never auto-sent. */
const DV_CLARIFY =
  'Dạ farm đã nhận tin về phòng / ở lại / sự kiện ạ. ' +
  'Bạn cho farm xin giúp ngày đến, ngày đi, số người và loại hình ' +
  '(phòng, homestay, sự kiện hay team building) để nhân viên xem lịch và báo lại mình nhé 🌿';

function padded(text) {
  const t = ops.normalizeText(text);
  return t ? ` ${t} ` : '';
}

function hasPhrase(text, phrases) {
  const hay = padded(text);
  if (!hay) return false;
  return phrases.some(phrase => {
    const n = ops.normalizeText(phrase);
    return n && hay.includes(` ${n} `);
  });
}

/** @returns {'sale'|'dv'|null} null means the text is not clearly either */
function classify(text) {
  if (hasPhrase(text, SALE_PHRASES)) return 'sale';
  if (hasPhrase(text, DV_PHRASES)) return 'dv';
  return null;
}

/**
 * @param {object} input
 * @param {string} input.channel
 * @param {string} input.text
 * @param {{biz_line?: string, biz_sticky?: boolean}|null} [input.prior]
 */
function resolve({ channel, text, prior }) {
  const sticky = prior
    && prior.biz_sticky
    && (prior.biz_line === 'sale' || prior.biz_line === 'dv');
  if (channel !== 'messenger') {
    if (sticky) return { biz_line: prior.biz_line, biz_sticky: true };
    if (prior && (prior.biz_line === 'sale' || prior.biz_line === 'dv')) {
      return { biz_line: prior.biz_line, biz_sticky: false };
    }
    return { biz_line: null, biz_sticky: false };
  }
  if (sticky) return { biz_line: prior.biz_line, biz_sticky: true };
  const clear = classify(text);
  if (clear) return { biz_line: clear, biz_sticky: false };
  if (prior && (prior.biz_line === 'sale' || prior.biz_line === 'dv')) {
    return { biz_line: prior.biz_line, biz_sticky: false };
  }
  return { biz_line: 'sale', biz_sticky: false };
}

function knowledgeHasStayInfo() {
  let knowledge;
  try {
    knowledge = require('./knowledge');
  } catch {
    return false;
  }
  const blob = padded(typeof knowledge.fullText === 'function' ? knowledge.fullText() : '');
  if (!blob.trim()) return false;
  return DV_PHRASES.some(phrase => {
    const n = ops.normalizeText(phrase);
    return n && blob.includes(` ${n} `);
  });
}

module.exports = {
  SALE_PHRASES,
  DV_PHRASES,
  DV_CLARIFY,
  classify,
  resolve,
  knowledgeHasStayInfo,
};
