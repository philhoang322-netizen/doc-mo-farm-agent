/**
 * Facebook Messenger channel for Omni Sale DMF.
 *
 * Inbound:  GET+POST /messenger/webhook
 * Outbound: Graph Send API POST /me/messages (only from drafts.deliver
 *           after a person approves). Customer text is never auto-sent.
 *
 * MESSENGER_ENABLED defaults to off. Until it is true, POST is acknowledged
 * and ignored so a public Railway URL does not draft or reply.
 *
 * HMAC uses FB_APP_SECRET. FB_APP_SECRET_ALT and FB_CLIENT_TOKEN are optional
 * diagnostics tried only after the primary secret fails. MESSENGER_SKIP_VERIFY
 * (1 or true) is a temporary bypass for a short pipeline proof.
 * MESSENGER_SIG_CAPTURE (1 or true) logs one messenger_sig_capture line with
 * the signature headers and the exact HMAC bytes (base64) so they can be
 * recomputed offline. Default off.
 * MESSENGER_VERIFY_MODE=hmac_or_graph, when HMAC fails, keeps an event only
 * after Graph confirms that mid. MESSENGER_SKIP_VERIFY still bypasses both.
 * None of these auto-send a customer reply.
 */
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const GRAPH_VERSION = 'v21.0';
const MAX_TEXT = 2000;
const TRUTHY = /^(1|true|yes|on)$/i;

/** Injectable HTTP client so tests can mock Graph without Meta credentials. */
const graphHttp = {
  post(url, data, config) {
    return axios.post(url, data, config);
  },
  get(url, config) {
    return axios.get(url, config);
  },
};

let lastError = null;

function enabled() {
  return TRUTHY.test(String(process.env.MESSENGER_ENABLED || '').trim());
}

function pageToken() {
  return String(process.env.FB_PAGE_ACCESS_TOKEN || '').trim();
}

function appSecret() {
  return String(process.env.FB_APP_SECRET || '').trim();
}

function optionalSecret(name) {
  return String(process.env[name] || '').trim();
}

function candidateSecrets() {
  return {
    primary: appSecret(),
    alt: optionalSecret('FB_APP_SECRET_ALT'),
    clientToken: optionalSecret('FB_CLIENT_TOKEN'),
  };
}

function attemptFlags(secrets) {
  return {
    triedPrimary: Boolean(secrets.primary),
    triedAlt: Boolean(secrets.alt),
    triedClientToken: Boolean(secrets.clientToken),
  };
}

/** Emergency only: `1` or `true`. Accepts a POST that failed HMAC. Default off. */
function skipVerifyEnabled() {
  return /^(1|true)$/i.test(String(process.env.MESSENGER_SKIP_VERIFY || '').trim());
}

/** Temporary: `1` or `true`. Logs the signed bytes. Default off. */
function sigCaptureEnabled() {
  return /^(1|true)$/i.test(String(process.env.MESSENGER_SIG_CAPTURE || '').trim());
}

/** `hmac` (default) or `hmac_or_graph`. Anything else stays on HMAC only. */
function verifyMode() {
  const mode = String(process.env.MESSENGER_VERIFY_MODE || '').trim().toLowerCase();
  return mode === 'hmac_or_graph' ? 'hmac_or_graph' : 'hmac';
}

const SKIP_VERIFY_WARNING = 'TEMPORARY for Phil\'s 10-minute pipeline proof only. MESSENGER_SKIP_VERIFY accepted this POST without a matching HMAC. Unset it immediately. Customer replies stay PENDING_REVIEW and are not auto-sent.';

function verifyToken() {
  return String(process.env.FB_VERIFY_TOKEN || '').trim();
}

function pageId() {
  return String(process.env.FB_PAGE_ID || '').trim();
}

function messagesUrl() {
  return `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`;
}

function customerKey(psid) {
  const id = String(psid || '').trim().replace(/^fb_/, '');
  return id ? `fb_${id}` : '';
}

function psidFromUserId(userId) {
  const s = String(userId || '').trim();
  if (!s) return '';
  return s.startsWith('fb_') ? s.slice(3) : s;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const SIGNATURE_NOTE = {
  missing_secret: 'Thiếu FB_APP_SECRET',
  missing_header: 'Meta không gửi X-Hub-Signature-256',
  bad_prefix: 'Header không phải dạng sha256=. Xem scheme.',
  mismatch: 'HMAC không khớp FB_APP_SECRET. Xem triedPrimary, triedAlt, triedClientToken.',
  raw_body: 'Không đọc được byte thô của POST',
};

function rawBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  if (rawBody == null) return Buffer.alloc(0);
  return Buffer.from(String(rawBody), 'utf8');
}

