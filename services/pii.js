/**
 * Mask personally identifiable information before it leaves the server
 * in an LLM (or other third-party) payload.
 *
 * On-server records — the saved customer message, HITL draft intent, and
 * audit logs — stay intact. Only the copy handed to this module is masked.
 *
 * PII_MASKING_ENABLED defaults to on. Set false, 0, no, or off to disable.
 */
const FALSEY = /^(0|false|no|off)$/i;

const PLACEHOLDER = {
  PHONE: '[PHONE]',
  EMAIL: '[EMAIL]',
  CCCD: '[CCCD]',
  CMND: '[CMND]',
  BANK: '[BANK]',
  VIETQR: '[VIETQR]',
  ADDRESS: '[ADDRESS]',
  ID: '[ID]',
};

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const VIETQR_URL_RE = /https?:\/\/(?:[\w.-]+\.)?vietqr\.io\/\S+/gi;
const VIETQR_EMV_RE = /000201[0-9A-Za-z]{40,}/g;
const VIETQR_AID_RE = /[0-9A-Za-z]{8,}A000000727[0-9A-Za-z]{8,}/g;

// VN mobile: 0 / 84 / +84, then 3|5|7|8|9 and eight more digits.
// Separators (space, dot, hyphen, parentheses) may sit between digits.
const PHONE_RE = /(?<![\p{L}\p{N}])(?:\+84[\s.\-]*\(0\)[\s.\-]*|\+84[\s.\-]*|84[\s.\-]*|0[\s.\-]*)[35789](?:[\s.\-()]*\d){8}(?![\p{N}])/gu;

const DIGIT_RUN_RE = /(?<![\p{L}\p{N}])\d{8,19}(?![\p{N}])/gu;
const DIGIT_GROUP_RE = /(?<![\p{L}\p{N}])\d{2,4}(?:[ .]\d{2,4}){2,6}(?![\p{N}])/gu;

// House number + street word, plus optional ward/district clauses.
const STREET_RE = /(?<![\p{L}\p{N}])(?:(?:số|so)\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?\s+(?:đường|duong|phố|pho|hẻm|hem|ngõ|ngo|ngách|ngach)\s+[\p{L}\d][\p{L}\d.'/-]*(?:\s+[\p{L}\d][\p{L}\d.'/-]*){0,4}(?:\s*,\s*(?:phường|phuong|p\.|quận|quan|q\.|huyện|huyen|h\.|tp\.|thành phố|thanh pho|tỉnh|tinh|xã|xa|thị trấn)\s*[^,.\n;]{0,30}){0,4}/giu;

// "45 Nguyễn Huệ, Quận 1" — street name without the word đường, but a ward/district follows.
const HOUSE_AREA_RE = /(?<![\p{L}\p{N}])\d{1,4}(?:\s*\/\s*\d{1,4})?\s+[\p{L}][\p{L}.']*(?:\s+[\p{L}][\p{L}.']*){0,4}\s*,\s*(?:phường|phuong|p\.|quận|quan|q\.|huyện|huyen|h\.|tp\.|thành phố|thanh pho)\b[^,.\n;]{0,24}(?:\s*,\s*(?:phường|phuong|p\.|quận|quan|q\.|huyện|huyen|h\.|tp\.|thành phố|thanh pho|tỉnh|tinh)\b[^,.\n;]{0,24}){0,3}/giu;

function maskingEnabled() {
  const raw = process.env.PII_MASKING_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  return !FALSEY.test(String(raw).trim());
}

function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
  return PLACEHOLDER[key] || `[${key}]`;
}

function shield(text, saved) {
  const patterns = [
    /\bORD-\d{4}-\d{3,8}\b/gi,
    /\bHD0[0-9A-Z][0-9A-Z-]{1,40}\b/gi,
    /\bDMF-[A-Z0-9-]{2,24}\b/gi,
  ];
  let out = text;
  for (const re of patterns) {
    out = out.replace(re, (m) => {
      const token = `\u0000S${saved.length}\u0000`;
      saved.push(m);
      return token;
    });
  }
  return out;
}

