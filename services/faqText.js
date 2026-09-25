/**
 * Reviewer notes stay off the customer message.
 * A trailing or inline "[Người duyệt]" block is removed before save and send.
 */
const BLOCK = /\[Người duyệt\][\s\S]*?(?=\n{2,}|\s*$)/gi;

function stripReviewerBlock(text) {
  let s = String(text ?? '').replace(/\0/g, '');
  s = s.replace(BLOCK, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function customerFacingReply(draftOrText) {
  const raw = draftOrText && typeof draftOrText === 'object'
    ? draftOrText.draft_reply
    : draftOrText;
  return stripReviewerBlock(raw);
}

module.exports = { stripReviewerBlock, customerFacingReply };
