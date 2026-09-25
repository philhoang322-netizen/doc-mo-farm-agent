/**
 * Pull Facebook Messenger history into conversation_messages.
 *
 * Runs on Railway with FB_PAGE_ACCESS_TOKEN. The token stays in the
 * Authorization header. It is never written to a URL or a log. Status
 * returns counts and sender-field names only — never message text.
 *
 * The Zalo OA client in this repo can send and read a profile. It has no
 * conversation-history method, so that side is reported and skipped.
 */
const store = require('./conversationStore');

const GRAPH_VERSION = 'v21.0';
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008]);
const ZALO_REASON = 'Zalo OA trong repo chỉ gửi tin và lấy hồ sơ, không có API liệt kê hội thoại.';
const MESSAGE_FIELDS = 'id,message,from,to,created_time,tags,attachments';

let live = null;

function clampMonths(value) {
  const n = Number(value == null || value === '' ? 6 : value);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.min(24, Math.max(1, Math.round(n)));
}

function resetForTests() {
  live = null;
}

function conversationsUrl(pageId, after) {
  const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pageId)}/conversations`);
  u.searchParams.set('platform', 'messenger');
  u.searchParams.set('fields', `participants,updated_time,messages.limit(25){${MESSAGE_FIELDS}}`);
  u.searchParams.set('limit', '25');
  if (after) u.searchParams.set('after', after);
  return u.href;
}

function messagePageUrl(convId, after) {
  const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(convId)}/messages`);
  u.searchParams.set('fields', MESSAGE_FIELDS);
  u.searchParams.set('limit', '25');
  if (after) u.searchParams.set('after', after);
  return u.href;
}

function messageList(nested) {
  if (!nested) return [];
  if (Array.isArray(nested)) return nested;
  if (Array.isArray(nested.data)) return nested.data;
  return [];
}

function nextCursor(payload) {
  const cursor = payload && payload.paging && payload.paging.cursors && payload.paging.cursors.after;
  return cursor ? String(cursor) : '';
}

function participantIds(conv, pageId) {
  const nested = conv && conv.participants;
  const list = Array.isArray(nested) ? nested : (nested && Array.isArray(nested.data) ? nested.data : []);
  return list
    .map((person) => (person && person.id != null ? String(person.id) : ''))
    .filter((id) => id && id !== String(pageId));
}

function toIds(to) {
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

function tagNames(tags) {
  const list = Array.isArray(tags) ? tags : (tags && Array.isArray(tags.data) ? tags.data : []);
  return list.map((tag) => {
    if (typeof tag === 'string') return tag;
    if (tag && tag.name) return String(tag.name);
    return '';
  }).filter(Boolean);
}

function threadPsid(conv, pageId, messages) {
  const people = participantIds(conv, pageId);
  if (people[0]) return people[0];
  for (const msg of messages) {
    const from = msg && msg.from && msg.from.id != null ? String(msg.from.id) : '';
    if (from && from !== String(pageId)) return from;
    const other = toIds(msg && msg.to).find((id) => id !== String(pageId));
    if (other) return other;
  }
  return '';
}

async function graphGet(http, url, token, job, sleep) {
  if (token && String(url).includes(token)) {
    job.errors += 1;
    return { error: { code: 'token_in_url' } };
  }
  let wait = 1000;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let res;
    try {
      res = await http.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
        validateStatus: () => true,
      });
    } catch (err) {
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
      continue;
    }
    const status = res && res.status;
    const code = res && res.data && res.data.error ? Number(res.data.error.code) : NaN;
    if (status === 429 || RATE_CODES.has(code)) {
      job.rate_limits += 1;
      const header = res && res.headers && (res.headers['retry-after'] || res.headers['Retry-After']);
      const sec = Number(header);
      const delay = Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 30000) : wait;
      await sleep(delay);
      wait = Math.min(wait * 2, 8000);
      continue;
    }
    if ((status && status >= 400) || (res && res.data && res.data.error)) {
      job.errors += 1;
      return { error: { code: Number.isFinite(code) ? code : (status || 'graph') } };
    }
    return { data: (res && res.data) || {} };
  }
  job.errors += 1;
  return { error: { code: 'rate_limit' } };
}

async function storeGraphMessage(msg, pageId, psid, since, job) {
  if (!msg || msg.id == null || !psid) return false;
  const created = msg.created_time ? new Date(msg.created_time) : null;
  if (!created || Number.isNaN(created.getTime())) return false;
  if (created.getTime() < since.getTime()) {
    job.skipped_old += 1;
    return false;
  }
  job.seen += 1;
  const fromId = msg.from && msg.from.id != null ? String(msg.from.id) : '';
  const fromName = msg.from && msg.from.name ? String(msg.from.name).slice(0, 120) : '';
  const direction = fromId && fromId === String(pageId) ? 'out' : 'in';
  const nameIsStaff = fromName && (direction === 'in' || fromId !== String(pageId) || nameLooksLikeStaff(fromName));
  const meta = { page_id: String(pageId) };
  if (fromId) meta.from_id = fromId;
  if (fromName) meta.from_name = fromName;
  const recipients = toIds(msg.to);
  if (recipients[0]) meta.to_id = recipients[0];
  if (msg.app_id != null && String(msg.app_id) !== '') meta.app_id = String(msg.app_id);
  const tags = tagNames(msg.tags);
  if (tags.length) meta.tags = tags;
  const saved = await store.record({
    channel: 'fb',
    thread_id: `fb_${psid}`,
    direction,
    sender_label: nameIsStaff ? fromName : null,
    message_text: msg.message != null ? String(msg.message) : '',
    attachments_summary: store.summarizeAttachments(msg.attachments),
    created_time: created.toISOString(),
    source_msg_id: String(msg.id),
    sender_meta: meta,
  });
  if (saved && saved.inserted) job.messages += 1;
  else if (saved) job.already += 1;
  return true;
}

