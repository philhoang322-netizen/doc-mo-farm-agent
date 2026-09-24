/**
 * Assign a conversation to whoever is on shift, then notify them.
 *
 * Extension point for later modules (including an unmerged confidence /
 * NEEDS_HUMAN flow). Call escalate() — or the existing notify.handoff(),
 * which funnels here — when any of these is true:
 *
 *   - ticket_status / ticketStatus contains "NEEDS_HUMAN"
 *   - needsHuman / needs_human is true
 *   - claim / claimed is true (approve flow marks the thread for a person)
 *   - wantsHuman is true (the customer asked for a human)
 *   - a request_human / step-aside handoff object is passed through
 *   - notify.handoff() is called (force), which is the pause/handoff hook
 *     already on main
 *
 * classifyHumanNeed() returns null for an ordinary sales draft. Those drafts
 * stay on the HITL queue and are not assigned and not auto-sent.
 *
 * Notification channel: Zalo Bot, the same path as services/notify.js
 * (zaloBotService.sendMessage). There is no Telegram sender in this repo.
 * The card goes to the assignee's notify_target when that is a bot chat id,
 * and always to ALERT_BOT_CHAT_ID when that owner chat is set and different.
 * A target of "owner" or blank uses only the owner chat.
 */
const crypto = require('crypto');
const db = require('./database');
const notify = require('./notify');
const roster = require('./roster');

const NEEDS_HUMAN = 'NEEDS_HUMAN';
const DEDUPE_MS = 2 * 60 * 1000;

const memory = [];
const recent = new Map();

const MODE_TEXT = {
  online: 'đang trong ca, ưu tiên vì online',
  on_shift: 'đang trong ca',
  next_shift: 'ca kế tiếp (hiện ngoài giờ)',
  owner: 'chủ farm — chưa có ca nào phủ giờ này',
};

function classifyHumanNeed(input = {}) {
  const ticket = String(input.ticketStatus || input.ticket_status || '');
  const urgency = input.urgency === 'high' ? 'high' : (input.urgency || 'normal');

  if (input.claim === true || input.claimed === true) {
    return {
      source: 'claim',
      urgency: 'high',
      label: NEEDS_HUMAN,
      reason: input.reason || 'Cuộc hội thoại được claim cho người trực',
    };
  }
  if (input.wantsHuman === true || input.source === 'wants_human') {
    return {
      source: 'wants_human',
      urgency: 'high',
      label: NEEDS_HUMAN,
      reason: input.reason || 'Khách yêu cầu gặp người thật',
    };
  }
  if (input.source === 'step_aside') {
    const u = urgency === 'normal' ? 'normal' : 'high';
    return {
      source: 'step_aside',
      urgency: u,
      label: u === 'high' ? NEEDS_HUMAN : 'HANDOFF',
      reason: input.reason || 'Cần người thật xử lý',
    };
  }
  if (input.needsHuman === true || input.needs_human === true || ticket.includes(NEEDS_HUMAN)) {
    return {
      source: 'needs_human',
      urgency: 'high',
      label: NEEDS_HUMAN,
      reason: input.reason || 'Cần human hỗ trợ khẩn cấp',
    };
  }
  if (input.route === 'needs-human') {
    return {
      source: 'needs_human',
      urgency: 'high',
      label: NEEDS_HUMAN,
      reason: input.reason || 'Cần người thật',
    };
  }
  if (input.handoff && typeof input.handoff === 'object') {
    const u = input.handoff.urgency === 'high' ? 'high' : 'normal';
    return {
      source: 'ai_handoff',
      urgency: u,
      label: u === 'high' ? NEEDS_HUMAN : 'HANDOFF',
      reason: input.handoff.reason || input.reason || 'AI chuyển cho người thật',
      externalId: input.handoff.externalId,
    };
  }
  if (input.force === true || input.source === 'handoff' || input.source === 'ai_handoff') {
    const u = urgency === 'high' ? 'high' : 'normal';
    return {
      source: input.source && input.source !== 'handoff' ? input.source : 'handoff',
      urgency: u,
      label: u === 'high' ? NEEDS_HUMAN : 'HANDOFF',
      reason: input.reason || 'Cần người thật',
    };
  }
  return null;
}

function customerIdOf(input) {
  const id = input.customer?.id || input.customerId || null;
  return roster.isUuid(id) ? String(id) : null;
}

async function pauseIfPossible(input, reason) {
  if (!db.DB_ENABLED) return;
  try {
    let id = customerIdOf(input);
    if (!id && input.externalId) {
      const found = await db.getCustomerByExternalId(input.externalId);
      id = found?.id || null;
    }
    if (id) await db.pauseBot(id, reason);
  } catch (e) {
    console.warn('handover pause failed:', e.message);
  }
}

