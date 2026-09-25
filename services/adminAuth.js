/**
 * Gate for the HITL draft-review UI and /admin/api/*.
 *
 * ADMIN_PASSWORD is required. If it is unset, callers must fail closed —
 * never serve the page or the API. Optional ADMIN_API_KEY authenticates
 * script calls (header X-Admin-Key or Authorization: Bearer) once the
 * password is configured. The key is not accepted in the query string.
 *
 * Browser sessions are an HMAC cookie signed with ADMIN_PASSWORD, so
 * changing the password invalidates every session. No server-side session
 * store, and the password is never written into the cookie.
 */
const crypto = require('crypto');

const COOKIE = 'dmf_hitl';
const MAX_AGE_SEC = 7 * 24 * 60 * 60;

function passwordConfigured() {
  return typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD.length > 0;
}

function apiKeyConfigured() {
  return typeof process.env.ADMIN_API_KEY === 'string' && process.env.ADMIN_API_KEY.length > 0;
}

/** SHA-256 both sides so timingSafeEqual does not leak the length. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function signSession(user) {
  const payload = {
    exp: Date.now() + MAX_AGE_SEC * 1000,
    v: user ? 2 : 1,
  };
  if (user && user.username) {
    payload.uid = user.id || null;
    payload.username = user.username;
    payload.role = user.role;
    payload.name = user.display_name || user.username;
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSession(req) {
  if (!passwordConfigured()) return null;
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || !(data.exp > Date.now())) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionOk(req) {
  return !!readSession(req);
}

function basicPassword(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return decoded.slice(i + 1);
}

function basicOk(req) {
  if (!passwordConfigured()) return false;
  const presented = basicPassword(req);
  if (presented == null || presented.length > 500) return false;
  return safeEqual(presented, process.env.ADMIN_PASSWORD);
}

function presentedApiKey(req) {
  const header = req.headers['x-admin-key'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function apiKeyOk(req) {
  if (!passwordConfigured() || !apiKeyConfigured()) return false;
  const presented = presentedApiKey(req);
  if (presented == null || presented.length > 500) return false;
  return safeEqual(presented, process.env.ADMIN_API_KEY);
}

/** Session cookie or HTTP Basic (the password form / browser / curl -u). */
function passwordAuthed(req) {
  return sessionOk(req) || basicOk(req);
}

/** Password methods, or ADMIN_API_KEY when that env var is also set. */
function isAuthed(req) {
  return passwordAuthed(req) || apiKeyOk(req);
}

function setSessionCookie(req, res, user) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE}=${signSession(user)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/admin',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0`);
}

module.exports = {
  COOKIE,
  passwordConfigured,
  passwordAuthed,
  isAuthed,
  safeEqual,
  readSession,
  setSessionCookie,
  clearSessionCookie,
};
