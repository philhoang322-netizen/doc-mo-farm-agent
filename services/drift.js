/**
 * Knowing when to stop.
 *
 * A language model rarely says "I'm lost" — it keeps answering fluently while
 * drifting off the facts, which is worse for a customer than an honest hand
 * over. So the decision is made here, from observable signals, not by asking
 * the model to judge itself.
 *
 * Five signals, any one of which is enough:
 *   1. The thread has run long — memory thins and answers start to wander.
 *   2. The customer sounds frustrated or says the bot got it wrong.
 *   3. The customer keeps asking the same thing, so the answers aren't landing.
 *   4. The bot keeps giving the same answer, which means it is stuck.
 *   5. The bot has repeatedly found nothing in the farm's own documents,
 *      meaning it is improvising on subjects it was told not to improvise on.
 */

const MAX_MESSAGES = Number(process.env.DRIFT_MAX_MESSAGES || 40);
const REPEAT_LIMIT = Number(process.env.DRIFT_REPEAT_LIMIT || 3);
const UNKNOWN_LIMIT = Number(process.env.DRIFT_UNKNOWN_LIMIT || 2);
const WINDOW = 6;

// Per-conversation counters. Small and self-trimming; a restart just resets
// them, which is harmless — the handoff is a safety net, not bookkeeping.
const tracks = new Map();