function nameLooksLikeStaff(name) {
  const ops = require('./ops');
  return ops.normalizeText(name).split(' ').includes('lanh');
}

async function ingestConversation(http, token, pageId, conv, since, job, sleep, pauseMs) {
  const first = messageList(conv && conv.messages);
  const psid = threadPsid(conv, pageId, first);
  if (!psid) return false;
  let batch = first;
  let after = nextCursor(conv && conv.messages);
  let touched = false;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    for (const msg of batch) {
      const kept = await storeGraphMessage(msg, pageId, psid, since, job);
      if (kept) touched = true;
    }
    if (!after) break;
    if (pauseMs) await sleep(pauseMs);
    const url = messagePageUrl(conv.id || '', after);
    const got = await graphGet(http, url, token, job, sleep);
    if (!got || got.error) break;
    batch = messageList(got.data);
    after = nextCursor(got.data);
    if (!batch.length) break;
  }
  return touched;
}

async function run(job, opts) {
  const pageId = String(opts.pageId || process.env.FB_PAGE_ID || '').trim();
  const token = String(opts.token || process.env.FB_PAGE_ACCESS_TOKEN || '').trim();
  const http = opts.http || require('./messenger').graphHttp;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pauseMs = opts.pauseMs == null ? 200 : Number(opts.pauseMs) || 0;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const since = new Date(now.getTime());
  since.setUTCMonth(since.getUTCMonth() - job.months);

  if (!pageId || !token) {
    job.errors += 1;
    job.running = false;
    job.done = false;
    await store.saveBackfillState(job);
    return;
  }

  let after = job.cursor || '';
  for (let guard = 0; guard < 500; guard += 1) {
    const url = conversationsUrl(pageId, after);
    const got = await graphGet(http, url, token, job, sleep);
    if (!got || got.error) {
      job.running = false;
      await store.saveBackfillState(job);
      return;
    }
    const data = got.data || {};
    const convs = Array.isArray(data.data) ? data.data : [];
    job.pages += 1;
    let pageAllOld = convs.length > 0;
    for (const conv of convs) {
      const updated = conv && conv.updated_time ? new Date(conv.updated_time).getTime() : NaN;
      if (!Number.isNaN(updated) && updated < since.getTime()) {
        job.skipped_old += 1;
        continue;
      }
      pageAllOld = false;
      const touched = await ingestConversation(http, token, pageId, conv, since, job, sleep, pauseMs);
      if (touched) job.threads += 1;
    }
    if (pageAllOld) {
      job.cursor = null;
      job.done = true;
      job.running = false;
      await store.saveBackfillState(job);
      return;
    }
    const next = nextCursor(data);
    if (!next || !convs.length) {
      job.cursor = null;
      job.done = true;
      job.running = false;
      await store.saveBackfillState(job);
      return;
    }
    after = next;
    job.cursor = after;
    job.done = false;
    await store.saveBackfillState(job);
    if (pauseMs) await sleep(pauseMs);
  }
  job.running = false;
  await store.saveBackfillState(job);
}

function snapshot(job) {
  const src = job || {};
  return {
    months: src.months || null,
    cursor: src.cursor || null,
    threads: src.threads || 0,
    messages: src.messages || 0,
    errors: src.errors || 0,
    pages: src.pages || 0,
    rate_limits: src.rate_limits || 0,
    skipped_old: src.skipped_old || 0,
    seen: src.seen || 0,
    already: src.already || 0,
    done: src.done === true,
  };
}

async function publicStatus() {
  const saved = live || await store.loadBackfillState();
  const job = snapshot(saved);
  let attribution = {
    fields: [],
    page_from_names: [],
    tags: [],
    echo_app_ids: [],
    signature_lanh_count: 0,
  };
  try {
    attribution = await store.attributionSummary();
  } catch (err) {
    console.error('attribution summary skipped:', err.message);
  }
  return {
    running: !!(live && live.running),
    done: job.done === true,
    threads: job.threads,
    messages: job.messages,
    errors: job.errors,
    progress: {
      pages: job.pages,
      months: job.months,
      has_cursor: !!job.cursor,
      rate_limits: job.rate_limits,
      skipped_old: job.skipped_old,
      seen: job.seen,
      already: job.already,
      complete: job.done === true,
    },
    attribution,
    zalo: { synced: false, reason: ZALO_REASON },
  };
}

async function start(opts = {}) {
  const months = clampMonths(opts.months);
  if (live && live.running) {
    return { started: false, already_running: true };
  }
  const prev = await store.loadBackfillState();
  const resume = prev && !prev.done && prev.months === months && prev.cursor;
  live = {
    running: true,
    done: false,
    months,
    cursor: resume ? prev.cursor : null,
    threads: resume ? prev.threads : 0,
    messages: resume ? prev.messages : 0,
    errors: resume ? prev.errors : 0,
    pages: resume ? prev.pages : 0,
    rate_limits: resume ? prev.rate_limits : 0,
    skipped_old: resume ? prev.skipped_old : 0,
    seen: resume ? prev.seen : 0,
    already: resume ? prev.already : 0,
  };
  const task = run(live, opts).catch(() => {
    if (live) {
      live.running = false;
      live.errors += 1;
    }
    console.error('FB backfill stopped');
  });
  if (opts.wait) {
    await task;
    return { started: true, already_running: false, status: await publicStatus() };
  }
  return { started: true, already_running: false };
}

module.exports = {
  ZALO_REASON,
  RATE_CODES,
  clampMonths,
  conversationsUrl,
  messagePageUrl,
  resetForTests,
  start,
  publicStatus,
};