function unquote(value) {
  const text = String(value || '').replace(/^\uFEFF/, '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** One header may be repeated and joined with a comma. Each piece is a candidate. */
function headerTokens(signatureHeader) {
  const list = Array.isArray(signatureHeader) ? signatureHeader : [signatureHeader];
  const out = [];
  for (const item of list) {
    if (item == null) continue;
    const text = unquote(item);
    if (!text) continue;
    for (const part of text.split(',')) {
      const token = unquote(part);
      if (token) out.push(token);
    }
  }
  return out;
}

function splitScheme(token) {
  const trimmed = unquote(token);
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return { scheme: '', value: trimmed };
  const scheme = trimmed.slice(0, eq).trim().toLowerCase();
  return {
    scheme: /^[a-z0-9]{1,16}$/.test(scheme) ? scheme : '',
    value: unquote(trimmed.slice(eq + 1)),
  };
}

/** First 8 hex chars of a full SHA-256 digest. Anything else is omitted so a secret is not logged. */
function digestPrefix(hex) {
  const s = String(hex || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s.slice(0, 8) : undefined;
}

/**
 * Meta signs the raw request bytes: `sha256=` + hex HMAC-SHA256(FB_APP_SECRET).
 * The prefix and the hex digest are compared case-insensitively. Hex is
 * case-insensitive by definition; a strict `sha256=` / lowercase compare
 * rejects a valid Meta signature.
 * Hash the captured bytes, not JSON.stringify(req.body). Meta signs the
 * escaped-unicode payload (`ä` on the wire is `\u00e4`).
 * After FB_APP_SECRET misses, FB_APP_SECRET_ALT is tried, then FB_CLIENT_TOKEN.
 * A match names which candidate worked (`primary`, `alt`, `client_token`).
 * The client-token check is a hypothesis: Meta documents the App Secret.
 * @returns {{ok:boolean, matched?:string, reason?:string, expectedPrefix?:string, gotPrefix?:string, bodySha256Prefix?:string, gotLen?:number, scheme?:string, triedPrimary?:boolean, triedAlt?:boolean, triedClientToken?:boolean}}
 */
function verifySignature(rawBody, signatureHeader) {
  const secrets = candidateSecrets();
  const flags = attemptFlags(secrets);
  if (!secrets.primary && !secrets.alt && !secrets.clientToken) {
    return { ok: false, reason: 'missing_secret', ...flags };
  }

  const tokens = headerTokens(signatureHeader);
  if (tokens.length === 0) return { ok: false, reason: 'missing_header', ...flags };

  const raw = rawBuffer(rawBody);
  const bodySha256Prefix = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const keys = [];
  if (secrets.primary) {
    keys.push({
      matched: 'primary',
      hex: crypto.createHmac('sha256', secrets.primary).update(raw).digest('hex'),
    });
  }
  if (secrets.alt) {
    keys.push({
      matched: 'alt',
      hex: crypto.createHmac('sha256', secrets.alt).update(raw).digest('hex'),
    });
  }
  if (secrets.clientToken) {
    keys.push({
      matched: 'client_token',
      hex: crypto.createHmac('sha256', secrets.clientToken).update(raw).digest('hex'),
    });
  }

  let sawSha256 = false;
  let gotHex = '';
  let scheme = '';

  for (const token of tokens) {
    const parsed = splitScheme(token);
    if (parsed.scheme === 'sha256') scheme = 'sha256';
    else if (!scheme && parsed.scheme) scheme = parsed.scheme;
    if (parsed.scheme !== 'sha256') continue;
    sawSha256 = true;
    const hex = parsed.value.trim().toLowerCase();
    if (!gotHex) gotHex = hex;
    if (!/^[0-9a-f]{64}$/.test(hex)) continue;
    for (const key of keys) {
      if (safeEqual(hex, key.hex)) return { ok: true, matched: key.matched, ...flags };
    }
  }

  const primaryKey = keys.find((key) => key.matched === 'primary');
  const diag = {
    bodySha256Prefix,
    ...flags,
  };
  if (primaryKey) diag.expectedPrefix = primaryKey.hex.slice(0, 8);
  if (scheme) diag.scheme = scheme;

  if (!sawSha256) {
    const sample = splitScheme(tokens[0]).value.trim().toLowerCase();
    const gotPrefix = digestPrefix(sample);
    return {
      ok: false,
      reason: 'bad_prefix',
      ...diag,
      gotLen: sample.length,
      ...(gotPrefix ? { gotPrefix } : {}),
    };
  }

  const gotPrefix = digestPrefix(gotHex);
  return {
    ok: false,
    reason: 'mismatch',
    ...diag,
    gotLen: gotHex.length,
    ...(gotPrefix ? { gotPrefix } : {}),
  };
}

/**
 * Read the exact POST bytes for /messenger/webhook before express.json.
 * Meta signs those bytes. A JSON parser that skips a non-json content type
 * would otherwise leave req.rawBody unset and every Page POST looks unsigned.
 * Sets req._body after the stream is consumed. body-parser 2 then skips the
 * request because the stream is already finished.
 */
function captureRawBody(req, res, next) {
  if (req.method !== 'POST') return next();
  return express.raw({ type: () => true, limit: '1mb' })(req, res, (err) => {
    if (err) {
      console.error('messenger_bad_signature', {
        reason: 'raw_body',
        note: SIGNATURE_NOTE.raw_body,
        rawBodyLength: 0,
        signatureHeaderPresent: Boolean(req.get('x-hub-signature-256')),
      });
      return res.status(err.status || 400).json({ ok: false, error: 'bad_body' });
    }
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : (req.body instanceof Uint8Array ? rawBuffer(req.body) : null);
    // Parser skipped (no body). Do not invent an empty buffer: that would
    // block express.json from keeping the real bytes on req.rawBody.
    if (!raw) return next();
    req.rawBody = raw;
    req.messengerRawSource = 'capture_raw';
    req._body = true;
    if (!raw.length) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(raw.toString('utf8'));
      req.messengerJsonError = false;
    } catch {
      req.body = {};
      req.messengerJsonError = true;
    }
    next();
  });
}

function safeContentType(req) {
  if (typeof req.get !== 'function') return undefined;
  const match = String(req.get('content-type') || '').toLowerCase()
    .match(/^\s*([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)\s*(?:;\s*charset\s*=\s*"?([a-z0-9._-]+)"?)?/);
  if (!match) return undefined;
  return match[2] ? `${match[1]}; charset=${match[2]}` : match[1];
}

function signatureDetail(req, result) {
  const reason = typeof result === 'string' ? result : (result && result.reason) || 'bad_signature';
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
  const header = typeof req.get === 'function' ? req.get('x-hub-signature-256') : '';
  const detail = {
    reason,
    note: SIGNATURE_NOTE[reason] || 'Chữ ký webhook không hợp lệ',
    rawBodyLength: raw ? raw.length : 0,
    signatureHeaderPresent: Boolean(header),
  };
  const contentType = safeContentType(req);
  if (contentType) detail.contentType = contentType;
  if (result && typeof result === 'object') {
    for (const key of ['expectedPrefix', 'gotPrefix', 'bodySha256Prefix', 'gotLen', 'scheme', 'triedPrimary', 'triedAlt', 'triedClientToken']) {
      if (result[key] !== undefined && result[key] !== '') detail[key] = result[key];
    }
  }
  return detail;
}

const KEY_LABELS = [
  ['primary', 'FB_APP_SECRET'],
  ['alt', 'FB_APP_SECRET_ALT'],
  ['clientToken', 'FB_CLIENT_TOKEN'],
];

/**
 * Meta's webhook JSON escapes non-ASCII as lowercase `\uXXXX` (UTF-16 code
 * units) and escapes `/` as `\/`. JSON.stringify does neither for ordinary
 * text. `jsonText` is already the output of JSON.stringify.
 */
function metaEscapedJson(jsonText) {
  const text = String(jsonText);
  let out = '';
  for (const ch of text) {
    if (ch === '/') {
      out += '\\/';
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp > 0x7f) {
      for (let i = 0; i < ch.length; i += 1) {
        out += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function hmacHeaderMatches(algorithm, secret, payload, headerValue, scheme) {
  if (!secret || headerValue == null || headerValue === '') return false;
  const digest = crypto.createHmac(algorithm, secret).update(payload).digest('hex');
  for (const token of headerTokens(headerValue)) {
    const parsed = splitScheme(token);
    if (parsed.scheme !== scheme) continue;
    const hex = parsed.value.trim().toLowerCase();
    if (hex.length === digest.length && safeEqual(hex, digest)) return true;
  }
  return false;
}

function keyMatches(algorithm, secrets, payload, headerValue, scheme) {
  const out = {};
  for (const [slot, label] of KEY_LABELS) {
    if (!secrets[slot]) continue;
    out[label] = hmacHeaderMatches(algorithm, secrets[slot], payload, headerValue, scheme);
  }
  return out;
}

function headerValue(req, name) {
  if (!req || typeof req.get !== 'function') return null;
  const value = req.get(name);
  if (value == null || value === '') return null;
  return String(value);
}

/** Bytes actually passed to HMAC, plus where they came from. */
function bytesForHmac(req) {
  const tagged = req && req.messengerRawSource;
  if (Buffer.isBuffer(req && req.rawBody) || (req && req.rawBody instanceof Uint8Array)) {
    return {
      raw: rawBuffer(req.rawBody),
      rawBodySource: tagged || 'verify_hook',
    };
  }
  return { raw: rawBuffer(req && req.rawBody), rawBodySource: 'reconstructed' };
}

/**
 * One opt-in diagnostic line. Includes the signature headers and the raw
 * body so the HMAC can be recomputed offline. Never includes a secret.
 */
function buildSigCapture(req) {
  const secrets = candidateSecrets();
  const { raw, rawBodySource } = bytesForHmac(req);
  const sha256Header = headerValue(req, 'x-hub-signature-256');
  const sha1Header = headerValue(req, 'x-hub-signature');
  let plain = null;
  let meta = null;
  try {
    const text = JSON.stringify(req && req.body);
    if (typeof text === 'string') {
      plain = Buffer.from(text, 'utf8');
      meta = Buffer.from(metaEscapedJson(text), 'utf8');
    }
  } catch {
    plain = null;
    meta = null;
  }
  return {
    xHubSignature256: sha256Header,
    xHubSignature: sha1Header,
    rawBodyBase64: raw.toString('base64'),
    rawBodyLength: raw.length,
    contentType: headerValue(req, 'content-type'),
    contentEncoding: headerValue(req, 'content-encoding'),
    contentLength: headerValue(req, 'content-length'),
    transferEncoding: headerValue(req, 'transfer-encoding'),
    userAgent: headerValue(req, 'user-agent'),
    rawBodySource,
    sha1Raw: keyMatches('sha1', secrets, raw, sha1Header, 'sha1'),
    sha256JsonStringify: plain
      ? keyMatches('sha256', secrets, plain, sha256Header, 'sha256')
      : keyMatches('sha256', secrets, Buffer.alloc(0), null, 'sha256'),
    sha256MetaEscaped: meta
      ? keyMatches('sha256', secrets, meta, sha256Header, 'sha256')
      : keyMatches('sha256', secrets, Buffer.alloc(0), null, 'sha256'),
  };
}

function signBody(rawBody, secret = appSecret()) {
  const raw = rawBuffer(rawBody);
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function getLastError() {
  return lastError;
}

async function postMessage(payload) {
  const token = pageToken();
  if (!enabled()) {
    lastError = 'MESSENGER_ENABLED đang tắt';
    return { ok: false, error: lastError };
  }
  if (!token) {
    lastError = 'Thiếu FB_PAGE_ACCESS_TOKEN';
    return { ok: false, error: lastError };
  }
  try {
    const res = await graphHttp.post(messagesUrl(), payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    const data = res && res.data ? res.data : {};
    if (res && res.status >= 200 && res.status < 300 && (data.message_id || data.recipient_id)) {
      lastError = null;
      return { ok: true, message_id: data.message_id || null };
    }
    const detail = (data.error && (data.error.message || data.error.error_user_msg))
      || (res ? `HTTP ${res.status}` : 'Graph không trả lời');
    lastError = String(detail).slice(0, 500);
    return { ok: false, error: lastError };
  } catch (e) {
    lastError = String(e.message || e).slice(0, 500);
    return { ok: false, error: lastError };
  }
}

async function sendText(psid, text) {
  const id = psidFromUserId(psid);
  const body = String(text || '').trim();
  if (!id) return { ok: false, error: 'Thiếu PSID' };
  if (!body) return { ok: false, error: 'Tin nhắn trống' };

  const chunks = [];
  for (let i = 0; i < body.length; i += MAX_TEXT) chunks.push(body.slice(i, i + MAX_TEXT));
  let last = null;
  for (const chunk of chunks) {
    last = await postMessage({
      recipient: { id },
      messaging_type: 'RESPONSE',
      message: { text: chunk },
    });
    if (!last.ok) return last;
  }
  return last || { ok: false, error: 'Tin nhắn trống' };
}

async function sendImage(psid, imageUrl) {
  const id = psidFromUserId(psid);
  const url = String(imageUrl || '').trim();
  if (!id || !url) return { ok: false, error: 'Thiếu ảnh QR hoặc PSID' };
  return postMessage({
    recipient: { id },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'image',
        payload: { url, is_reusable: true },
      },
    },
  });
}

function attachmentKind(attachments) {
  const type = String((attachments && attachments[0] && attachments[0].type) || '').toLowerCase();
  if (type === 'image') return 'image';
  if (type === 'audio') return 'audio';
  if (type === 'video') return 'video';
  if (type === 'file') return 'file';
  return 'file';
}

const GRAPH_VERIFY_TIMEOUT_MS = 10000;

/**
 * Read one Messenger message the Page already has.
 * https://developers.facebook.com/docs/graph-api/reference/message/
 * Token stays in the Authorization header, never the query string.
 */
function messageLookupUrl(mid) {
  const id = encodeURIComponent(String(mid));
  return `https://graph.facebook.com/${GRAPH_VERSION}/${id}?fields=id,message,from,to,created_time`;
}

function midPrefix(mid) {
  const s = String(mid || '');
  return s ? s.slice(0, 8) : undefined;
}

function isTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return true;
  return /timeout/i.test(String(err.message || ''));
}

function graphErrorCode(data) {
  const code = data && data.error && data.error.code;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

function graphRecipientIds(to) {
  const ids = [];
  const push = (item) => {
    if (item && item.id != null && String(item.id)) ids.push(String(item.id));
  };
  if (!to) return ids;
  if (Array.isArray(to)) {
    to.forEach(push);
    return ids;
  }
  push(to);
  if (Array.isArray(to.data)) to.data.forEach(push);
  return ids;
}

function pageMatches(graphIds, entry, ev) {
  const configured = pageId();
  const entryId = entry && entry.id != null && String(entry.id) ? String(entry.id) : '';
  const recipient = ev && ev.recipient && ev.recipient.id != null ? String(ev.recipient.id) : '';
  const expected = configured || entryId || recipient;
  if (!expected || graphIds.indexOf(expected) === -1) return false;
  if (configured && entryId && entryId !== configured) return false;
  if (configured && recipient && recipient !== configured) return false;
  if (entryId && recipient && entryId !== recipient) return false;
  if (configured && graphIds.indexOf(configured) === -1) return false;
  if (entryId && graphIds.indexOf(entryId) === -1) return false;
  return true;
}

async function lookupGraphMessage(mid) {
  const token = pageToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const res = await graphHttp.get(messageLookupUrl(mid), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: GRAPH_VERIFY_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const status = res && Number.isInteger(res.status) ? res.status : 0;
    const data = res && res.data && typeof res.data === 'object' ? res.data : {};
    if (status < 200 || status >= 300) {
      const errorCode = graphErrorCode(data);
      return {
        ok: false,
        reason: 'graph_error',
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
    }
    if (data.id == null || String(data.id) === '') {
      return { ok: false, reason: 'not_found', status };
    }
    return { ok: true, status, data };
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'graph_error' };
  }
}

/**
 * HMAC already failed. Keep the event only when Graph shows this mid was
 * sent by this PSID to this Page. No mid: drop. Never logs the token,
 * the PSID, the text, or the full mid.
 */
async function verifyEventWithGraph(ev, entry) {
  const mid = ev && ev.message && ev.message.mid != null ? String(ev.message.mid).trim() : '';
  if (!mid) return { ok: false, log: { reason: 'missing_mid' } };
  const prefix = midPrefix(mid);
  const looked = await lookupGraphMessage(mid);
  if (!looked.ok) {
    const log = { reason: looked.reason, midPrefix: prefix };
    if (Number.isInteger(looked.status)) log.status = looked.status;
    if (looked.errorCode !== undefined) log.errorCode = looked.errorCode;
    return { ok: false, log };
  }
  const data = looked.data;
  const fromId = data.from && data.from.id != null ? String(data.from.id) : '';
  const sender = ev.sender && ev.sender.id != null ? String(ev.sender.id) : '';
  const fromMatch = Boolean(sender) && fromId === sender;
  const pageMatch = pageMatches(graphRecipientIds(data.to), entry, ev);
  const eventText = ev.message && typeof ev.message.text === 'string' ? ev.message.text : '';
  const graphText = typeof data.message === 'string' ? data.message : '';
  const textCompared = eventText !== '' && graphText !== '';
  const textMatch = !textCompared || eventText === graphText;
  const base = {
    midPrefix: prefix,
    exists: true,
    fromMatch,
    pageMatch,
    textCompared,
    textMatch,
  };
  if (!fromMatch) return { ok: false, log: { reason: 'sender_mismatch', ...base } };
  if (!pageMatch) return { ok: false, log: { reason: 'page_mismatch', ...base } };
  if (!textMatch) return { ok: false, log: { reason: 'text_mismatch', ...base } };
  return { ok: true, log: base };
}

async function selectGraphVerifiedEvents(body, log) {
  const record = log || (() => {});
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) {
    const detail = { reason: 'not_page' };
    console.error('messenger_graph_verify_failed', detail);
    record({ type: 'messenger_graph_verify_failed', ...detail });
    return { object: 'page', entry: [] };
  }
  const entries = [];
  for (const entry of body.entry) {
    const batch = Array.isArray(entry && entry.messaging) ? entry.messaging : [];
    const kept = [];
    for (const ev of batch) {
      const verdict = await verifyEventWithGraph(ev, entry);
      if (verdict.ok) {
        console.error('messenger_graph_verified', verdict.log);
        record({ type: 'messenger_graph_verified', ...verdict.log });
        kept.push(ev);
      } else {
        console.error('messenger_graph_verify_failed', verdict.log);
        record({ type: 'messenger_graph_verify_failed', ...verdict.log });
      }
    }
    if (kept.length) entries.push({ ...entry, messaging: kept });
  }
  return { ...body, entry: entries };
}

function messagingEvents(body) {
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return [];
  const out = [];
  for (const entry of body.entry) {
    const batch = Array.isArray(entry && entry.messaging) ? entry.messaging : [];
    for (const ev of batch) out.push(ev);
  }
  return out;
}

function skipReason(ev) {
  if (!ev || typeof ev !== 'object') return 'empty';
  if (ev.delivery) return 'delivery';
  if (ev.read) return 'read';
  if (ev.message && ev.message.is_echo) return 'echo';
  const psid = ev.sender && ev.sender.id;
  if (!psid) return 'no_sender';
  const page = pageId();
  if (page && String(psid) === page) return 'page_sender';
  return null;
}

/**
 * Turn one signed Page webhook body into pipeline calls.
 * Echoes, delivery, and read receipts are ignored.
 */
async function processBody(body, deps) {
  const pipeline = deps && deps.pipeline;
  const log = (deps && deps.log) || (() => {});
  if (!pipeline) return [];
  const results = [];

  for (const ev of messagingEvents(body)) {
    const skip = skipReason(ev);
    if (skip) {
      log({ type: 'messenger_skipped', reason: skip });
      continue;
    }
    const psid = String(ev.sender.id);
    const externalKey = customerKey(psid);
    const send = async (to, text) => {
      const sent = await sendText(to, text);
      return sent && sent.ok ? sent : null;
    };
    const base = {
      channel: 'messenger',
      externalKey,
      replyTo: psid,
      senderName: null,
      send,
      log,
    };

    if (ev.message && typeof ev.message.text === 'string' && ev.message.text.trim()) {
      log({ type: 'messenger_incoming', psid, mid: ev.message.mid || null });
      results.push(await pipeline.handleMessage({
        ...base,
        text: ev.message.text,
        msgId: ev.message.mid || `fb_${psid}_${ev.timestamp || Date.now()}`,
      }));
      continue;
    }

    if (ev.postback) {
      const text = String(ev.postback.title || ev.postback.payload || '').trim();
      if (!text) {
        log({ type: 'messenger_skipped', reason: 'empty_postback' });
        continue;
      }
      log({ type: 'messenger_postback', psid });
      results.push(await pipeline.handleMessage({
        ...base,
        text,
        msgId: ev.postback.mid || `pb_${psid}_${ev.timestamp || Date.now()}`,
      }));
      continue;
    }

    if (ev.message && Array.isArray(ev.message.attachments) && ev.message.attachments.length) {
      const kind = attachmentKind(ev.message.attachments);
      log({ type: 'messenger_attachment', psid, kind });
      results.push(await pipeline.handleNonText({
        ...base,
        kind,
        msgId: ev.message.mid || `att_${psid}_${ev.timestamp || Date.now()}`,
      }));
      continue;
    }

    log({ type: 'messenger_skipped', reason: 'unhandled' });
  }
  return results;
}

function mount(app, deps) {
  const log = (deps && deps.log) || (() => {});

  app.get('/messenger/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = verifyToken();
    if (mode === 'subscribe' && expected && token && safeEqual(token, expected)) {
      console.log('✓ Messenger webhook verified');
      return res.status(200).type('text/plain').send(String(challenge ?? ''));
    }
    return res.sendStatus(403);
  });

  app.post('/messenger/webhook', async (req, res) => {
    if (sigCaptureEnabled()) {
      try {
        console.error('messenger_sig_capture', buildSigCapture(req));
      } catch {
        console.error('messenger_sig_capture_error', { message: 'capture failed' });
      }
    }
    if (!enabled()) {
      log({ type: 'messenger_ignored', reason: 'disabled' });
      return res.status(200).json({ ok: true, ignored: 'disabled' });
    }
    const sig = verifySignature(req.rawBody, req.get('x-hub-signature-256'));
    if (sig.ok && sig.matched === 'alt') {
      const detail = {
        triedPrimary: Boolean(sig.triedPrimary),
        triedAlt: true,
        triedClientToken: Boolean(sig.triedClientToken),
      };
      console.error('messenger_sig_matched_alt', detail);
      log({ type: 'messenger_sig_matched_alt', ...detail });
    } else if (sig.ok && sig.matched === 'client_token') {
      const detail = {
        triedPrimary: Boolean(sig.triedPrimary),
        triedAlt: Boolean(sig.triedAlt),
        triedClientToken: true,
      };
      console.error('messenger_sig_matched_client_token', detail);
      log({ type: 'messenger_sig_matched_client_token', ...detail });
    }
    let graphGate = false;
    if (!sig.ok) {
      const detail = signatureDetail(req, sig);
      // stdout/stderr, not only the in-memory debug log. Never include the
      // secret, the signature value, the full signature, or the body.
      // Skip still wins over hmac_or_graph: it accepts the POST with no Graph call.
      if (skipVerifyEnabled()) {
        console.error('messenger_skip_verify_enabled', {
          warning: SKIP_VERIFY_WARNING,
          ...detail,
        });
        log({ type: 'messenger_skip_verify_enabled', ...detail });
      } else if (verifyMode() === 'hmac_or_graph') {
        console.error('messenger_bad_signature', detail);
        log({ type: 'messenger_bad_signature', ...detail });
        graphGate = true;
      } else {
        console.error('messenger_bad_signature', detail);
        log({ type: 'messenger_bad_signature', ...detail });
        return res.status(403).json({ ok: false, error: 'bad_signature' });
      }
    }
    if (req.messengerJsonError) {
      console.error('messenger_invalid_json', signatureDetail(req, 'invalid_json'));
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }

    let pipelineBody = req.body;
    if (graphGate) {
      pipelineBody = await selectGraphVerifiedEvents(req.body, log);
    }

    const run = () => processBody(pipelineBody, deps).catch((err) => {
      console.error('Messenger webhook error:', err);
      log({ type: 'messenger_error', error: err.message });
    });

    // Tests await the draft. Production answers first; Meta retries are deduped.
    if (process.env.NODE_ENV === 'test') {
      await run();
      return res.status(200).json({ ok: true });
    }
    res.status(200).json({ ok: true });
    await run();
  });
}

module.exports = {
  enabled,
  verifySignature,
  captureRawBody,
  signBody,
  metaEscapedJson,
  buildSigCapture,
  messageLookupUrl,
  verifyMode,
  mount,
  processBody,
  sendText,
  sendImage,
  customerKey,
  psidFromUserId,
  pageId,
  pageToken,
  messagesUrl,
  graphHttp,
  getLastError,
};
