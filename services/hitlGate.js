/**
 * OmniSales HITL gate for customer-facing Zalo text.
 *
 * HITL_REQUIRE_APPROVAL
 *   Default when unset or blank: true (safe for this farm).
 *   true  — do not send the reply. createDraft() with approval_status
 *           PENDING_REVIEW. A person sends it from /admin.
 *   false, 0, no, off — emergency auto-send (today's p.send behavior).
 *
 * HITL_ACK_MESSAGE
 *   Optional. Only if this is a non-empty string, that exact text is sent
 *   while the draft waits. Unset or blank sends nothing. No default ack.
 *
 * drafts.js only accepts channel "zalo" or "messenger". Both OA and Bot
 * use "zalo". Bot threads set customer_user_id to "bot_<chatId>" so
 * drafts.deliver() still routes to zaloBotService; OA uses the Zalo user id
 * and still routes to zaloService.sendTextMessage. deliver() is unchanged.
 */
const drafts = require('./drafts');

const FALSEY = /^(0|false|no|off)$/i;

function hitlRequired() {
  const raw = process.env.HITL_REQUIRE_APPROVAL;
  if (raw == null || String(raw).trim() === '') return true;
  return !FALSEY.test(String(raw).trim());
}

function ackMessage() {
  const raw = process.env.HITL_ACK_MESSAGE;
  if (raw == null) return '';
  return String(raw).trim();
}

function clip(value, max) {
  if (value == null) return null;
  const s = String(value).replace(/\0/g, '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function customerUserId(p) {
  if (p.channel === 'bot') {
    const key = String(p.externalKey || '');
    if (key.startsWith('bot_')) return clip(key, 120);
    const chatId = String(p.replyTo || key).replace(/^bot_/, '');
    return clip(`bot_${chatId}`, 120);
  }
  return clip(p.replyTo || p.externalKey, 120);
}

function httpUrl(value) {
  if (value == null || String(value).trim() === '') return null;
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href.length > 1000 ? null : u.href;
  } catch {
    return null;
  }
}

/**
 * Send `text` to the customer, or hold it for review.
 * Never calls p.send with `text` while approval is required.
 * `extra.ack === false` skips HITL_ACK_MESSAGE (follow-up drafts in the same turn).
 *
 * @param {object} p pipeline params (channel, replyTo, externalKey, send, text, senderName, log)
 * @param {string} text customer-facing body
 * @param {object} [extra]
 * @returns {Promise<{held:boolean, sent:boolean, draft:object|null, acked:boolean}>}
 */
async function releaseToCustomer(p, text, extra = {}) {
  const body = String(text ?? '').replace(/\0/g, '').trim();
  // Stock warnings must wait for a person even if the emergency auto-send
  // switch is off. forceHold never calls p.send with the customer body.
  const forceHold = extra.forceHold === true;

  if (!hitlRequired() && !forceHold) {
    if (!body) return { held: false, sent: false, draft: null, acked: false, assignment: null };
    const sent = !!(await p.send(p.replyTo, body));
    const assignment = await maybeHandover(p, null, extra);
    return { held: false, sent, draft: null, acked: false, assignment };
  }

  if (!body) return { held: false, sent: false, draft: null, acked: false, assignment: null };

  const draft = await drafts.createDraft({
    channel: 'zalo',
    customer_user_id: customerUserId(p),
    customer_name: clip(extra.customer_name || p.senderName, 200),
    customer_intent: clip(extra.intent != null ? extra.intent : p.text, 1000),
    draft_reply: clip(body, 8000),
    assigned_department: clip(extra.assigned_department || 'Sales', 120),
    ticket_status: clip(extra.ticket_status || 'Mới tiếp nhận', 120),
    qr_image_url: httpUrl(extra.qr_image_url),
    kiot_summary: clip(extra.kiot_summary, 4000),
  });

  let acked = false;
  const ack = extra.ack === false ? '' : ackMessage();
  if (ack) {
    try {
      acked = !!(await p.send(p.replyTo, ack));
    } catch (e) {
      console.error('HITL ack failed:', e.message);
    }
  }

  if (typeof p.log === 'function') {
    p.log({
      type: 'draft_held',
      channel: p.channel,
      to: p.replyTo,
      draft_id: draft.id,
      approval_status: draft.approval_status,
      ack: acked,
    });
  }
  console.log(
    `📝 HITL ${draft.approval_status} ${draft.id} (${p.channel} ${draft.customer_user_id || '?'}) — not sent`
  );

  const assignment = await maybeHandover(p, draft, extra);
  return { held: true, sent: false, draft, acked, assignment };
}

/**
 * Ordinary sales drafts return null and are not reassigned.
 * NEEDS_HUMAN, claim, and an explicit human request assign someone on shift.
 * extra.handover === false skips this (tests, or a caller that escalates itself).
 */
async function maybeHandover(p, draft, extra) {
  if (extra.handover === false) return null;
  try {
    const handover = require('./handover');
    const kind = handover.classifyHumanNeed({
      ticketStatus: extra.ticket_status || extra.ticketStatus || draft?.ticket_status,
      needsHuman: extra.needsHuman,
      needs_human: extra.needs_human,
      claim: extra.claim,
      wantsHuman: extra.wantsHuman,
      source: extra.source,
      urgency: extra.urgency,
      reason: extra.reason,
    });
    if (!kind) return null;
    return handover.escalate({
      ...kind,
      reason: extra.reason || kind.reason,
      urgency: extra.urgency || kind.urgency,
      externalId: p.externalKey || draft?.customer_user_id || null,
      customer: extra.customer || {
        display_name: draft?.customer_name || p.senderName || null,
        phone: draft?.customer_phone || null,
      },
      lastMessage: p.text,
      draftId: draft?.id || null,
      ticketStatus: draft?.ticket_status || extra.ticket_status || kind.label,
    });
  } catch (e) {
    console.error('Handover from HITL release failed:', e.message);
    return null;
  }
}

module.exports = { hitlRequired, ackMessage, releaseToCustomer };