function remember(rec) {
  if (!rec.external_id) return;
  recent.set(String(rec.external_id), rec);
}

function deduped(externalId) {
  if (!externalId) return null;
  const prev = recent.get(String(externalId));
  if (!prev || !prev.notified) return null;
  const at = new Date(prev.created_at).getTime();
  if (Number.isNaN(at) || Date.now() - at > DEDUPE_MS) return null;
  return prev;
}

async function saveRecord(rec) {
  await roster.ensureReady();
  if (!db.DB_ENABLED) {
    memory.unshift(rec);
    if (memory.length > 200) memory.pop();
    return rec;
  }
  await db.pool.query(
    `INSERT INTO staff_handoffs (
       id, created_at, external_id, customer_id, draft_id, reason, urgency, source,
       label, assignee_name, assignee_id, notify_target, mode, window_label,
       next_label, starts_in_minutes, last_message, notified
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
     )`,
    [
      rec.id, rec.created_at, rec.external_id, rec.customer_id, rec.draft_id,
      rec.reason, rec.urgency, rec.source, rec.label, rec.assignee_name,
      rec.assignee_id, rec.notify_target, rec.mode, rec.window_label,
      rec.next_label, rec.starts_in_minutes, rec.last_message, rec.notified,
    ]
  );
  return rec;
}

async function recentRows(limit = 20) {
  await roster.ensureReady();
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (!db.DB_ENABLED) return memory.slice(0, n);
  const r = await db.pool.query(
    `SELECT * FROM staff_handoffs ORDER BY created_at DESC LIMIT $1`,
    [n]
  );
  return r.rows.map(row => ({
    id: row.id,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    external_id: row.external_id,
    customer_id: row.customer_id,
    draft_id: row.draft_id,
    reason: row.reason,
    urgency: row.urgency,
    source: row.source,
    label: row.label,
    assignee_name: row.assignee_name,
    assignee_id: row.assignee_id,
    notify_target: row.notify_target,
    mode: row.mode,
    window_label: row.window_label,
    next_label: row.next_label,
    starts_in_minutes: row.starts_in_minutes,
    last_message: row.last_message,
    notified: row.notified === true,
  }));
}

/**
 * Pick an assignee and send the internal card.
 * Returns null when the input is not a human escalation.
 * Returns the existing record with deduped:true when this conversation was
 * already notified in the last two minutes (so a second hook does not page twice).
 */
async function escalate(input = {}, now = new Date()) {
  const kind = classifyHumanNeed(input);
  if (!kind) return null;

  const externalId = input.externalId || input.external_id || kind.externalId || null;
  const again = deduped(externalId);
  if (again) return { ...again, deduped: true };

  const picked = await roster.pick(now);
  const staff = picked.staff;
  const reason = input.reason || kind.reason;
  const rec = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    external_id: externalId ? String(externalId).slice(0, 120) : null,
    customer_id: customerIdOf(input),
    draft_id: roster.isUuid(input.draftId) ? String(input.draftId) : null,
    reason: reason ? String(reason).slice(0, 500) : null,
    urgency: kind.urgency,
    source: kind.source,
    label: kind.label,
    assignee_name: staff.name,
    assignee_id: roster.isUuid(staff.id) ? String(staff.id) : null,
    notify_target: staff.notify_target || null,
    mode: picked.mode,
    window_label: staff.window_label || null,
    next_label: picked.next_label || null,
    starts_in_minutes: picked.starts_in_minutes,
    last_message: input.lastMessage != null ? String(input.lastMessage).slice(0, 500) : null,
    notified: false,
    deduped: false,
  };

  await pauseIfPossible(
    { ...input, externalId },
    `${reason || kind.reason} → ${staff.name}`
  );

  const sent = await notify.handoff(
    {
      reason: rec.reason,
      urgency: rec.urgency,
      externalId: rec.external_id,
      assignee: rec,
      _fromRoster: true,
    },
    input.customer || null,
    input.lastMessage
  );
  rec.notified = !!sent;
  await saveRecord(rec);
  remember(rec);
  console.log(
    `👤 Handover ${rec.label} → ${rec.assignee_name} (${rec.mode}) ${rec.external_id || ''}`.trim()
  );
  return rec;
}

function resetForTests() {
  memory.length = 0;
  recent.clear();
}

module.exports = {
  NEEDS_HUMAN,
  MODE_TEXT,
  classifyHumanNeed,
  escalate,
  recent: recentRows,
  resetForTests,
};
