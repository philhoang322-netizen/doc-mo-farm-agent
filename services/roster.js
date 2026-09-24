/**
 * Staff shifts for human handover.
 *
 * A shift is a name, a notify target, and a weekday+hours window in
 * Asia/Ho_Chi_Minh. The window can also be written in one cron-like string:
 *   "1-5 08:00-17:00"    Mon–Fri, 08:00 inclusive until 17:00 exclusive
 *   "mon-fri 8-17"       same
 *   "* 09:00-21:00"      every day
 *   "6 22:00-06:00"      Saturday overnight into Sunday
 *
 * Weekdays: 0 or CN = Sunday … 6 or T7 = Saturday. Named tokens
 * (mon, tue, …) work too.
 *
 * Presence is the `online` flag on the shift (toggled from Omni Sale DMF).
 * There is no separate live-presence feed. pick() prefers someone who is
 * both on shift and online; if nobody on shift is online, any on-shift
 * person; if nobody is on shift, the next shift; if the roster is empty,
 * the farm owner.
 *
 * Storage: Postgres table staff_shifts when DATABASE_URL is set, otherwise
 * memory (tests, and a process with no database).
 */
const crypto = require('crypto');
const db = require('./database');

const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';
const VI_DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

const DAY_TOKEN = {
  sun: 0, cn: 0, 0: 0,
  mon: 1, t2: 1, 1: 1,
  tue: 2, t3: 2, 2: 2,
  wed: 3, t4: 3, 3: 3,
  thu: 4, t5: 4, 4: 4,
  fri: 5, t6: 5, 5: 5,
  sat: 6, t7: 6, 6: 6,
};

