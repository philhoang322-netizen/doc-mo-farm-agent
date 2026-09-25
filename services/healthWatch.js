/**
 * Connection health for Messenger, Zalo OA, KiotViet, Graph, the model, and
 * the draft pipeline. Alert text is a fixed phrase — never a token, a raw
 * error body, or customer text. Zalo OA delivery can fail outside the
 * interaction window; Telegram is only used when both env vars are set.
 */
const pii = require('./pii');

const THROTTLE_MIN = clamp(Number(process.env.ALERT_THROTTLE_MIN) || 45, 30, 60);
const VERIFY_THRESHOLD = clamp(Number(process.env.ALERT_VERIFY_THRESHOLD) || 5, 1, 100);
const VERIFY_WINDOW_MIN = clamp(Number(process.env.ALERT_VERIFY_WINDOW_MIN) || 15, 1, 120);
const SILENCE_HOURS = clamp(Number(process.env.ALERT_SILENCE_HOURS) || 6, 1, 72);
const QUIET_START = 7;
const QUIET_END = 22;
const KIOT_BURST = 3;

const CODES = new Set(['verify', 'graph_verify', 'token', 'expiring', 'auth', 'upstream', 'timeout', 'exception', 'invalid']);
const STICKY = new Set(['zalo', 'kiotviet', 'graph', 'llm', 'pipeline']);

const LABEL = {
  messenger_verify: 'Messenger xác thực chữ ký',
  messenger_graph: 'Messenger đối chiếu Graph',
  silence_messenger: 'Messenger im lặng',
  silence_zalo: 'Zalo OA im lặng',
  zalo_token: 'Token Zalo OA',
  kiotviet: 'KiotViet',
  graph_token: 'Token Graph / Trang',
  llm: 'API mô hình',
  pipeline: 'Hàng chờ xử lý tin',
};

const TEXT = {
  messenger_verify: 'Messenger: xác thực chữ ký lỗi nhiều lần.',
  messenger_graph: 'Messenger: đối chiếu Graph lỗi nhiều lần.',
  silence_messenger: 'Messenger: không có tin mới trong giờ mở cửa.',
  silence_zalo: 'Zalo OA: không có tin mới trong giờ mở cửa.',
  zalo_token: 'Zalo OA: token hết hạn, sắp hết hạn, hoặc làm mới thất bại.',
  kiotviet: 'KiotViet: lỗi xác thực, hoặc lỗi máy chủ / timeout lặp lại.',
  graph_token: 'Graph: token Trang không dùng được.',
  llm: 'AI: lỗi khi gọi API mô hình.',
  pipeline: 'Hàng chờ: lỗi khi xử lý tin vào.',
};

const lastInbound = { messenger: null, zalo: null };
const lastOk = {};
const lastFailure = {};
const flags = {};
const events = [];
const open = {};
let timer = null;
let pokeTimer = null;

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function sanitize(text) {
  let out = String(text || '');
  out = out.replace(/bearer\s+[a-z0-9\-._~+/]+=*/gi, 'bearer [redacted]');
  out = out.replace(/(access_token|refresh_token|client_secret|password|api_key|authorization|bot)(["']?\s*[:=]\s*["']?)[^\s"',]+/gi, '$1$2[redacted]');
  out = out.replace(/bot\d{5,}:[A-Za-z0-9_-]{10,}/g, 'bot[redacted]');
  try {
    const masked = pii.mask(out);
    if (masked && typeof masked.text === 'string') out = masked.text;
  } catch (_) { /* masking must not block an alert */ }
  return out.slice(0, 400);
}

function noteFailure(name, code, at = Date.now()) {
  const safe = CODES.has(code) ? code : 'error';
  events.push({ name, code: safe, at });
  if (events.length > 200) events.shift();
  lastFailure[name] = { at, code: safe };
  if (STICKY.has(name)) flags[name] = { code: safe, at };
  poke();
}

function noteSuccess(name, at = Date.now()) {
  lastOk[name] = at;
  delete flags[name];
  poke();
}

function noteInbound(channel, at = Date.now()) {
  const key = channel === 'messenger' ? 'messenger'
    : (channel === 'oa' || channel === 'zalo' ? 'zalo' : null);
  if (!key) return;
  lastInbound[key] = at;
  poke();
}

function noteGraphResult(result) {
  if (!result) return;
  if (result.ok) {
    noteSuccess('graph');
    return;
  }
  const code = Number(result.errorCode);
  const status = Number(result.status);
  const tokenish = code === 190 || code === 102 || code === 463 || code === 467 || status === 401;
  if (tokenish || result.reason === 'missing_token') noteFailure('graph', 'invalid');
}

function count(name, code, now, windowMs) {
  const start = now - windowMs;
  return events.filter(ev => ev.name === name && ev.code === code && ev.at >= start && ev.at <= now).length;
}

function ictHour(now) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(now));
  return Number(hour);
}

