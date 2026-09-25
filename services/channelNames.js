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
const kiotviet = require('./kiotviet');

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed lookup is not a saved name. Try Graph again after this, not after a day. */
const MISS_MS = 15 * 60 * 1000;
const FETCH_MS = 2500;
const seenFbProfileError = new Set();

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
    const name = row.name ? String(row.name).trim().slice(0, 120) : null;
    const rawId = isRawChannelId(name);
    out[source] = {
      name: rawId ? null : name,
      avatar: row.avatar ? String(row.avatar).slice(0, 500) : null,
      fetched_at: row.fetched_at || null,
      missed: rawId || !name,
      via: row.via === 'thread' ? 'thread' : 'profile',
    };
  }
  if (obj.kiot && typeof obj.kiot === 'object') {
    out.kiot = kiotShape(obj.kiot);
  }
  return out;
}

function clip(value, max) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function kiotShape(row) {
  return {
    name: clip(row && row.name, 120),
    code: clip(row && row.code, 40),
    id: row && row.id != null && String(row.id).trim() ? String(row.id).trim().slice(0, 40) : null,
    phone: row && row.phone ? db.normalizePhone(row.phone) : null,
    fetched_at: row && row.fetched_at || null,
  };
}

function isRawChannelId(name) {
  const text = String(name || '').trim();
  return /^fb_\d{6,}$/.test(text);
}

function usableName(name, channelId) {
  const text = clip(name, 120);
  if (!text) return '';
  if (channelId && text === String(channelId).trim()) return '';
  if (isRawChannelId(text)) return '';
  return text;
}

function fresh(entry, now) {
  if (!entry || !entry.fetched_at) return false;
  const at = Date.parse(entry.fetched_at);
  if (!Number.isFinite(at)) return false;
  const ttl = entry.name && !entry.missed ? DAY_MS : MISS_MS;
  return (now || Date.now()) - at < ttl;
}

function logFbProfileOnce(psid, err) {
  const id = String(psid || '').trim();
  if (!id || seenFbProfileError.has(id)) return;
  seenFbProfileError.add(id);
  if (seenFbProfileError.size > 500) {
    seenFbProfileError.delete(seenFbProfileError.values().next().value);
  }
  console.error('FB profile skipped:', { psid: id, code: graphCode(err) });
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

function readPhone(phone) {
  const data = readJson();
  const phones = data.__phones;
  if (!phones || typeof phones !== 'object') return null;
  return phones[phone] || null;
}

function writePhone(phone, entry) {
  const data = readJson();
  const phones = data.__phones && typeof data.__phones === 'object' ? data.__phones : {};
  phones[phone] = entry;
  data.__phones = phones;
  writeJson(data);
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
  if (!key || !db.DB_ENABLED)     return { id: null, names: file, phone: null, displayName: null };
  try {
    await ensureColumn();
    const customer = await db.getCustomerByExternalId(key);
    if (!customer) return { id: null, names: file, phone: null, displayName: null };
    const stored = asNames(customer.channel_names);
    const names = Object.keys(stored).length ? stored : file;
    return {
      id: customer.id,
      names,
      phone: db.normalizePhone(customer.phone),
      displayName: customer.display_name || null,
    };
  } catch (err) {
    console.error('Channel name read skipped:', err.message);
    return { id: null, names: file, phone: null, displayName: null };
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
    if (!data || data.error) {
      logFbProfileOnce(psid, { response: { status: res && res.status, data } });
      return null;
    }
    const name = fbName(data);
    if (!name) return null;
    return { name, avatar: httpsUrl(data.profile_pic), via: 'profile' };
  } catch (err) {
    logFbProfileOnce(psid, err);
    return null;
  }
}

function threadName(payload, pageId, psid) {
  const convos = payload && Array.isArray(payload.data) ? payload.data : [];
  const people = [];
  const froms = [];
  for (const conv of convos) {
    const participants = conv && conv.participants && conv.participants.data;
    if (Array.isArray(participants)) people.push(...participants);
    const messages = conv && conv.messages && conv.messages.data;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg && msg.from) froms.push(msg.from);
      }
    }
  }
  const named = (person) => {
    if (!person) return '';
    const id = String(person.id || '');
    if (pageId && id === String(pageId)) return '';
    const name = usableName(person.name, `fb_${psid}`);
    if (!name || name === String(psid)) return '';
    return name;
  };
  const match = people.find(person => String(person && person.id || '') === String(psid));
  const fromMatch = named(match) || named(froms.find(person => String(person && person.id || '') === String(psid)));
  if (fromMatch) return fromMatch;
  for (const person of people.concat(froms)) {
    const name = named(person);
    if (name) return name;
  }
  return '';
}