const memory = new Map();
let ready = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS staff_shifts (
    id            UUID PRIMARY KEY,
    name          TEXT NOT NULL,
    notify_target TEXT,
    weekdays      TEXT NOT NULL,
    start_min     INT NOT NULL,
    end_min       INT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    online        BOOLEAN NOT NULL DEFAULT FALSE,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS staff_handoffs (
    id              UUID PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    external_id     TEXT,
    customer_id     UUID,
    draft_id        UUID,
    reason          TEXT,
    urgency         TEXT,
    source          TEXT,
    label           TEXT,
    assignee_name   TEXT,
    assignee_id     UUID,
    notify_target   TEXT,
    mode            TEXT,
    window_label    TEXT,
    next_label      TEXT,
    starts_in_minutes INT,
    last_message    TEXT,
    notified        BOOLEAN NOT NULL DEFAULT FALSE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_staff_handoffs_created
    ON staff_handoffs (created_at DESC)`,
];

function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), 'vi');
}

function parseWeekdays(spec) {
  const raw = String(spec ?? '').trim().toLowerCase()
    .replace(/thứ/g, 't')
    .replace(/\s+/g, '');
  if (!raw || raw === '*' || raw === 'all') return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set();
  for (const part of raw.split(',')) {
    if (!part) continue;
    const range = part.split('-');
    if (range.length === 2 && DAY_TOKEN[range[0]] != null && DAY_TOKEN[range[1]] != null) {
      let a = DAY_TOKEN[range[0]];
      const b = DAY_TOKEN[range[1]];
      while (true) {
        days.add(a);
        if (a === b) break;
        a = (a + 1) % 7;
      }
    } else if (DAY_TOKEN[part] != null) {
      days.add(DAY_TOKEN[part]);
    } else {
      throw new Error(`Thứ không hợp lệ: ${part}`);
    }
  }
  if (!days.size) throw new Error('Chưa chọn ngày trong tuần');
  return [...days].sort((a, b) => a - b);
}

/** "08:00" / "8" / "24:00" → minutes. 24:00 is 1440 (end of day only). */
function parseClock(spec, label) {
  const m = String(spec ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`${label} không hợp lệ`);
  const h = Number(m[1]);
  const min = m[2] == null ? 0 : Number(m[2]);
  if (h === 24 && min === 0) return 1440;
  if (h > 23 || min > 59) throw new Error(`${label} không hợp lệ`);
  return h * 60 + min;
}

/**
 * @param {string} spec "1-5 08:00-17:00" or "mon-fri 8-17"
 * @returns {{weekdays:number[], start_min:number, end_min:number}}
 */
function parseWindow(spec) {
  const s = String(spec || '').trim().toLowerCase();
  const m = s.match(/^(.+?)\s+(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)$/);
  if (!m) throw new Error('Khung giờ dạng "1-5 08:00-17:00" hoặc "mon-fri 8-17"');
  const start_min = parseClock(m[2], 'Giờ bắt đầu');
  const end_min = parseClock(m[3], 'Giờ kết thúc');
  if (start_min === end_min) throw new Error('Giờ bắt đầu và kết thúc không được trùng');
  if (start_min >= 1440) throw new Error('Giờ bắt đầu không hợp lệ');
  return { weekdays: parseWeekdays(m[1]), start_min, end_min };
}

function formatMinutes(mins) {
  if (mins === 1440) return '24:00';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatWeekdays(days) {
  const set = [...new Set(days)].filter(d => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (set.length === 7) return 'Mỗi ngày';
  const ranges = [];
  let i = 0;
  while (i < set.length) {
    let j = i;
    while (j + 1 < set.length && set[j + 1] === set[j] + 1) j += 1;
    ranges.push(i === j ? VI_DAYS[set[i]] : `${VI_DAYS[set[i]]}–${VI_DAYS[set[j]]}`);
    i = j + 1;
  }
  return ranges.join(', ');
}

function formatWindow(weekdays, startMin, endMin) {
  return `${formatWeekdays(weekdays)} ${formatMinutes(startMin)}–${formatMinutes(endMin)}`;
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || DEFAULT_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { dow: dowMap[parts.weekday], minutes: hour * 60 + Number(parts.minute) };
}

function covers(shift, now) {
  if (!shift || shift.active === false) return false;
  const { dow, minutes } = zonedParts(now, shift.timezone || DEFAULT_TZ);
  const days = shift.weekdays || [];
  const start = shift.start_min;
  const end = shift.end_min;
  if (start == null || end == null || start === end) return false;
  if (start < end) return days.includes(dow) && minutes >= start && minutes < end;
  if (days.includes(dow) && minutes >= start) return true;
  const prev = (dow + 6) % 7;
  return days.includes(prev) && minutes < end;
}

function minutesUntilNextStart(shift, now) {
  const tz = shift.timezone || DEFAULT_TZ;
  const here = zonedParts(now, tz);
  const days = shift.weekdays || [];
  if (!days.length || shift.start_min == null) return null;
  let best = null;
  for (let add = 0; add < 8; add += 1) {
    const dow = (here.dow + add) % 7;
    if (!days.includes(dow)) continue;
    let delta;
    if (add === 0) {
      if (here.minutes < shift.start_min) delta = shift.start_min - here.minutes;
      else continue;
    } else {
      delta = add * 1440 - here.minutes + shift.start_min;
    }
    if (best == null || delta < best) best = delta;
  }
  return best;
}

function nextLabel(shift, now, delta) {
  if (delta == null) return null;
  const here = zonedParts(now, shift.timezone || DEFAULT_TZ);
  const total = here.minutes + delta;
  const addDays = Math.floor(total / 1440);
  const mins = total % 1440;
  const dow = (here.dow + addDays) % 7;
  return `${VI_DAYS[dow]} ${formatMinutes(mins)}`;
}

function ownerStaff() {
  return {
    id: null,
    name: process.env.OWNER_DISPLAY_NAME || 'Chủ farm',
    notify_target: null,
    window_label: null,
    timezone: DEFAULT_TZ,
    online: false,
    active: true,
    weekdays: [],
  };
}

/**
 * Choose who should receive a handover at `now`.
 * @returns {{staff:object, mode:'online'|'on_shift'|'next_shift'|'owner', starts_in_minutes:number|null, next_label:string|null}}
 */
function select(shifts, now = new Date()) {
  const active = (shifts || []).filter(s => s && s.active !== false);
  const on = active.filter(s => covers(s, now));
  if (on.length) {
    const online = on.filter(s => s.online);
    const pool = (online.length ? online : on).slice().sort(byName);
    return {
      staff: pool[0],
      mode: online.length ? 'online' : 'on_shift',
      starts_in_minutes: null,
      next_label: null,
    };
  }

  let best = null;
  for (const shift of active) {
    const delta = minutesUntilNextStart(shift, now);
    if (delta == null) continue;
    if (!best || delta < best.delta || (delta === best.delta && byName(shift, best.staff) < 0)) {
      best = { staff: shift, delta };
    }
  }
  if (best) {
    return {
      staff: best.staff,
      mode: 'next_shift',
      starts_in_minutes: best.delta,
      next_label: nextLabel(best.staff, now, best.delta),
    };
  }
  return { staff: ownerStaff(), mode: 'owner', starts_in_minutes: null, next_label: null };
}

function asBool(v, fallback) {
  if (v == null || v === '') return fallback;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return fallback;
}

function clip(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\0/g, '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
}

/** Build a shift from a window string or from weekdays + start + end. */
function normalizeInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Thiếu dữ liệu ca trực');
  const name = clip(input.name, 80);
  if (!name) throw new Error('Thiếu tên nhân viên');
  let parsed;
  if (input.window) parsed = parseWindow(input.window);
  else {
    parsed = {
      weekdays: parseWeekdays(input.weekdays),
      start_min: parseClock(input.start, 'Giờ bắt đầu'),
      end_min: parseClock(input.end, 'Giờ kết thúc'),
    };
    if (parsed.start_min === parsed.end_min) throw new Error('Giờ bắt đầu và kết thúc không được trùng');
    if (parsed.start_min >= 1440) throw new Error('Giờ bắt đầu không hợp lệ');
  }
  const timezone = clip(input.timezone, 64) || DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('Múi giờ không hợp lệ');
  }
  const id = isUuid(input.id) ? String(input.id) : crypto.randomUUID();
  return {
    id,
    name,
    notify_target: clip(input.notify_target, 120),
    weekdays: parsed.weekdays,
    weekdays_spec: parsed.weekdays.join(','),
    start_min: parsed.start_min,
    end_min: parsed.end_min,
    timezone,
    online: asBool(input.online, false),
    active: asBool(input.active, true),
    window_label: formatWindow(parsed.weekdays, parsed.start_min, parsed.end_min),
  };
}

function rowToShift(row) {
  const weekdays = String(row.weekdays || '')
    .split(',')
    .map(n => Number(n))
    .filter(n => n >= 0 && n <= 6);
  return {
    id: row.id,
    name: row.name,
    notify_target: row.notify_target || null,
    weekdays,
    weekdays_spec: weekdays.join(','),
    start_min: row.start_min,
    end_min: row.end_min,
    timezone: row.timezone || DEFAULT_TZ,
    online: row.online === true,
    active: row.active !== false,
    window_label: formatWindow(weekdays, row.start_min, row.end_min),
  };
}

async function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    if (!db.DB_ENABLED) return;
    for (const sql of SCHEMA) await db.pool.query(sql);
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

async function list() {
  await ensureReady();
  if (!db.DB_ENABLED) return [...memory.values()].sort(byName);
  const r = await db.pool.query('SELECT * FROM staff_shifts ORDER BY name');
  return r.rows.map(rowToShift);
}

async function upsert(input) {
  const shift = normalizeInput(input);
  await ensureReady();
  if (!db.DB_ENABLED) {
    memory.set(shift.id, shift);
    return shift;
  }
  const r = await db.pool.query(
    `INSERT INTO staff_shifts (
       id, name, notify_target, weekdays, start_min, end_min, timezone, online, active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       notify_target = EXCLUDED.notify_target,
       weekdays = EXCLUDED.weekdays,
       start_min = EXCLUDED.start_min,
       end_min = EXCLUDED.end_min,
       timezone = EXCLUDED.timezone,
       online = EXCLUDED.online,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING *`,
    [
      shift.id, shift.name, shift.notify_target, shift.weekdays_spec,
      shift.start_min, shift.end_min, shift.timezone, shift.online, shift.active,
    ]
  );
  return rowToShift(r.rows[0]);
}

async function remove(id) {
  if (!isUuid(id)) return false;
  await ensureReady();
  if (!db.DB_ENABLED) return memory.delete(String(id));
  const r = await db.pool.query('DELETE FROM staff_shifts WHERE id = $1', [id]);
  return r.rowCount > 0;
}

async function setOnline(id, online) {
  if (!isUuid(id)) throw new Error('Không thấy ca trực');
  await ensureReady();
  const on = asBool(online, false);
  if (!db.DB_ENABLED) {
    const shift = memory.get(String(id));
    if (!shift) throw new Error('Không thấy ca trực');
    shift.online = on;
    memory.set(shift.id, shift);
    return shift;
  }
  const r = await db.pool.query(
    `UPDATE staff_shifts SET online = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, on]
  );
  if (!r.rows[0]) throw new Error('Không thấy ca trực');
  return rowToShift(r.rows[0]);
}

async function pick(now = new Date()) {
  try {
    return select(await list(), now);
  } catch (e) {
    console.warn('roster pick failed:', e.message);
    return select([], now);
  }
}

function resetForTests() {
  memory.clear();
  ready = Promise.resolve();
}

module.exports = {
  DEFAULT_TZ,
  parseWindow,
  parseWeekdays,
  covers,
  select,
  formatWindow,
  formatMinutes,
  list,
  upsert,
  remove,
  setOnline,
  pick,
  ensureReady,
  isUuid,
  resetForTests,
};
