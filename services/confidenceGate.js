/**
 * Intent confidence gate.
 *
 * A fluent sales draft on a sticker, a broken photo, or a joke reads as if
 * the farm understood. Below AI_CONFIDENCE_MIN (default 0.6) the pipeline
 * must not keep that draft. It holds a short waiting line for staff
 * (PENDING_REVIEW, never auto-sent) and reuses the human handoff path.
 * It does not set bot_paused. Only an explicit ops.wantsHuman phrase does.
 *
 * AI_CONFIDENCE_MIN
 *   Unset → 0.6.
 *   "0.6" or "60%" or "60" → 0.6. Numbers greater than 1 are percent.
 *   "0" disables the gate (nothing is below zero).
 *   Anything else that is not a finite number falls back to 0.6.
 */
const ops = require('./ops');

const TICKET_STATUS = 'NEEDS_HUMAN';
const HUMAN_LABEL = 'Cần human hỗ trợ khẩn cấp';

/** Draft-only. Staff may send it; the pipeline must not. */
const WAITING_REPLY =
  'Dạ farm đã nhận tin của bạn. Nhân viên sẽ xem và hỗ trợ ngay, bạn chờ giúp mình một chút nha 🌿';

function minConfidence() {
  const raw = process.env.AI_CONFIDENCE_MIN;
  if (raw == null || String(raw).trim() === '') return 0.6;
  const parsed = parseScore(raw);
  return parsed == null ? 0.6 : parsed;
}

/**
 * Accept 0..1 or a percent (60, "60%"). Null when the value is not a score.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseScore(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/%$/, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  const score = n > 1 ? n / 100 : n;
  return Math.min(1, score);
}

function clamp(value) {
  return parseScore(value);
}

/** True only for a real score strictly below the configured threshold. */
function isLow(confidence) {
  const score = typeof confidence === 'number' ? confidence : parseScore(confidence);
  if (score == null) return false;
  return score < minConfidence();
}

function formatPercent(score) {
  const n = typeof score === 'number' ? score : parseScore(score);
  if (n == null) return '?';
  return `${Math.round(n * 100)}%`;
}

const JOKE = new Set([
  'haha', 'hahaha', 'hihi', 'hehe', 'keke', 'lol', 'lmao', 'joke',
  'ke chuyen cuoi', 'noi dua', 'noi dua thoi', 'dua thoi', 'troll',
]);

const KEY_WALKS = ['qwerty', 'asdfgh', 'zxcvbn', 'asdf', 'qwer', 'zxcv', 'hjkl'];

/**
 * Messages we must not send to the model. A normal product question returns
 * null so the agent's own confidence still decides.
 *
 * @param {string} text
 * @returns {{confidence:number, reason:string}|null}
 */
function edgeCase(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return { confidence: 0, reason: 'Tin nhắn trống — không có ý để trả lời' };
  }

  if (/^\[(sticker|image|audio|video|file|anh|hinh)\]$/i.test(trimmed)) {
    return {
      confidence: 0.1,
      reason: 'Tin không phải chữ (sticker, ảnh hoặc tệp) — không suy đoán',
    };
  }

  const norm = ops.normalizeText(trimmed);
  if (!norm) {
    return { confidence: 0.15, reason: 'Tin không có nội dung chữ — không suy đoán' };
  }

  if (isJoke(norm) || isNonsense(norm)) {
    return { confidence: 0.2, reason: 'Tin đùa hoặc vô nghĩa — không soạn câu bán hàng' };
  }
  return null;
}

function isJoke(norm) {
  if (JOKE.has(norm)) return true;
  if (/^(ha){2,}a?$/.test(norm)) return true;
  if (/^(hi){2,}i?$/.test(norm)) return true;
  if (/^(he){2,}e?$/.test(norm)) return true;
  return false;
}

function isNonsense(norm) {
  const compact = norm.replace(/\s/g, '');
  if (compact.length < 4) return false;
  if (KEY_WALKS.some(w => norm.includes(w))) return true;
  if (/(.)\1{5,}/.test(compact)) return true;
  const tokens = norm.split(' ').filter(Boolean);
  const vowels = /[aeiouy]/;
  if (tokens.length && tokens.every(t => t.length >= 5 && !vowels.test(t))) return true;
  return false;
}

module.exports = {
  TICKET_STATUS,
  HUMAN_LABEL,
  WAITING_REPLY,
  minConfidence,
  parseScore,
  clamp,
  isLow,
  formatPercent,
  edgeCase,
};
