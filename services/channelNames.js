/**
 * Display names from Zalo OA and Messenger, cached on the customer record.
 * A failed lookup never blocks the inbox card. Refresh at most once a day.
 *
 * DATABASE_URL set → customers.channel_names (migration 027). Otherwise a
 * JSON file beside the drafts. A linked customer can hold both sources.
 */
const fs = require('fs');
const path = require('path');
const db = require('./database');
const messenger = require('./messenger');
const zaloService = require('./zaloService');

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_MS = 2500;

const SCHEMA = `ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel_names JSONB`;

let columnReady = null;

function filePath() {
  if (process.env.CHANNEL_NAMES_PATH) return process.env.CHANNEL_NAMES_PATH;
  if (process.env.DRAFTS_JSON_PATH) {
    return path.join(path.dirname(process.env.DRAFTS_JSON_PATH), 'channel_names.json');
  }
  return path.join(require('os').tmpdir(), `dmf-channel-names-${process.pid}.json`);
}

function sourceOf(draft) {
  if (!draft) return null;
  const id = String(draft.customer_user_id || '');
  if (draft.channel === 'messenger' || id.startsWith('fb_')) return 'fb';
  if (draft.channel === 'zalo' || draft.channel === 'oa' || draft.channel === 'bot') return 'zalo';
  return null;
}

function httpsUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    return url.href.slice(0, 500);
  } catch {
    return null;
  }
}

function asNames(value) {
  let obj = value;
  if (typeof value === 'string') {
    try { obj = JSON.parse(value); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const source of ['zalo', 'fb']) {
    const row = obj[source];
    if (!row || typeof row !== 'object') continue;
    out[source] = {
      name: row.name ? String(row.name).trim().slice(0, 120) : null,
      avatar: row.avatar ? String(row.avatar).slice(0, 500) : null,
      fetched_at: row.fetched_at || null,
    };
  }
  return out;
}

function fresh(entry, now) {
  if (!entry || !entry.fetched_at) return false;
  const at = Date.parse(entry.fetched_at);
  if (!Number.isFinite(at)) return false;
  return (now || Date.now()) - at < DAY_MS;
}

function readJson() {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeJson(data) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data));
}

async function ensureColumn() {
  if (!db.DB_ENABLED) return;
  if (columnReady) return columnReady;
  columnReady = db.pool.query(SCHEMA).catch((err) => {
    columnReady = null;
    throw err;
  });
  return columnReady;
}

async function loadRecord(externalId) {
  const key = String(externalId || '').trim();
  const file = asNames(readJson()[key]);
  if (!key || !db.DB_ENABLED) return { id: null, names: file };
  try {
    await ensureColumn();
    const customer = await db.getCustomerByExternalId(key);
    if (!customer) return { id: null, names: file };
    const stored = asNames(customer.channel_names);
    const names = Object.keys(stored).length ? stored : file;
    return { id: customer.id, names };
  } catch (err) {
    console.error('Channel name read skipped:', err.message);
    return { id: null, names: file };
  }
}

async function saveRecord(externalId, record) {
  const key = String(externalId || '').trim();
  if (!key) return;
  const file = readJson();
  file[key] = record.names;
  writeJson(file);
  if (!db.DB_ENABLED || !record.id) return;
  try {
    await ensureColumn();
    await db.pool.query(
      'UPDATE customers SET channel_names = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [record.id, JSON.stringify(record.names)]
    );
  } catch (err) {
    console.error('Channel name save skipped:', err.message);
  }
}

function fbName(data) {
  const full = String((data && data.name) || '').trim();
  if (full) return full.slice(0, 120);
  const joined = [data && data.first_name, data && data.last_name]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
  return joined ? joined.slice(0, 120) : '';
}

function graphCode(err) {
  const body = err && err.response && err.response.data;
  const code = body && body.error && body.error.code;
  if (code != null) return String(code);
  const status = err && err.response && err.response.status;
  return status ? String(status) : 'error';
}

