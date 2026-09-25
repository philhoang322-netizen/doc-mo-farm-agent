/**
 * Inbox folders, beside the channel groups.
 *
 * pending   Chờ xử lý  — nobody has acted
 * sent      Đã gửi      — Approve & Send succeeded
 * bought    Đã mua      — KiotViet document, or a manual Đã chốt for services
 * hesitant  Do dự       — manual, or 24h after Đã gửi with no order and no new message
 * declined  Từ chối     — manual only
 *
 * A new customer message opens a Chờ xử lý draft and tags the previous
 * folder. It does not change an older Đã mua draft, so the order stays linked.
 */
const ops = require('./ops');

const FOLDERS = ['pending', 'sent', 'bought', 'hesitant', 'declined'];
const FOLDER_SET = new Set(FOLDERS);
const FOLDER_LABEL = {
  pending: 'Chờ xử lý',
  sent: 'Đã gửi',
  bought: 'Đã mua',
  hesitant: 'Do dự',
  declined: 'Từ chối',
};

const DECLINE_PHRASES = [
  'khong mua',
  'khong dat',
  'khong lay',
  'khong can',
  'thoi khoi',
  'thoi nhe',
  'khong con nhu cau',
  'khong chot',
];

function hesitantHours() {
  const n = Number(process.env.INBOX_HESITANT_HOURS || 24);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(24 * 30, Math.max(1, n));
}

function hasKiot(d) {
  if (!d) return false;
  const form = d.review_form && typeof d.review_form === 'object' ? d.review_form : {};
  if (form.kiot_code) return true;
  return /^(HD|DH)/i.test(String(d.invoice_code || '').trim());
}

function storedFolder(d) {
  if (d && FOLDER_SET.has(d.inbox_status)) return d.inbox_status;
  return null;
}

/** Backfill when a row has never been filed. */
function inferFolder(d) {
  const stored = storedFolder(d);
  if (stored) return stored;
  if (hasKiot(d)) return 'bought';
  if (d && d.approval_status === 'SENT') return 'sent';
  return 'pending';
}

function suggestDecline(d) {
  if (!d || inferFolder(d) === 'declined') return false;
  const text = [d.customer_query, d.customer_intent].filter(Boolean).join(' ');
  const t = ops.normalizeText(text);
  if (!t) return false;
  return DECLINE_PHRASES.some(p => t.includes(p));
}

function threadKey(d) {
  return `${d.channel || ''}:${d.customer_user_id || d.id}`;
}

function stampOf(d) {
  return d.inbox_status_at || d.sent_at || d.updated_at || d.created_at || null;
}

/**
 * Latest non-deleted draft per thread that is still Đã gửi, with no Kiot
 * document anywhere on the thread, and no newer customer draft, after `hours`.
 * Returns the drafts that should move to Do dự. Does not mutate.
 */
function hesitantCandidates(rows, now = new Date(), hours = hesitantHours()) {
  const list = Array.isArray(rows) ? rows : [];
  const byThread = new Map();
  for (const d of list) {
    if (!d || d.deleted_at) continue;
    const key = threadKey(d);
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(d);
  }
  const cutoff = now.getTime() - hours * 3600 * 1000;
  const out = [];
  for (const drafts of byThread.values()) {
    if (drafts.some(hasKiot)) continue;
    drafts.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const latest = drafts[drafts.length - 1];
    if (inferFolder(latest) !== 'sent') continue;
    const at = new Date(stampOf(latest)).getTime();
    if (Number.isNaN(at) || at > cutoff) continue;
    out.push(latest);
  }
  return out;
}

module.exports = {
  FOLDERS,
  FOLDER_SET,
  FOLDER_LABEL,
  hesitantHours,
  hasKiot,
  inferFolder,
  suggestDecline,
  threadKey,
  hesitantCandidates,
};