function unshield(text, saved) {
  return text.replace(/\u0000S(\d+)\u0000/g, (_, i) => saved[Number(i)] ?? '');
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function isGroupedPrice(raw) {
  const t = String(raw || '').trim();
  if (!/^\d{1,3}(?:\.\d{3})+$/.test(t)) return false;
  return digitsOnly(t).length <= 9;
}

function cueKind(before) {
  const s = fold(before).slice(-80);
  const bankAt = Math.max(
    s.lastIndexOf('stk'),
    s.lastIndexOf('so tai khoan'),
    s.lastIndexOf('tai khoan'),
    s.lastIndexOf('ngan hang'),
    s.lastIndexOf('bank'),
    s.lastIndexOf('account'),
  );
  const idAt = Math.max(
    s.lastIndexOf('cccd'),
    s.lastIndexOf('cmnd'),
    s.lastIndexOf('can cuoc'),
    s.lastIndexOf('chung minh'),
    s.lastIndexOf('ho chieu'),
  );
  if (bankAt < 0 && idAt < 0) return null;
  if (bankAt > idAt) return 'bank';
  return 'id';
}

function classifyDigits(digits, before) {
  const kind = cueKind(before);
  const len = digits.length;
  if (/^0[35789]\d{8}$/.test(digits)) return 'PHONE';
  if (kind === 'bank') return 'BANK';
  if (kind === 'id') {
    if (len === 12) return 'CCCD';
    if (len === 9) return 'CMND';
    return 'ID';
  }
  if (len === 12) return 'CCCD';
  if (len === 9) return 'CMND';
  if (len >= 10 && len <= 19) return 'BANK';
  return null;
}

function replaceDigits(text, counts) {
  const apply = (re) => text.replace(re, (raw, offset) => {
    if (isGroupedPrice(raw)) return raw;
    const digits = digitsOnly(raw);
    if (digits.length < 8 || digits.length > 19) return raw;
    const label = classifyDigits(digits, text.slice(Math.max(0, offset - 80), offset));
    if (!label) return raw;
    return bump(counts, label);
  });
  text = apply(DIGIT_GROUP_RE);
  text = apply(DIGIT_RUN_RE);
  return text;
}

/**
 * @param {string} input
 * @returns {{text:string, counts:object, changed:boolean, enabled:boolean}}
 */
function mask(input) {
  const original = input == null ? '' : String(input);
  if (!maskingEnabled()) {
    return { text: original, counts: {}, changed: false, enabled: false };
  }

  const counts = {};
  const saved = [];
  let text = shield(original, saved);
  const swap = (re, key) => {
    text = text.replace(re, () => bump(counts, key));
  };

  swap(EMAIL_RE, 'EMAIL');
  swap(VIETQR_URL_RE, 'VIETQR');
  swap(VIETQR_EMV_RE, 'VIETQR');
  swap(VIETQR_AID_RE, 'VIETQR');
  swap(PHONE_RE, 'PHONE');
  text = replaceDigits(text, counts);
  const skipQty = (raw) => /^\d{1,3}\s+(?:chai|goi|gói|hop|hộp|kg|gram|túi|tui|thùng|thung|lốc|loc|bịch|bich|phần|phan)\b/iu.test(raw);
  const maskAddress = (re) => {
    text = text.replace(re, (raw) => (skipQty(raw) ? raw : bump(counts, 'ADDRESS')));
  };
  maskAddress(STREET_RE);
  maskAddress(HOUSE_AREA_RE);
  text = unshield(text, saved);

  return {
    text,
    counts,
    changed: text !== original,
    enabled: true,
  };
}

function maskText(input) {
  return mask(input).text;
}

/**
 * Walk a provider request body. Strings are masked; image/base64 blobs are not.
 */
function maskOutbound(value) {
  const counts = {};
  let changed = false;
  const enabled = maskingEnabled();

  function add(part) {
    for (const [k, n] of Object.entries(part || {})) {
      counts[k] = (counts[k] || 0) + n;
    }
  }

  function walk(v) {
    if (typeof v === 'string') {
      const r = mask(v);
      if (r.changed) changed = true;
      add(r.counts);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    if (v.type === 'image' || v.type === 'input_audio') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if ((k === 'data' || k === 'base64') && (v.type === 'base64' || v.media_type || v.source)) {
        out[k] = val;
        continue;
      }
      out[k] = walk(val);
    }
    return out;
  }

  return {
    value: enabled ? walk(value) : value,
    counts,
    changed: enabled ? changed : false,
    enabled,
  };
}

function mergeReports(reports) {
  const counts = {};
  let enabled = true;
  let seen = false;
  for (const r of reports || []) {
    if (!r) continue;
    seen = true;
    if (r.enabled === false) enabled = false;
    for (const [k, n] of Object.entries(r.counts || {})) {
      counts[k] = (counts[k] || 0) + n;
    }
  }
  if (!seen) return null;
  const changed = Object.values(counts).some(n => n > 0);
  return { counts, changed, enabled };
}

function describe(report) {
  if (!report) return null;
  if (report.enabled === false) return 'PII masking tắt (PII_MASKING_ENABLED).';
  const parts = Object.entries(report.counts || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}×${n}`);
  if (!parts.length) return 'Đã quét PII trước khi gửi model; không có mẫu cần che.';
  return `Đã che PII trên prompt gửi model: ${parts.join(', ')}.`;
}

module.exports = {
  PLACEHOLDER,
  maskingEnabled,
  mask,
  maskText,
  maskOutbound,
  mergeReports,
  describe,
};