async function fetchFb(userId) {
  const token = messenger.pageToken();
  if (!token) return null;
  const psid = messenger.psidFromUserId(userId);
  if (!psid || psid.length > 80) return null;
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(psid)}`;
  try {
    const res = await messenger.graphHttp.get(url, {
      params: { fields: 'first_name,last_name,name,profile_pic', access_token: token },
      timeout: FETCH_MS,
    });
    const data = res && res.data;
    if (!data || data.error) return null;
    const name = fbName(data);
    if (!name) return null;
    return { name, avatar: httpsUrl(data.profile_pic) };
  } catch (err) {
    console.error('FB profile skipped:', graphCode(err));
    return null;
  }
}

async function fetchZalo(userId) {
  const id = String(userId || '').trim();
  if (!id || id.startsWith('bot_') || id.startsWith('fb_')) return null;
  const tokens = zaloService.getTokens();
  if (!tokens || !tokens.accessToken) return null;
  let res;
  try {
    res = await zaloService.getUserProfile(id);
  } catch (err) {
    console.error('Zalo profile skipped:', err.message);
    return null;
  }
  const body = res && (res.data && (res.data.display_name || res.data.user_id) ? res.data : res.data) || res;
  const d = body && body.display_name ? body : (res && res.data) || body;
  if (!d || (d.error != null && Number(d.error) !== 0)) return null;
  const name = String(d.display_name || (d.shared_info && d.shared_info.name) || '').trim();
  if (!name) return null;
  const avatars = d.avatars || {};
  return {
    name: name.slice(0, 120),
    avatar: httpsUrl(d.avatar || avatars['240'] || avatars['120']),
  };
}

function fetchSource(source, userId) {
  if (source === 'fb') return fetchFb(userId);
  if (source === 'zalo') return fetchZalo(userId);
  return Promise.resolve(null);
}

function withTimeout(promise) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, FETCH_MS);
    Promise.resolve(promise).then(value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value || null);
    }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function present(names, ownSource) {
  const out = [];
  if (names.zalo && names.zalo.name) {
    out.push({
      source: 'zalo',
      label: 'Tên Zalo',
      name: names.zalo.name,
      avatar: httpsUrl(names.zalo.avatar),
      own: ownSource === 'zalo',
    });
  }
  if (names.fb && names.fb.name) {
    out.push({
      source: 'fb',
      label: 'Tên FB',
      name: names.fb.name,
      avatar: httpsUrl(names.fb.avatar),
      own: ownSource === 'fb',
    });
  }
  return out;
}

async function forDraft(draft, now) {
  try {
    const id = draft && draft.customer_user_id;
    if (!id) return [];
    const source = sourceOf(draft);
    const record = await loadRecord(id);
    if (source && !fresh(record.names[source], now)) {
      const got = await withTimeout(fetchSource(source, id));
      const previous = record.names[source] || {};
      record.names[source] = {
        name: (got && got.name) || previous.name || null,
        avatar: (got && got.avatar) || previous.avatar || null,
        fetched_at: new Date(now || Date.now()).toISOString(),
      };
      await saveRecord(id, record);
    }
    return present(record.names, source);
  } catch (err) {
    console.error('Channel name skipped:', err.message);
    return [];
  }
}

async function remember(externalId, patch) {
  const record = await loadRecord(externalId);
  for (const source of ['zalo', 'fb']) {
    if (!patch || !patch[source]) continue;
    record.names[source] = {
      name: patch[source].name ? String(patch[source].name).trim().slice(0, 120) : null,
      avatar: patch[source].avatar || null,
      fetched_at: patch[source].fetched_at || new Date().toISOString(),
    };
  }
  await saveRecord(externalId, record);
  return present(record.names, null);
}

/**
 * Manager-typed name, then a KiotViet name matched by phone, then the
 * channel display name, then whatever the draft already has.
 */
function formName({ managerName, kiotName, channelNames, draftName } = {}) {
  const typed = String(managerName || '').trim();
  if (typed) return { name: typed.slice(0, 200), hint: '' };
  const kiot = String(kiotName || '').trim();
  if (kiot) return { name: kiot.slice(0, 200), hint: '' };
  const list = Array.isArray(channelNames) ? channelNames : [];
  const own = list.find(item => item && item.own && item.name) || list.find(item => item && item.name);
  if (own) {
    const hint = own.source === 'fb' ? 'lấy từ Tên FB' : 'lấy từ Tên Zalo';
    return { name: String(own.name).slice(0, 200), hint };
  }
  const draft = String(draftName || '').trim();
  if (draft) return { name: draft.slice(0, 200), hint: '' };
  return { name: '', hint: '' };
}

function kiotComment(channelNames) {
  const list = Array.isArray(channelNames) ? channelNames : [];
  const own = list.find(item => item && item.own && item.name) || list.find(item => item && item.name);
  if (!own) return '';
  const prefix = own.source === 'fb' ? 'FB' : 'Zalo';
  return `${prefix}: ${own.name}`.slice(0, 200);
}

module.exports = {
  forDraft,
  remember,
  formName,
  kiotComment,
  sourceOf,
  filePath,
};