function track(key) {
  if (!tracks.has(key)) {
    tracks.set(key, { questions: [], answers: [], unknown: 0, handedOff: false });
    if (tracks.size > 500) tracks.delete(tracks.keys().next().value);
  }
  return tracks.get(key);
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Rough overlap of two short texts, 0..1. Good enough to spot a repeat. */
function similar(a, b) {
  const A = new Set(norm(a).split(' ').filter(w => w.length > 2));
  const B = new Set(norm(b).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}

const FRUSTRATION = [
  'khong hieu', 'ko hieu', 'k hieu', 'chang hieu',
  'sai roi', 'tra loi sai', 'khong dung', 'ko dung', 'noi lung tung',
  'lung tung', 'linh tinh', 'vo duyen', 'noi gi vay', 'gi vay troi',
  'da noi roi', 'noi roi ma', 'hoi may lan roi', 'hoi hoai',
  'lap di lap lai', 'nhu cai may', 'chan qua', 'buc minh',
  'tra loi kieu gi', 'co hieu khong', 'doc ky di', 'doc lai di',
];

/**
 * Swearing or abuse. A bot answering cheerfully through this makes it worse;
 * a person should take over immediately.
 *
 * Chosen conservatively: only terms that are unambiguous once accents are
 * stripped. Bare "ngu" is excluded because "ngũ cốc" normalises to "ngu coc",
 * and bare "cho" is excluded because it is the ordinary word for "give".
 */
// "cc" and "cl" are deliberately absent: they collide with ordinary words and
// abbreviations ("cc sản phẩm này tốt chứ"), and wrongly cutting off a polite
// customer is a worse failure than missing one mild swear.
const PROFANITY = [
  'dm', 'dmm', 'dcm', 'dkm', 'clm', 'cmm', 'cmn', 'vcl', 'vl',
  'dit me', 'dit con', 'deo', 'do cho', 'oc cho', 'do ngu', 'qua ngu', 'ngu vcl',
  'khon nan', 'mat day', 'do khon', 'do dien', 'do bip', 'do lua dao',
  'lua dao', 'bip bom', 'lam an lao', 'lao toet', 'do rac', 'rac ruoi',
  'cut di', 'im di', 'cam mom', 'cam mieng', 'do vo dung',
  'thang ngu', 'con ngu', 'bo may', 'me may',
];

function soundsAbusive(text) {
  const t = norm(text);
  if (!t) return false;
  return PROFANITY.some(p => new RegExp(`(^|\\s)${p}(\\s|$)`).test(t));
}

function soundsFrustrated(text) {
  // Checked on the raw text first: normalising strips punctuation, so "???"
  // would otherwise become an empty string and slip through.
  if (/^[?!\s]{3,}$/.test(String(text || '').trim())) return true;

  const t = norm(text);
  if (!t) return false;
  return FRUSTRATION.some(p => t.includes(p));
}

/** Call once per customer message, before the reply is composed. */
function noteQuestion(key, text) {
  const t = track(key);
  t.questions.push(text);
  if (t.questions.length > WINDOW) t.questions.shift();
}

/** Call once per bot reply. */
function noteAnswer(key, text) {
  const t = track(key);
  t.answers.push(text);
  if (t.answers.length > WINDOW) t.answers.shift();
}

/** Call when search_knowledge finds nothing. */
function noteUnknown(key) {
  track(key).unknown += 1;
}

function countRepeats(list) {
  if (list.length < 2) return 0;
  const last = list[list.length - 1];
  let n = 1;
  for (let i = list.length - 2; i >= 0; i--) {
    if (similar(last, list[i]) >= 0.65) n++;
    else break;
  }
  return n;
}

/**
 * Should the bot step aside?
 * @returns {{handoff:boolean, reason?:string, signal?:string}}
 */
function assess(key, { messageCount = 0, lastUserText = '' } = {}) {
  const t = track(key);
  if (t.handedOff) return { handoff: false };

  // Checked first: an angry customer must not get another automated reply.
  if (soundsAbusive(lastUserText)) {
    return { handoff: true, signal: 'anger', urgency: 'high',
      reason: 'Khách đang bực và có lời lẽ nặng — cần người thật xử lý ngay' };
  }
  if (soundsFrustrated(lastUserText)) {
    return { handoff: true, signal: 'frustration',
      reason: 'Khách tỏ ra không hài lòng với câu trả lời của bot' };
  }
  if (countRepeats(t.questions) >= REPEAT_LIMIT) {
    return { handoff: true, signal: 'repeat_question',
      reason: `Khách hỏi lại cùng một ý ${REPEAT_LIMIT} lần — bot chưa trả lời trúng` };
  }
  if (countRepeats(t.answers) >= REPEAT_LIMIT) {
    return { handoff: true, signal: 'repeat_answer',
      reason: 'Bot lặp lại cùng một câu trả lời — có thể đang bí' };
  }
  if (t.unknown >= UNKNOWN_LIMIT) {
    return { handoff: true, signal: 'out_of_knowledge',
      reason: `Bot tra tài liệu farm ${t.unknown} lần không thấy — đang nói ngoài hiểu biết` };
  }
  if (messageCount >= MAX_MESSAGES) {
    return { handoff: true, signal: 'long_thread',
      reason: `Hội thoại đã dài (${messageCount} tin) — nguy cơ bot trả lời lệch` };
  }
  return { handoff: false };
}

/** What the customer reads. Asking, not announcing — this is their call. */
function message(signal) {
  // An angry customer gets an apology and a person — no explanations,
  // no defending the bot, nothing that reads as talking back.
  if (signal === 'anger') {
    return `Dạ farm thành thật xin lỗi mình.

Farm chuyển ngay qua nhân viên để nghe và xử lý cho mình, em dừng ở đây ạ.

Mình cứ nhắn nội dung cần hỗ trợ, người của farm sẽ trả lời sớm nhất có thể 🌿`;
  }

  const opening = {
    frustration: 'Dạ farm xin lỗi, có vẻ em trả lời chưa trúng ý.',
    repeat_question: 'Dạ farm thấy mình hỏi lại mấy lần, chắc em chưa trả lời tới nơi.',
    repeat_answer: 'Dạ em thấy mình cứ nói đi nói lại một ý.',
    out_of_knowledge: 'Dạ câu này vượt quá những gì em nắm chắc.',
    long_thread: 'Dạ mình trao đổi cũng đã khá dài rồi.',
  }[signal] || 'Dạ câu này em chưa đủ chắc.';

  return `${opening}

Cho farm chuyển qua nhân viên để trả lời mình chu đáo hơn nha. Em dừng ở đây, người của farm sẽ tiếp chuyện mình ngay.

Mình cứ nhắn tiếp nội dung cần hỗ trợ, farm đọc hết và trả lời sớm nhất ạ 🌿`;
}

function markHandedOff(key) {
  track(key).handedOff = true;
}

function reset(key) {
  tracks.delete(key);
}

module.exports = {
  noteQuestion, noteAnswer, noteUnknown, assess, message,
  markHandedOff, reset, soundsFrustrated, soundsAbusive, similar,
};