function businessHours(now) {
  const hour = ictHour(now);
  return hour >= QUIET_START && hour < QUIET_END;
}

function silent(key, now) {
  if (!lastInbound[key]) return false;
  const tooQuiet = now - lastInbound[key] >= SILENCE_HOURS * 3600 * 1000;
  if (!tooQuiet) return false;
  if (businessHours(now)) return true;
  const alertKey = key === 'messenger' ? 'silence_messenger' : 'silence_zalo';
  return !!open[alertKey];
}

function activeKeys(now) {
  const windowMs = VERIFY_WINDOW_MIN * 60 * 1000;
  const keys = [];
  if (count('messenger', 'verify', now, windowMs) >= VERIFY_THRESHOLD) keys.push('messenger_verify');
  if (count('messenger', 'graph_verify', now, windowMs) >= VERIFY_THRESHOLD) keys.push('messenger_graph');
  if (silent('messenger', now)) keys.push('silence_messenger');
  if (silent('zalo', now)) keys.push('silence_zalo');
  if (flags.zalo) keys.push('zalo_token');
  const kiotBurst = count('kiotviet', 'upstream', now, windowMs) + count('kiotviet', 'timeout', now, windowMs);
  if ((flags.kiotviet && flags.kiotviet.code === 'auth') || kiotBurst >= KIOT_BURST) keys.push('kiotviet');
  if (flags.graph) keys.push('graph_token');
  if (flags.llm) keys.push('llm');
  if (flags.pipeline) keys.push('pipeline');
  return keys;
}

function tick(now = Date.now()) {
  const active = new Set(activeKeys(now));
  const throttleMs = THROTTLE_MIN * 60 * 1000;
  const changes = [];
  for (const key of active) {
    const row = open[key];
    if (!row) {
      open[key] = { since: now, lastSent: now };
      changes.push({ key, kind: 'fire', text: TEXT[key] });
    } else if (now - row.lastSent >= throttleMs) {
      row.lastSent = now;
      changes.push({ key, kind: 'fire', text: TEXT[key] });
    }
  }
  for (const key of Object.keys(open)) {
    if (!active.has(key)) {
      delete open[key];
      changes.push({ key, kind: 'recover', text: `Đã hồi phục: ${LABEL[key]}.` });
    }
  }
  return { changes, view: adminView(now) };
}

function integrationRow(name, label, now) {
  const fail = lastFailure[name] || null;
  const okAt = name === 'messenger' || name === 'zalo' ? lastInbound[name] : lastOk[name];
  let status = 'unknown';
  if (open[alertKeyFor(name)] || (name === 'messenger' && (open.messenger_verify || open.messenger_graph || open.silence_messenger))) {
    status = 'degraded';
  } else if (name === 'zalo' && (open.zalo_token || open.silence_zalo)) {
    status = 'degraded';
  } else if (okAt || fail) {
    status = flags[name] ? 'degraded' : 'ok';
  }
  return {
    name,
    label,
    status,
    lastSuccessAt: okAt ? new Date(okAt).toISOString() : null,
    lastFailureAt: fail ? new Date(fail.at).toISOString() : null,
    failureCode: fail && CODES.has(fail.code) ? fail.code : null,
  };
}

