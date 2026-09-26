/**
 * Single gate for every customer-channel send (Zalo OA, Zalo Bot, Facebook
 * Messenger).
 *
 * AUTO-SEND IS FORBIDDEN until the owner explicitly re-enables it in a
 * future PR. No environment variable can turn it back on. That includes
 * HITL_REQUIRE_APPROVAL, HITL_ACK_MESSAGE, AUTO_REPLY, AUTO_SEND, BOT_MODE,
 * FOLLOWUP_ENABLED, AI_CONFIDENCE_MIN, and any other flag. A message leaves
 * this process only when a person pressed Duyệt và gửi / "Gửi khách hàng"
 * on /admin for that exact draft. The token records the reviewer user id
 * and the timestamp.
 */
const ACTION_SEND = 'Gửi khách hàng';

class OutboundRefused extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'OutboundRefused';
    this.code = 'OUTBOUND_REFUSED';
  }
}

function logRefusal(reason, token) {
  const reviewer = token && token.reviewerUserId != null
    ? String(token.reviewerUserId).trim()
    : '';
  const draftId = token && token.draftId != null
    ? String(token.draftId).trim().slice(0, 40)
    : '';
  console.error('outbound_refused', JSON.stringify({
    reason,
    hasReviewer: Boolean(reviewer),
    hasDraft: Boolean(draftId),
  }));
}

function refuse(reason, token) {
  logRefusal(reason, token);
  throw new OutboundRefused(`Từ chối gửi khách: ${reason}`);
}

function parseTime(value) {
  if (value == null || String(value).trim() === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Mint a token. Only the human approve/send path may call this.
 * Requires a reviewer user id, a timestamp, and either an approved draft id
 * or the explicit action "Gửi khách hàng".
 */
function issue(input) {
  const src = input && typeof input === 'object' ? input : {};
  const reviewerUserId = src.reviewerUserId != null ? String(src.reviewerUserId).trim() : '';
  const reviewedAt = parseTime(src.reviewedAt) || new Date().toISOString();
  const draftId = src.draftId != null ? String(src.draftId).trim() : '';
  const action = src.action != null ? String(src.action).trim() : '';
  if (!reviewerUserId) refuse('missing_reviewer', src);
  if (!draftId && action !== ACTION_SEND) refuse('missing_draft', src);
  return {
    draftId: draftId || null,
    reviewerUserId: reviewerUserId.slice(0, 120),
    reviewedAt,
    action: action || ACTION_SEND,
  };
}

/** Throws OutboundRefused unless `token` is a real human approval. */
function assertApproval(token) {
  if (!token || typeof token !== 'object' || Array.isArray(token)) {
    refuse('missing_approval', token);
  }
  const reviewerUserId = token.reviewerUserId != null ? String(token.reviewerUserId).trim() : '';
  const reviewedAt = parseTime(token.reviewedAt);
  const draftId = token.draftId != null ? String(token.draftId).trim() : '';
  const action = token.action != null ? String(token.action).trim() : '';
  if (!reviewerUserId) refuse('missing_reviewer', token);
  if (!reviewedAt) refuse('bad_timestamp', token);
  if (!draftId && action !== ACTION_SEND) refuse('missing_draft', token);
  return {
    draftId: draftId || null,
    reviewerUserId: reviewerUserId.slice(0, 120),
    reviewedAt,
    action: action || ACTION_SEND,
  };
}

module.exports = {
  ACTION_SEND,
  OutboundRefused,
  issue,
  assertApproval,
};