async function fetchFbThread(userId) {
  const token = messenger.pageToken();
  const page = messenger.pageId();
  const psid = messenger.psidFromUserId(userId);
  if (!token || !page || !psid || psid.length > 80) return null;
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(page)}/conversations`;
  if (url.includes(token)) return null;
  try {
    const res = await messenger.graphHttp.get(url, {
      params: { user_id: psid, fields: 'participants,messages.limit(5){from}' },
      headers: { Authorization: `Bearer ${token}` },
      timeout: FETCH_MS,
    });
    const data = res && res.data;
    if (!data || data.error) return null;
    const name = threadName(data, page, psid);
    return name ? { name, avatar: null, via: 'thread' } : null;
  } catch (err) {
    console.error('FB conversation name skipped:', graphCode(err));
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
      via: names.zalo.via === 'thread' ? 'thread' : 'profile',
    });
  }
  if (names.fb && names.fb.name) {
    out.push({
      source: 'fb',
      label: 'Tên FB',
      name: names.fb.name,
      avatar: httpsUrl(names.fb.avatar),
      own: ownSource === 'fb',
      via: names.fb.via === 'thread' ? 'thread' : 'profile',
    });
  }
  return out;
}

function channelList(list) {
  return (Array.isArray(list) ? list : []).filter(item => item && (item.source === 'zalo' || item.source === 'fb') && item.name);
}

function pushChannel(lines, item) {
  lines.push({
    source: item.source,
    label: item.label,
    name: item.name,
    avatar: item.avatar || null,
    own: !!item.own,
    text: `${item.label}: ${item.name}`,
  });
}

/**
 * Card header lines, in order: Tên Kiot and Mã KH, a Graph or OA profile
 * name, the name already stored on the draft, a Page-conversation name,
 * then the phone, then the channel id. The raw id is the header only when
 * no name exists anywhere.
 */
function headerLines({ kiot, channels, phone, channelId, storedName, storedSource } = {}) {
  const lines = [];
  const kiotName = clip(kiot && kiot.name, 120);
  const code = clip(kiot && kiot.code, 40);
  if (kiotName || code) {
    const parts = [];
    if (kiotName) parts.push(`Tên Kiot: ${kiotName}`);
    if (code) parts.push(`Mã KH: ${code}`);
    lines.push({
      source: 'kiot',
      label: 'Tên Kiot',
      name: kiotName || '',
      code: code || '',
      id: kiot && kiot.id != null && String(kiot.id).trim() ? String(kiot.id).trim().slice(0, 40) : '',
      text: parts.join(' · '),
    });
  }
  const listed = channelList(channels);
  for (const item of listed) {
    if (item.via === 'thread') continue;
    pushChannel(lines, item);
  }
  const stored = usableName(storedName, channelId);
  const source = storedSource === 'zalo' ? 'zalo' : (storedSource === 'fb' ? 'fb' : '');
  if (stored && source && !lines.some(line => line.source === source && line.name)) {
    const label = source === 'fb' ? 'Tên FB' : 'Tên Zalo';
    lines.push({
      source,
      label,
      name: stored,
      own: true,
      stored: true,
      text: `${label}: ${stored}`,
    });
  }
  for (const item of listed) {
    if (item.via !== 'thread') continue;
    if (lines.some(line => line.source === item.source && line.name)) continue;
    pushChannel(lines, item);
  }
  if (!lines.some(line => line.name)) {
    const fallbackPhone = db.normalizePhone(phone) || clip(phone, 20);
    const fallbackId = clip(channelId, 120);
    if (fallbackPhone) {
      lines.push({ source: 'phone', label: '', name: fallbackPhone, text: fallbackPhone });
    } else if (fallbackId) {
      lines.push({ source: 'id', label: '', name: fallbackId, text: fallbackId });
    } else {
      lines.push({ source: 'fallback', label: '', name: '', text: 'Khách chưa có tên' });
    }
  }
  return lines;
}

async function kiotForPhone(phone, now) {
  const key = db.normalizePhone(phone);
  if (!key) return null;
  const cached = readPhone(key);
  if (cached && fresh(cached, now)) return cached.found ? cached.customer : null;
  let customer = null;
  try {
    const found = await withTimeout(kiotviet.findCustomerByPhone(key));
    if (found && (found.name || found.code || found.id != null)) {
      customer = {
        name: clip(found.name, 120),
        code: clip(found.code, 40),
        id: found.id != null && String(found.id).trim() ? String(found.id).trim().slice(0, 40) : null,
        phone: key,
      };
    }
  } catch (err) {
    console.error('Kiot customer lookup skipped:', err.message);
  }
  const at = new Date(now || Date.now()).toISOString();
  writePhone(key, {
    found: !!(customer && (customer.name || customer.code || customer.id)),
    customer,
    fetched_at: at,
  });
  return customer;
}

async function rememberKiot(externalId, kiot) {
  const phone = db.normalizePhone(kiot && kiot.phone);
  const entry = {
    ...kiotShape({ ...(kiot || {}), phone }),
    fetched_at: new Date().toISOString(),
  };
  if (!entry.name && !entry.code && !entry.id) return null;
  if (phone) {
    writePhone(phone, { found: true, customer: { ...entry, phone }, fetched_at: entry.fetched_at });
  }
  const key = String(externalId || '').trim();
  if (!key) return entry;
  const record = await loadRecord(key);
  record.names.kiot = entry;
  await saveRecord(key, record);
  return entry;
}

async function forDraft(draft, now) {
  try {
    if (!draft) return [];
    const id = String(draft.customer_user_id || '').trim();
    const source = sourceOf(draft);
    const record = id ? await loadRecord(id) : { id: null, names: {}, phone: null };
    if (id && source && !fresh(record.names[source], now)) {
      let got = await withTimeout(fetchSource(source, id));
      const storedAlready = usableName(draft.customer_name, id);
      if (source === 'fb' && !(got && usableName(got.name, id)) && !storedAlready) {
        const thread = await withTimeout(fetchFbThread(id));
        if (thread && thread.name) got = thread;
      }
      const previous = record.names[source] || {};
      const at = new Date(now || Date.now()).toISOString();
      const resolved = got && usableName(got.name, id);
      const kept = usableName(previous.name, id);
      if (resolved) {
        record.names[source] = {
          name: resolved,
          avatar: (got && got.avatar) || previous.avatar || null,
          fetched_at: at,
          missed: false,
          via: got && got.via === 'thread' ? 'thread' : 'profile',
        };
      } else if (kept) {
        record.names[source] = {
          name: kept,
          avatar: previous.avatar || null,
          fetched_at: at,
          missed: false,
          via: previous.via === 'thread' ? 'thread' : 'profile',
        };
      } else {
        record.names[source] = {
          name: null,
          avatar: null,
          fetched_at: at,
          missed: true,
        };
      }
      await saveRecord(id, record);
    }
    const phone = db.normalizePhone(draft.customer_phone) || record.phone || null;
    let kiot = record.names.kiot || null;
    if (phone && !(kiot && kiot.phone === phone && fresh(kiot, now))) {
      const found = await kiotForPhone(phone, now);
      const at = new Date(now || Date.now()).toISOString();
      if (found) kiot = { ...found, phone, fetched_at: at };
      else if (kiot && kiot.phone === phone && (kiot.code || kiot.name || kiot.id)) kiot = { ...kiot, fetched_at: at };
      else kiot = { name: null, code: null, id: null, phone, fetched_at: at };
      if (id) {
        record.names.kiot = kiot;
        await saveRecord(id, record);
      }
    }
    const draftCode = clip(draft.customer_code, 40);
    if (draftCode && (!kiot || !kiot.code)) {
      kiot = {
        name: (kiot && kiot.name) || null,
        code: draftCode,
        id: (kiot && kiot.id) || null,
        phone: (kiot && kiot.phone) || phone || null,
      };
    }
    const storedName = usableName(draft.customer_name, id)
      || usableName(record.displayName, id);
    return headerLines({
      kiot,
      channels: present(record.names, source),
      phone,
      channelId: id,
      storedName,
      storedSource: source,
    });
  } catch (err) {
    console.error('Channel name skipped:', err.message);
    return headerLines({
      phone: draft && draft.customer_phone,
      channelId: draft && draft.customer_user_id,
      storedName: draft && draft.customer_name,
      storedSource: sourceOf(draft),
    });
  }
}

async function previewPhone(draft, phone, now) {
  const shown = draft ? await forDraft(draft, now) : [];
  const channels = shown.filter(item => item && (item.source === 'zalo' || item.source === 'fb'));
  const match = await kiotForPhone(phone, now);
  const key = db.normalizePhone(phone);
  return {
    name: match && match.name || '',
    code: match && match.code || '',
    id: match && match.id || null,
    channel_names: headerLines({
      kiot: match,
      channels,
      phone: key || '',
      channelId: draft && draft.customer_user_id,
      storedName: draft && draft.customer_name,
      storedSource: sourceOf(draft),
    }),
  };
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
  const list = channelList(channelNames);
  const kiotLine = (Array.isArray(channelNames) ? channelNames : []).find(item => item && item.source === 'kiot' && item.name);
  if (kiotLine) return { name: String(kiotLine.name).slice(0, 200), hint: '' };
  const own = list.find(item => item.own) || list[0];
  if (own) {
    const hint = own.source === 'fb' ? 'lấy từ Tên FB' : 'lấy từ Tên Zalo';
    return { name: String(own.name).slice(0, 200), hint };
  }
  const draft = String(draftName || '').trim();
  if (draft) return { name: draft.slice(0, 200), hint: '' };
  return { name: '', hint: '' };
}

function kiotComment(channelNames) {
  const list = channelList(channelNames);
  const own = list.find(item => item.own) || list[0];
  if (!own) return '';
  const prefix = own.source === 'fb' ? 'FB' : 'Zalo';
  return `${prefix}: ${own.name}`.slice(0, 200);
}

module.exports = {
  forDraft,
  previewPhone,
  remember,
  rememberKiot,
  headerLines,
  formName,
  kiotComment,
  sourceOf,
  filePath,
};
