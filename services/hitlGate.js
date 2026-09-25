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
 * drafts.js only accepts channel "zalo" or "messenger". OA and Bot use
 * "zalo". Bot threads set customer_user_id to "bot_<chatId>" so
 * drafts.deliver() routes to zaloBotService; OA uses the Zalo user id and
 * routes to zaloService.sendTextMessage. Messenger sets channel "messenger"
 * and customer_user_id "fb_<psid>". Messenger replies are always held, even
 * when HITL_REQUIRE_APPROVAL is off, and no ack is sent on that channel.
 */
const drafts = require('./drafts');
const stations = require('./stations');
const triage = require('./triage');
const bizLine = require('./bizLine');
const customerLink = require('./customerLink');

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

function isMessenger(p) {
  return p && p.channel === 'messenger';
}

function draftChannel(p) {
  return isMessenger(p) ? 'messenger' : 'zalo';
}

function customerUserId(p) {
  if (p.channel === 'bot') {
    const key = String(p.externalKey || '');
    if (key.startsWith('bot_')) return clip(key, 120);
    const chatId = String(p.replyTo || key).replace(/^bot_/, '');
    return clip(`bot_${chatId}`, 120);
  }
  if (isMessenger(p)) {
    const key = String(p.externalKey || '');
    if (key.startsWith('fb_')) return clip(key, 120);
    const psid = String(p.replyTo || key).replace(/^fb_/, '');
    return clip(`fb_${psid}`, 120);
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
 * `extra.clearTriage` stores no Hot/Urgent/Normal level and does not treat the
 * turn as urgent. A paused follow-up uses this so the inbox card is the
 * customer text, not a new escalation.
 * `extra.forceHold` keeps PENDING_REVIEW even when auto-send is on.
 * `extra.handover === false` does not assign or re-pause.
 *
 * @param {object} p pipeline params (channel, replyTo, externalKey, send, text, senderName, log)
 * @param {string} text customer-facing body
 * @param {object} [extra]
 * @returns {Promise<{held:boolean, sent:boolean, draft:object|null, acked:boolean}>}
 */
async function releaseToCustomer(p, text, extra = {}) {
  const body = String(text ?? '').replace(/\0/g, '').trim();
  const source = extra.intent != null ? extra.intent : p.text;
  const triaged = extra.clearTriage === true
    ? clearedTriage()
    : coerceTriage(extra.triage, source);
  // Stock warnings, Messenger, and Urgent inbox rows wait for a person
  // even if the emergency auto-send switch is off. forceHold never calls
  // p.send with the customer body.
  const messengerHold = isMessenger(p);
  const urgentHold = triaged.level === 'urgent';
  const forceHold = extra.forceHold === true || messengerHold || urgentHold;

  if (!hitlRequired() && !forceHold) {
    if (!body) return { held: false, sent: false, draft: null, acked: false, assignment: null };
    const sent = !!(await p.send(p.replyTo, body));
    const assignment = await maybeHandover(p, null, { ...extra, triage: triaged });
    return { held: false, sent, draft: null, acked: false, assignment, triage: triaged.level };
  }

  if (!body) return { held: false, sent: false, draft: null, acked: false, assignment: null, triage: triaged.level };

  // Filter station. Runs for Zalo and Messenger. Does not send.
  const routeForce = extra.route || (urgentHold ? 'needs-human' : undefined);
  const routed = stations.filterAndRoute(source, routeForce);
  const ticketDefault = urgentHold
    ? 'NEEDS_HUMAN'
    : (routed.route === 'needs-human' ? 'Cần người thật' : 'Mới tiếp nhận');

  const channel = draftChannel(p);
  const userId = customerUserId(p);
  const prior = await drafts.conversationLine(channel, userId);
  const biz = bizLine.resolve({
    channel,
    text: String(source || ''),
    prior,
  });
  let outbound = body;
  if (
    extra.rewriteDv === true
    && channel === 'messenger'
    && biz.biz_line === 'dv'
    && !bizLine.knowledgeHasStayInfo()
  ) {
    outbound = bizLine.DV_CLARIFY;
  }

  const heardPhone = customerLink.phonesIn(`${p.text || ''}\n${source || ''}`)[0] || null;
  const draft = await drafts.createDraft({
    channel,
    customer_user_id: userId,
    customer_phone: heardPhone,
    customer_name: clip(extra.customer_name || p.senderName, 200),
    customer_intent: clip(routed.storedIntent, 1000),
    customer_query: clip(typeof p.text === 'string' ? p.text : source, 2000),
    draft_reply: clip(outbound, 8000),
    biz_line: biz.biz_line,
    biz_sticky: biz.biz_sticky,
    source_msg_id: clip(p.msgId, 200),
    assigned_department: clip(extra.assigned_department || routed.department, 120),
    ticket_status: clip(extra.ticket_status || ticketDefault, 120),
    qr_image_url: httpUrl(extra.qr_image_url),
    kiot_summary: clip(extra.kiot_summary, 4000),
    pii_note: clip(extra.pii_note, 300),
    triage_level: triaged.level,
    triage_label: triaged.label,
  });
  if (heardPhone) {
    try {
      await customerLink.note({
        phone: heardPhone,
        name: extra.customer_name || p.senderName,
        channel,
        userId,
      });
    } catch (err) {
      console.error('Customer link skipped:', err.message);
    }
  }

  let acked = false;
  // Messenger and Urgent stay silent until Approve & Send.
  const ack = messengerHold || urgentHold || extra.ack === false ? '' : ackMessage();
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
      route: routed.route,
      triage: triaged.level,
      ack: acked,
    });
  }
  console.log(
    `📝 HITL ${draft.approval_status} ${draft.id} route=${routed.route} triage=${triaged.level} (${p.channel} ${draft.customer_user_id || '?'}) — not sent`
  );

  const assignment = await maybeHandover(p, draft, {
    ...extra,
    route: routed.route,
    triage: triaged,
    ticket_status: draft.ticket_status,
    needsHuman: extra.needsHuman === true || urgentHold,
    urgency: extra.urgency || (urgentHold ? 'high' : undefined),
    reason: extra.reason || (urgentHold ? triaged.reason : undefined),
  });
  return { held: true, sent: false, draft, acked, assignment, route: routed.route, triage: triaged.level };
}

function clearedTriage() {
  return {
    level: null,
    label: null,
    kind: null,
    reason: null,
    skipModel: true,
    needsHuman: false,
    safeDraft: null,
  };
}

function coerceTriage(given, source) {
  const computed = triage.classify(source);
  if (!given || !given.level) return computed;
  let level;
  try {
    level = triage.parseLevel(given.level);
  } catch {
    return computed;
  }
  if (!level) return computed;
  return {
    ...computed,
    ...given,
    level,
    label: triage.labelFor(level),
  };
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
      route: extra.route,
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
