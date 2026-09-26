/**
 * OmniSales HITL gate for customer-facing text.
 *
 * AUTO-SEND IS FORBIDDEN until the owner explicitly re-enables it in a
 * future PR. HITL_REQUIRE_APPROVAL, HITL_ACK_MESSAGE, AUTO_REPLY, AUTO_SEND,
 * and BOT_MODE cannot turn delivery back on. Every reply is a
 * PENDING_REVIEW draft. A person sends it from /admin (Duyệt và gửi /
 * "Gửi khách hàng"). This function never calls p.send.
 *
 * drafts.js only accepts channel "zalo" or "messenger". OA and Bot use
 * "zalo". Bot threads set customer_user_id to "bot_<chatId>" so
 * drafts.deliver() routes to zaloBotService; OA uses the Zalo user id and
 * routes to zaloService.sendTextMessage. Messenger sets channel "messenger"
 * and customer_user_id "fb_<psid>".
 */
const drafts = require('./drafts');
const stations = require('./stations');
const triage = require('./triage');
const bizLine = require('./bizLine');
const threadLabels = require('./threadLabels');
const customerLink = require('./customerLink');

function hitlRequired() {
  // AUTO-SEND IS FORBIDDEN. HITL_REQUIRE_APPROVAL is ignored on purpose.
  void process.env.HITL_REQUIRE_APPROVAL;
  return true;
}

function ackMessage() {
  // HITL_ACK_MESSAGE must not send a customer ack. Auto-send is forbidden.
  void process.env.HITL_ACK_MESSAGE;
  return '';
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
 * Hold `text` for review. Never calls p.send.
 * AUTO-SEND IS FORBIDDEN until the owner re-enables it in a future PR.
 * `extra.ack` is ignored: no acknowledgement is sent while a draft waits.
 * `extra.clearTriage` stores no Hot/Urgent/Normal level and does not treat the
 * turn as urgent. A paused follow-up uses this so the inbox card is the
 * customer text, not a new escalation.
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
  // Every channel waits for a person. There is no auto-send branch.
  const urgentHold = triaged.level === 'urgent';

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
  const biz = await threadLabels.resolveTurn({
    channel,
    userId,
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
    source_received_at: p.receivedAt || null,
    assigned_department: clip(extra.assigned_department || routed.department, 120),
    ticket_status: clip(extra.ticket_status || ticketDefault, 120),
    qr_image_url: httpUrl(extra.qr_image_url),
    kiot_summary: clip(extra.kiot_summary, 4000),
    pii_note: clip(extra.pii_note, 300),
    triage_level: triaged.level,
    triage_label: triaged.label,
    faq_review: extra.faq_review || null,
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

  // No ack. HITL_ACK_MESSAGE cannot send. Auto-send is forbidden.
  const acked = false;

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