function alertKeyFor(name) {
  if (name === 'kiotviet') return 'kiotviet';
  if (name === 'graph') return 'graph_token';
  if (name === 'llm') return 'llm';
  if (name === 'pipeline') return 'pipeline';
  return null;
}

function rows(now) {
  return [
    integrationRow('messenger', 'Messenger', now),
    integrationRow('zalo', 'Zalo OA', now),
    integrationRow('kiotviet', 'KiotViet', now),
    integrationRow('graph', 'Graph', now),
    integrationRow('llm', 'AI', now),
    integrationRow('pipeline', 'Hàng chờ', now),
  ].map(row => {
    if (row.name === 'messenger' && (open.messenger_verify || open.messenger_graph || open.silence_messenger)) row.status = 'degraded';
    if (row.name === 'zalo' && (open.zalo_token || open.silence_zalo)) row.status = 'degraded';
    if (row.name === 'kiotviet' && open.kiotviet) row.status = 'degraded';
    if (row.name === 'graph' && open.graph_token) row.status = 'degraded';
    if (row.name === 'llm' && open.llm) row.status = 'degraded';
    if (row.name === 'pipeline' && open.pipeline) row.status = 'degraded';
    return row;
  });
}

function adminView(now = Date.now()) {
  const active = activeKeys(now);
  for (const key of active) {
    if (!open[key]) open[key] = { since: now, lastSent: 0 };
  }
  const list = rows(now);
  const alerts = active.map(key => ({
    key,
    text: TEXT[key] || LABEL[key],
    since: new Date((open[key] && open[key].since) || now).toISOString(),
  }));
  return {
    ok: alerts.length === 0,
    status: alerts.length ? 'degraded' : 'ok',
    checkedAt: new Date(now).toISOString(),
    integrations: list,
    alerts,
  };
}

function publicView(now = Date.now()) {
  const full = adminView(now);
  return {
    ok: full.ok,
    status: full.status,
    checkedAt: full.checkedAt,
    integrations: full.integrations.map(row => ({
      name: row.name,
      status: row.status,
      lastSuccessAt: row.lastSuccessAt,
      failureCode: row.status === 'degraded' ? row.failureCode : null,
    })),
  };
}

async function push(text) {
  const safe = sanitize(text);
  const delivered = { zalo: false, telegram: false };
  const zaloId = process.env.ALERT_ZALO_USER_ID;
  if (zaloId) {
    try {
      const zaloService = require('./zaloService');
      delivered.zalo = !!(await zaloService.sendTextMessage(zaloId, safe));
    } catch (_) {
      delivered.zalo = false;
    }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) {
    try {
      const axios = require('axios');
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chat,
        text: safe,
      }, { timeout: 10000 });
      delivered.telegram = true;
    } catch (_) {
      delivered.telegram = false;
    }
  }
  return { delivered, text: safe };
}

async function runCycle(now = Date.now()) {
  const result = tick(now);
  if (process.env.NODE_ENV === 'test') return result;
  for (const change of result.changes) {
    await push(change.text);
  }
  return result;
}

function poke() {
  if (process.env.NODE_ENV === 'test') return;
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => { runCycle().catch(() => {}); }, 2000);
  if (pokeTimer.unref) pokeTimer.unref();
}

function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => { runCycle().catch(() => {}); }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function resetForTests() {
  for (const key of Object.keys(lastInbound)) lastInbound[key] = null;
  for (const key of Object.keys(lastOk)) delete lastOk[key];
  for (const key of Object.keys(lastFailure)) delete lastFailure[key];
  for (const key of Object.keys(flags)) delete flags[key];
  for (const key of Object.keys(open)) delete open[key];
  events.length = 0;
}

module.exports = {
  noteFailure,
  noteSuccess,
  noteInbound,
  noteGraphResult,
  tick,
  adminView,
  publicView,
  push,
  sanitize,
  start,
  resetForTests,
  THROTTLE_MIN,
  VERIFY_THRESHOLD,
  SILENCE_HOURS,
};
