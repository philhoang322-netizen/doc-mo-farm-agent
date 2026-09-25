/**
 * Pull recent Page conversations that a missed webhook never turned into
 * PENDING_REVIEW drafts. Does not send anything to customers.
 *
 * Messenger: Graph `/{page-id}/conversations` with the Page token in the
 * Authorization header only. Window is INBOX_SYNC_HOURS (default 24).
 * Zalo OA in this repo can send and read a profile, but it has no recent-
 * conversation list, so that side is reported and skipped.
 */
const drafts = require('./drafts');

const GRAPH_VERSION = 'v21.0';
const GAP_MS = 60 * 1000;
const ZALO_REASON = 'Zalo OA trong repo chỉ gửi tin và lấy hồ sơ, không có API liệt kê hội thoại gần đây.';

let lastSyncMs = 0;

function windowHours() {
  const n = Number(process.env.INBOX_SYNC_HOURS || 24);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(168, Math.max(1, Math.round(n)));
}

function resetForTests() {
  lastSyncMs = 0;
}

function safeText(value, token) {
  let out = String(value || '');
  if (token) out = out.split(token).join('[token]');
  return out.slice(0, 500);
}

function graphFailure(res, token) {
  const data = res && res.data;
  const err = data && data.error;
  if (err && (err.message || err.code != null)) {
    return {
      message: safeText(err.message || 'Graph từ chối yêu cầu', token),
      code: err.code == null ? null : err.code,
    };
  }
  if (res && res.status >= 400) {
    return { message: `Graph HTTP ${res.status}`, code: null };
  }
  return null;
}

function conversationsUrl(pageId, after) {
  const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/conversations`);
  u.searchParams.set('fields', 'messages.limit(20){id,message,from,created_time}');
  u.searchParams.set('limit', '20');
  if (after) u.searchParams.set('after', after);
  return u.href;
}

function messageList(conv) {
  const nested = conv && conv.messages;
  if (!nested) return [];
  if (Array.isArray(nested)) return nested;
  if (Array.isArray(nested.data)) return nested.data;
  return [];
}

function withinWindow(iso, now, hours) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const start = now.getTime() - hours * 3600 * 1000;
  return t >= start && t <= now.getTime() + 5 * 60 * 1000;
}

async function defaultIngest(item) {
  const pipeline = require('./pipeline');
  const messenger = require('./messenger');
  return pipeline.handleMessage({
    channel: 'messenger',
    externalKey: messenger.customerKey(item.psid),
    replyTo: String(item.psid),
    senderName: item.name || null,
    text: item.text,
    msgId: item.id,
    send: async () => null,
    log: () => {},
  });
}

async function fetchPages(http, pageId, token) {
  const pages = [];
  let after = null;
  for (let i = 0; i < 4; i += 1) {
    const url = conversationsUrl(pageId, after);
    if (token && url.includes(token)) {
      return { error: { message: 'Từ chối gọi Graph vì token lọt vào URL', code: null }, pages };
    }
    let res;
    try {
      res = await http.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });
    } catch (e) {
      const status = e.response && e.response.status;
      const data = e.response && e.response.data;
      const fail = graphFailure({ status, data }, token);
      return {
        error: fail || { message: safeText(e.message || 'Không gọi được Graph', token), code: null },
        pages,
      };
    }
    const fail = graphFailure(res, token);
    if (fail) return { error: fail, pages };
    const data = (res && res.data) || {};
    pages.push(data);
    const next = data.paging && data.paging.cursors && data.paging.cursors.after;
    if (!next || !(data.data || []).length) break;
    after = next;
  }
  return { error: null, pages };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.http] `{ get(url, config) }` Graph client
 * @param {Date} [opts.now]
 * @param {function} [opts.ingest] `(item) => pipeline result`
 */
async function syncMissed(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const hours = windowHours();
  const zalo = { synced: false, reason: ZALO_REASON };
  const pageId = String(process.env.FB_PAGE_ID || '').trim();
  const token = String(process.env.FB_PAGE_ACCESS_TOKEN || '').trim();
  const base = {
    ok: false,
    added: 0,
    skipped: 0,
    skipped_old: 0,
    skipped_page: 0,
    window_hours: hours,
    error: null,
    error_code: null,
    zalo,
    rate_limited: false,
  };

  if (!pageId || !token) {
    return {
      ...base,
      error: 'Thiếu FB_PAGE_ID hoặc FB_PAGE_ACCESS_TOKEN nên không kéo được Messenger.',
    };
  }

  const nowMs = now.getTime();
  if (lastSyncMs && nowMs - lastSyncMs < GAP_MS) {
    const retry = GAP_MS - (nowMs - lastSyncMs);
    return {
      ...base,
      rate_limited: true,
      error: 'Đồng bộ vừa chạy. Vui lòng đợi một phút.',
      retry_after_ms: retry,
    };
  }
  lastSyncMs = nowMs;

  const http = opts.http || require('./messenger').graphHttp;
  const fetched = await fetchPages(http, pageId, token);
  if (fetched.error) {
    return {
      ...base,
      error: fetched.error.message,
      error_code: fetched.error.code,
    };
  }

  const ingest = opts.ingest || defaultIngest;
  const seen = new Set();
  for (const page of fetched.pages) {
    for (const conv of page.data || []) {
      for (const msg of messageList(conv)) {
        const id = msg && msg.id ? String(msg.id) : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const fromId = msg.from && msg.from.id != null ? String(msg.from.id) : '';
        if (!fromId || fromId === pageId) {
          base.skipped_page += 1;
          continue;
        }
        if (!withinWindow(msg.created_time, now, hours)) {
          base.skipped_old += 1;
          continue;
        }
        const text = msg.message != null ? String(msg.message).trim() : '';
        if (!text) continue;

        const existing = await drafts.findBySourceMsg('messenger', id);
        if (existing) {
          base.skipped += 1;
          continue;
        }

        const outcome = await ingest({
          id,
          psid: fromId,
          name: msg.from && msg.from.name ? String(msg.from.name).slice(0, 200) : null,
          text: text.slice(0, 2000),
          created_time: msg.created_time,
        });
        if (outcome && outcome.skipped === 'duplicate') {
          base.skipped += 1;
          continue;
        }
        if (outcome && (outcome.draftId || (outcome.draft && outcome.draft.id))) {
          base.added += 1;
          continue;
        }
        if (outcome && outcome.held) {
          base.added += 1;
        }
      }
    }
  }

  return { ...base, ok: true, error: null };
}

module.exports = {
  syncMissed,
  resetForTests,
  windowHours,
  conversationsUrl,
  ZALO_REASON,
  GAP_MS,
};
