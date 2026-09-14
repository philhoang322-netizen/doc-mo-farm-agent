/**
 * Small operational helpers shared by both channels:
 *   - per-customer mutex, so two fast messages don't produce two
 *     interleaved answers built from the same stale history
 *   - durable event de-duplication, because Zalo retries a webhook
 *     whenever our reply is slow
 *   - business hours, used to tell customers when a human will answer
 */
const db = require('./database');

// ---------------- per-key mutex ----------------
const chains = new Map();

/**
 * Run `fn` exclusively for `key`. Calls with the same key queue up in arrival
 * order; different keys run in parallel.
 */
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  // Swallow the previous result/error so one failure doesn't poison the chain.
  const next = prev.then(() => fn(), () => fn());
  // Store a settle-only tail: the map must hold the same promise the cleanup
  // compares against, otherwise entries are never removed and the map grows
  // one entry per customer, forever.
  const tail = next.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

/** For health checks — a number that keeps climbing means the lock leaks. */
function activeLocks() {
  return chains.size;
}

// ---------------- de-duplication ----------------
const recent = new Set(); // in-process fast path

/**
 * True the first time we see this message id, false on every repeat.
 * Backed by the database so a restart (or a second replica) still de-dupes.
 */
async function isNewEvent(msgId, channel) {
  if (!msgId) return true;
  const key = `${channel}:${msgId}`;

  if (recent.has(key)) return false;
  recent.add(key);
  if (recent.size > 1000) recent.delete(recent.values().next().value);

  if (!db.DB_ENABLED) return true;
  try {
    const r = await db.pool.query(
      'INSERT INTO processed_events (msg_id, channel) VALUES ($1, $2) ON CONFLICT (msg_id) DO NOTHING',
      [key, channel]
    );
    return r.rowCount === 1;
  } catch (e) {
    // If the bookkeeping fails, prefer answering over staying silent.
    console.warn('dedup check failed:', e.message);
    return true;
  }
}

/** Keep processed_events from growing forever. */
async function pruneEvents(days = 3) {
  if (!db.DB_ENABLED) return 0;
  try {
    const r = await db.pool.query(
      `DELETE FROM processed_events WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(days)]
    );
    return r.rowCount;
  } catch (e) {
    return 0;
  }
}

// ---------------- business hours ----------------
/** WORK_HOURS="8-18" in Asia/Ho_Chi_Minh. Used only for human-handoff wording. */
function isWorkingHours(now = new Date()) {
  const spec = process.env.WORK_HOURS || '8-18';
  const [from, to] = spec.split('-').map(n => parseInt(n, 10));
  if (Number.isNaN(from) || Number.isNaN(to)) return true;
  const hh = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: process.env.TZ_NAME || 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      hour12: false,
    }).format(now)
  );
  return hh >= from && hh < to;
}

function workHoursText() {
  const spec = process.env.WORK_HOURS || '8-18';
  const [from, to] = spec.split('-');
  return `${from}h–${to}h hằng ngày`;
}

module.exports = { withLock, activeLocks, isNewEvent, pruneEvents, isWorkingHours, workHoursText };
