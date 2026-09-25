/**
 * Password-gated draft review mounted on this same Express app.
 * GET /admin without ?key= serves the page. The farm dashboard stays at
 * GET /admin?key=<ZALO_WEBHOOK_TOKEN> and is wired in server.js.
 */
const fs = require('fs');
const path = require('path');
const auth = require('./adminAuth');
const db = require('./database');
const drafts = require('./drafts');
const audit = require('./audit');
const kiotInbox = require('./kiotInbox');
const inboxSync = require('./inboxSync');
const kiotviet = require('./kiotviet');
const customerLink = require('./customerLink');
const roster = require('./roster');
const handover = require('./handover');
const rosterPage = require('./rosterPage');
const brand = require('./brand');
const channelNames = require('./channelNames');
const access = require('./access');
const adminUsers = require('./adminUsers');
const invoices = require('./invoices');

const PUBLIC = path.join(__dirname, '..', 'public', 'admin');

const fails = new Map();

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function lockedOut(ip) {
  const row = fails.get(ip);
  if (!row) return false;
  if (row.lockUntil && row.lockUntil > Date.now()) return true;
  if (row.lockUntil && row.lockUntil <= Date.now()) fails.delete(ip);
  return false;
}

function noteFail(ip) {
  const row = fails.get(ip) || { n: 0, lockUntil: 0 };
  row.n += 1;
  if (row.n >= 8) {
    row.lockUntil = Date.now() + 60 * 1000;
    row.n = 0;
  }
  fails.set(ip, row);
}

function noteOk(ip) {
  fails.delete(ip);
}

function guard(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function badOrigin(req) {
  // SameSite=Lax already keeps the session cookie off cross-site POSTs.
  // This only stops a foreign page from submitting the password form.
  // Some embedded browsers send Origin: null for a first-party form; that
  // is not a foreign site, so it must still be allowed.
  const site = String(req.headers['sec-fetch-site'] || '');
  if (!site || site === 'same-origin' || site === 'same-site' || site === 'none') return false;
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [];
  for (const raw of [req.headers.host, req.headers['x-forwarded-host']]) {
    if (!raw) continue;
    for (const part of String(raw).split(',')) {
      const h = part.trim();
      if (h) hosts.push(h);
    }
  }
  if (!hosts.length) return false;
  return !hosts.includes(originHost);
}

const GATE_CSS = `
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px;
         background:#f6f3ee; color:#1c1712;
         font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .login { width:min(100%,420px); background:#fff; border:1px solid #e4ddd3; border-radius:20px;
           padding:28px 22px 22px; box-shadow:0 10px 30px rgba(40,30,15,.06); }
  h1 { margin:0; font-size:26px; letter-spacing:-.02em; line-height:1.2; }
  .ver { display:inline-block; margin-left:.35em; padding:.14em .5em .1em;
         border-radius:999px; background:#efeae3; color:#5c564e;
         font-size:.46em; font-weight:700; letter-spacing:.02em;
         vertical-align:middle; line-height:1.2; white-space:nowrap; }
  .sub { margin:8px 0 0; color:#5c564e; font-size:15px; }
  label { display:block; margin-top:16px; font-size:13px; font-weight:700; color:#5c564e; }
  input { width:100%; margin-top:4px; font:inherit; font-size:17px; color:#1c1712;
          border:1px solid #e4ddd3; border-radius:12px; padding:12px; min-height:48px; }
  button { width:100%; margin-top:16px; font:inherit; font-size:17px; font-weight:700;
           min-height:48px; border:0; border-radius:12px; background:#0f5a35; color:#fff; cursor:pointer; }
  .err { color:#8d2f2f; font-weight:700; }
  input:focus-visible, button:focus-visible { outline:2px solid #0f5a35; outline-offset:2px; }
`;

function loginHtml(error) {
  return brand.applyTemplate(`<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0f5a35">
<title>Đăng nhập — {{PRODUCT_NAME}}</title>
<style>${GATE_CSS}</style>
</head>
<body>
  <form class="login" method="post" action="/admin/login">
    <h1><span id="product-name">{{PRODUCT_NAME}}</span> <span class="ver" id="app-version">{{VERSION_LABEL}}</span></h1>
    <p class="sub">Duyệt tin nội bộ. Nhập mật khẩu quản trị để xem bản nháp trước khi gửi.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <label>Tên đăng nhập
      <input name="username" autocomplete="username" maxlength="40" placeholder="Để trống nếu dùng mật khẩu quản trị">
    </label>
    <label>Mật khẩu
      <input type="password" name="password" autocomplete="current-password" required maxlength="200">
    </label>
    <button type="submit">Vào trang duyệt</button>
  </form>
  <script>window.OMNI_SALE={{BRAND_JSON}};</script>
</body></html>`);
}

function unconfiguredHtml() {
  return brand.applyTemplate(`<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Chưa cấu hình — {{PRODUCT_NAME}}</title>
<style>${GATE_CSS}</style>
</head>
<body>
  <div class="login">
    <h1><span id="product-name">{{PRODUCT_NAME}}</span> <span class="ver" id="app-version">{{VERSION_LABEL}}</span></h1>
    <p class="sub">Chưa mở trang duyệt. Đặt biến ADMIN_PASSWORD trên Railway rồi khởi động lại service. Trang này không công khai khi thiếu mật khẩu.</p>
  </div>
  <script>window.OMNI_SALE={{BRAND_JSON}};</script>
</body></html>`);
}

async function requireApi(req, res, next) {
  try {
    guard(res);
    if (badOrigin(req)) return res.status(403).json({ error: 'Yêu cầu khác trang bị chặn' });
    if (!auth.passwordConfigured()) {
      return res.status(503).json({ error: 'Chưa cấu hình ADMIN_PASSWORD' });
    }
    if (!auth.isAuthed(req)) {
      res.set('WWW-Authenticate', `Basic realm="${brand.PRODUCT_NAME}", charset="UTF-8"`);
      return res.status(401).json({ error: 'Chưa đăng nhập' });
    }
    const actor = await who(req);
    if (!actor) return res.status(401).json({ error: 'Chưa đăng nhập' });
    next();
  } catch (err) {
    next(err);
  }
}

function requirePageAsset(req, res, next) {
  guard(res);
  if (!auth.passwordConfigured()) return res.status(503).type('text/plain').send('ADMIN_PASSWORD is not configured');
  if (!auth.passwordAuthed(req)) return res.status(401).type('text/plain').send('Unauthorized');
  next();
}

async function page(req, res) {
  guard(res);
  if (!auth.passwordConfigured()) {
    return res.status(503).type('html').send(unconfiguredHtml());
  }
  if (!auth.passwordAuthed(req)) {
    return res.status(200).type('html').send(loginHtml(null));
  }
  if (!await who(req)) {
    auth.clearSessionCookie(res);
    return res.status(200).type('html').send(loginHtml('Tài khoản đã khóa hoặc không còn.'));
  }
  const html = await fs.promises.readFile(path.join(PUBLIC, 'review.html'), 'utf8');
  res.type('html').send(brand.applyTemplate(html));
}

async function login(req, res) {
  guard(res);
  if (badOrigin(req)) return res.status(403).type('html').send(loginHtml('Không gửi được từ trang khác.'));
  if (!auth.passwordConfigured()) {
    return res.status(503).type('html').send(unconfiguredHtml());
  }
  const ip = clientIp(req);
  if (lockedOut(ip)) {
    return res.status(429).type('html').send(loginHtml('Thử lại sau một phút.'));
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (username) {
    const user = await adminUsers.authenticate(username, password);
    if (!user) {
      noteFail(ip);
      return res.status(401).type('html').send(loginHtml('Tên hoặc mật khẩu chưa đúng.'));
    }
    noteOk(ip);
    auth.setSessionCookie(req, res, user);
    return res.redirect(303, '/admin');
  }
  if (!password || password.length > 500 || !auth.safeEqual(password, process.env.ADMIN_PASSWORD)) {
    noteFail(ip);
    return res.status(401).type('html').send(loginHtml('Mật khẩu chưa đúng.'));
  }
  noteOk(ip);
  auth.setSessionCookie(req, res);
  res.redirect(303, '/admin');
}

function logout(req, res) {
  guard(res);
  auth.clearSessionCookie(res);
  res.redirect(303, '/admin');
}

function sendAsset(name, type) {
  return (req, res) => {
    res.type(type);
    res.sendFile(path.join(PUBLIC, name));
  };
}

async function withProfiles(payload) {
  const rows = payload && Array.isArray(payload.drafts) ? payload.drafts : [];
  payload.drafts = await Promise.all(rows.map(async (draft) => {
    try {
      const view = await customerLink.viewForDraft(draft);
      return { ...draft, customer_profile: view.profile, customer_history: view.history };
    } catch (err) {
      console.error('Customer profile skipped:', err.message);
      return draft;
    }
  }));
  return payload;
}

async function attachChannelNames(payload) {
  const rows = payload && payload.drafts;
  if (!Array.isArray(rows)) return payload;
  await Promise.all(rows.map(async (draft) => {
    draft.channel_names = await channelNames.forDraft(draft);
  }));
  return payload;
}

async function who(req) {
  return access.principal(req);
}

function deny(res) {
  return res.status(403).json({ error: 'Không đủ quyền' });
}

async function auditActor(req) {
  const p = await who(req);
  if (p && p.source === 'user') return access.actor(p);
  return audit.managerActor(actorNameFrom(req));
}

async function list(req, res) {
  try {
    const q = req.query || {};
    const p = await who(req);
    const viewer = p && p.role !== 'manager' ? p.role : null;
    const payload = await drafts.listDrafts({
      status: typeof q.status === 'string' && q.status ? q.status : null,
      ops: typeof q.ops === 'string' && q.ops ? q.ops : null,
      type: typeof q.type === 'string' && q.type ? q.type : null,
      salesChannel: typeof q.kenh === 'string' && q.kenh ? q.kenh : null,
      triage: typeof q.triage === 'string' && q.triage ? q.triage : null,
      platform: typeof q.platform === 'string' && q.platform ? q.platform : null,
      nhom: typeof q.nhom === 'string' && q.nhom ? q.nhom : null,
      zline: typeof q.zline === 'string' && q.zline ? q.zline : null,
      hop: typeof q.hop === 'string' && q.hop ? q.hop : null,
      viewer,
    });
    res.json(await withProfiles(await attachChannelNames(payload)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Không tải được danh sách' });
  }
}

function actorNameFrom(req) {
  const bodyName = req.body && typeof req.body.actor_name === 'string' ? req.body.actor_name : '';
  const headerName = req.get('x-actor-name') || '';
  return bodyName || headerName;
}

async function stats(req, res) {
  try {
    const kenh = typeof req.query.kenh === 'string' && req.query.kenh ? req.query.kenh : null;
    res.json(await drafts.messageStats(kenh));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Không tải được thống kê' });
  }
}

async function channels(req, res) {
  try {
    res.json({ channels: await drafts.listChannels() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Không tải được kênh bán' });
  }
}

async function createChannel(req, res) {
  try {
    if (!access.canManageUsers(await who(req))) return deny(res);
    const channel = await drafts.addChannel(req.body && req.body.name);
    res.status(201).json({ channel });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không thêm được kênh' });
  }
}

async function create(req, res) {
  try {
    if (!access.canManageUsers(await who(req))) return deny(res);
    const draft = await drafts.createDraft(req.body, {
      actor: await auditActor(req),
    });
    res.status(201).json({ draft });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không tạo được bản nháp' });
    if (!e.status) console.error('HITL create failed:', e.message);
  }
}

async function moveLine(req, res) {
  try {
    const p = await who(req);
    if (!access.canMove(p)) return deny(res);
    const existing = await drafts.getDraft(req.params.id);
    if (!existing || !access.canSee(p, existing)) return res.status(404).json({ error: 'Không thấy tin' });
    const draft = await drafts.moveBizLine(req.params.id, req.body && req.body.biz_line, {
      actor: await auditActor(req),
    });
    if (!draft) return res.status(404).json({ error: 'Không thấy tin' });
    res.json({ draft });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không chuyển được nhóm' });
  }
}

async function removeDraft(req, res) {
  try {
    const p = await who(req);
    if (!access.canDelete(p)) return deny(res);
    const existing = await drafts.getDraft(req.params.id);
    if (!existing || !access.canSee(p, existing)) return res.status(404).json({ error: 'Không thấy tin' });
    const draft = await drafts.softDelete(req.params.id, {
      actor: await auditActor(req),
    });
    if (!draft) return res.status(404).json({ error: 'Không thấy tin' });
    res.json({ draft });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không xoá được tin' });
  }
}

async function restoreOne(req, res) {
  try {
    if (!access.canDelete(await who(req))) return deny(res);
    const draft = await drafts.restoreDraft(req.params.id, {
      actor: await auditActor(req),
    });
    if (!draft) return res.status(404).json({ error: 'Không thấy tin' });
    res.json({ draft });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không hoàn tác được' });
  }
}

async function setFolder(req, res) {
  try {
    const p = await who(req);
    if (!access.canMove(p)) return deny(res);
    const existing = await drafts.getDraft(req.params.id);
    if (!existing || !access.canSee(p, existing)) return res.status(404).json({ error: 'Không thấy tin' });
    const draft = await drafts.setInboxStatus(req.params.id, req.body && req.body.inbox_status, {
      actor: await auditActor(req),
      auto: false,
      orderCode: req.body && req.body.order_code,
    });
    if (!draft) return res.status(404).json({ error: 'Không thấy tin' });
    res.json({ draft });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không chuyển được thư mục' });
  }
}

async function syncInbox(req, res) {
  try {
    if (!access.canManageUsers(await who(req))) return deny(res);
    const result = await inboxSync.syncMissed();
    if (result.rate_limited) {
      return res.status(429).json({
        error: result.error,
        retry_after_ms: result.retry_after_ms,
        added: 0,
        skipped: 0,
      });
    }
    res.json(result);
  } catch (e) {
    console.error('inbox sync failed:', e.message);
    res.status(500).json({ error: 'Không đồng bộ được' });
  }
}

async function patch(req, res) {
  try {
    const p = await who(req);
    const existing = await drafts.getDraft(req.params.id);
    if (!existing || !access.canSee(p, existing)) return res.status(404).json({ error: 'Không thấy bản nháp' });
    const body = req.body || {};
    if (body.send === true && !await access.canSend(p)) return deny(res);
    const refund = body.review_form && body.review_form.refund_decision;
    if (refund && !access.canRefund(p)) return deny(res);
    const result = await drafts.updateDraft(req.params.id, body, {
      actor: p && p.source === 'user' ? access.actor(p) : undefined,
      actorName: actorNameFrom(req),
    });
    if (!result) return res.status(404).json({ error: 'Không thấy bản nháp' });
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không cập nhật được bản nháp' });
    if (!e.status) console.error('HITL update failed:', e.message);
  }
}

async function listAudit(req, res) {
  try {
    const q = req.query || {};
    res.json(await audit.list({
      conversation: q.conversation,
      order: q.order,
      entity_type: q.entity_type,
      entity_id: q.entity_id,
      action: q.action,
      from: q.from,
      to: q.to,
      limit: q.limit,
    }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Không tải được nhật ký' });
  }
}

async function auditPage(req, res) {
  guard(res);
  if (!auth.passwordConfigured()) {
    return res.status(503).type('html').send(unconfiguredHtml());
  }
  if (!auth.passwordAuthed(req)) {
    return res.status(200).type('html').send(loginHtml(null));
  }
  if (!access.canManageUsers(await who(req))) return res.status(403).type('html').send('Không đủ quyền');
  const html = await fs.promises.readFile(path.join(PUBLIC, 'audit.html'), 'utf8');
  res.type('html').send(brand.applyTemplate(html));
}

async function rosterView(req, res) {
  guard(res);
  if (!auth.passwordConfigured()) {
    return res.status(503).type('html').send(unconfiguredHtml());
  }
  if (!auth.passwordAuthed(req)) return res.redirect(303, '/admin');
  if (!access.canManageUsers(await who(req))) return res.status(403).type('html').send('Không đủ quyền');
  try {
    const html = rosterPage.render({
      shifts: await roster.list(),
      handoffs: await handover.recent(20),
      flash: typeof req.query.ok === 'string' ? req.query.ok : null,
      error: typeof req.query.err === 'string' ? req.query.err : null,
    });
    res.type('html').send(html);
  } catch (e) {
    console.error('Roster page failed:', e.message);
    res.status(500).type('text/plain').send('Không mở được ca trực');
  }
}

async function rosterSave(req, res) {
  guard(res);
  if (badOrigin(req)) return res.status(403).type('text/plain').send('Forbidden');
  if (!auth.passwordConfigured()) return res.status(503).type('text/plain').send('ADMIN_PASSWORD is not configured');
  if (!auth.passwordAuthed(req)) return res.status(401).type('text/plain').send('Unauthorized');
  if (!access.canManageUsers(await who(req))) return res.status(403).type('text/plain').send('Không đủ quyền');
  const back = (params) => res.redirect(303, `/admin/roster?${params}`);
  try {
    const action = String(req.body?.action || 'save');
    if (action === 'delete') {
      await roster.remove(req.body?.id);
      return back(`ok=${encodeURIComponent('Đã xoá ca')}`);
    }
    if (action === 'online') {
      await roster.setOnline(req.body?.id, req.body?.online);
      return back(`ok=${encodeURIComponent('Đã cập nhật online')}`);
    }
    await roster.upsert({
      id: req.body?.id,
      name: req.body?.name,
      notify_target: req.body?.notify_target,
      weekdays: req.body?.weekdays,
      start: req.body?.start,
      end: req.body?.end,
      // Absent checkbox means off. Programmatic roster.upsert() still
      // defaults these to online false / active true when the key is omitted.
      online: req.body?.online === '1' || req.body?.online === 'on',
      active: req.body?.active === '1' || req.body?.active === 'on',
      timezone: 'Asia/Ho_Chi_Minh',
    });
    return back(`ok=${encodeURIComponent('Đã lưu ca trực')}`);
  } catch (e) {
    return back(`err=${encodeURIComponent(e.message || 'Không lưu được ca')}`);
  }
}

/**
 * Same effect as the owner command `/mo <external_key>`.
 * Body: { external_key: "fb_…" | "bot_…" | Zalo user id }.
 */
async function kiotSearch(req, res) {
  try {
    if (!kiotviet.enabled()) return res.status(503).json({ error: 'KiotViet chưa cấu hình' });
    const q = String(req.query.q || '').slice(0, 80);
    const products = await kiotviet.searchProducts(q, 8);
    res.json({ products });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Không tìm được sản phẩm' });
  }
}

async function kiotPrefill(req, res) {
  try {
    const result = await kiotInbox.prefill(req.params.id);
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Kiot prefill failed:', e.message);
    res.status(500).json({ error: 'Không mở được đơn' });
  }
}

async function kiotQuick(req, res) {
  try {
    const result = await kiotInbox.quickFill(req.body && req.body.text);
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Kiot quick entry failed:', e.message);
    res.status(500).json({ error: 'Không tách được dòng hàng' });
  }
}

async function kiotCustomer(req, res) {
  const phone = typeof req.query.phone === 'string' ? req.query.phone : '';
  const draftId = typeof req.query.draft_id === 'string' ? req.query.draft_id : '';
  try {
    const draft = draftId ? await drafts.getDraft(draftId) : null;
    const preview = await channelNames.previewPhone(draft, phone);
    res.json(preview);
  } catch (e) {
    console.error('Kiot customer lookup failed:', e.message);
    res.json({ name: '', code: '', id: null, channel_names: [] });
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function publicInvoice(req, res) {
  const code = String(req.params.code || '');
  if (!invoices.verify(code, req.query.t)) {
    return res.status(404).type('html').send('Không thấy hoá đơn');
  }
  try {
    const row = await invoices.getByCode(code);
    if (!row || row.document_type !== 'invoice') {
      return res.status(404).type('html').send('Không thấy hoá đơn');
    }
    const img = `/hd/${encodeURIComponent(row.code)}/anh?t=${encodeURIComponent(invoices.sign(row.code))}`;
    const total = Math.round(row.total).toLocaleString('vi-VN');
    res.type('html').send(`<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(row.code)}</title>
<style>
  body { margin: 0; background: #f6f3ee; color: #1c1712; font: 17px/1.45 "Be Vietnam Pro", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  h1 { color: #0f5a35; font-size: 28px; margin: 0 0 8px; }
  img { width: 100%; height: auto; background: #fff; border-radius: 12px; }
  p { margin: 8px 0; }
</style></head><body><main>
<h1>${escapeHtml(row.code)}</h1>
<p>${escapeHtml(row.customer_name || 'Khách')} · Tổng ${total}đ</p>
<p>VCB 1058437590 · HTX NONG TRAI DOC MO</p>
<p>nội dung CK: ${escapeHtml(row.code)}</p>
<img src="${img}" alt="Hoá đơn ${escapeHtml(row.code)}">
</main></body></html>`);
  } catch (e) {
    console.error('Public invoice failed:', e.message);
    res.status(500).type('html').send('Không mở được hoá đơn');
  }
}

async function publicInvoiceImage(req, res) {
  const code = String(req.params.code || '');
  if (!invoices.verify(code, req.query.t)) return res.status(404).end();
  try {
    const png = await invoices.pngFor(code);
    if (!png) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=60');
    res.type('png').send(png);
  } catch (e) {
    console.error('Invoice image failed:', e.message);
    res.status(500).end();
  }
}

async function invoicesPage(req, res) {
  guard(res);
  if (!auth.passwordConfigured()) return res.status(503).type('html').send(unconfiguredHtml());
  if (!auth.passwordAuthed(req)) return res.status(200).type('html').send(loginHtml(null));
  if (!access.canKiot(await who(req))) return res.status(403).type('html').send('Không đủ quyền');
  const html = await fs.promises.readFile(path.join(PUBLIC, 'invoices.html'), 'utf8');
  res.type('html').send(brand.applyTemplate(html));
}

async function invoicesList(req, res) {
  if (!access.canKiot(await who(req))) return deny(res);
  const rows = await invoices.search({
    q: req.query.q,
    from: req.query.from,
    to: req.query.to,
  });
  res.json({ invoices: rows.map(row => invoices.present(row)) });
}

async function invoicesCsv(req, res) {
  if (!access.canKiot(await who(req))) return deny(res);
  const rows = await invoices.search({
    q: req.query.q,
    from: req.query.from,
    to: req.query.to,
  });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="hoa-don.csv"');
  res.send(invoices.toCsv(rows));
}

async function invoicesPaid(req, res) {
  if (!access.canKiot(await who(req))) return deny(res);
  const amount = req.body && req.body.amount;
  const n = Number(amount);
  if (amount == null || amount === '' || !Number.isFinite(n) || n < 0 || n > 1e12) {
    return res.status(400).json({ error: 'Cần số tiền đã thu' });
  }
  const saved = await invoices.setPayment(req.params.code, n, await auditActor(req), 'manual');
  if (!saved) return res.status(404).json({ error: 'Không thấy hoá đơn' });
  res.json({ invoice: invoices.present(saved) });
}

async function invoicesSync(req, res) {
  if (!access.canKiot(await who(req))) return deny(res);
  const row = await invoices.getByCode(req.params.code);
  if (!row) return res.status(404).json({ error: 'Không thấy hoá đơn' });
  if (row.document_type !== 'invoice') {
    return res.status(400).json({ error: 'Đơn đặt hàng chưa xuất hoá đơn, chưa đồng bộ được thanh toán.' });
  }
  const remote = await kiotviet.readInvoicePayment({ id: row.kiot_id, code: row.code });
  if (!remote || !remote.ok) {
    return res.status(502).json({ error: (remote && remote.error) || 'Không đọc được KiotViet' });
  }
  const saved = await invoices.setPayment(row.code, remote.amount_paid, await auditActor(req), 'kiotviet');
  res.json({ invoice: invoices.present(saved), kiot_status: remote.kiot_status });
}

async function invoicesImage(req, res) {
  if (!access.canKiot(await who(req))) return deny(res);
  try {
    const png = await invoices.pngFor(req.params.code);
    if (!png) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=60');
    res.type('png').send(png);
  } catch (e) {
    console.error('Admin invoice image failed:', e.message);
    res.status(500).end();
  }
}

async function kiotIssue(req, res) {
  try {
    const p = await who(req);
    if (!access.canKiot(p)) return deny(res);
    const existing = await drafts.getDraft(req.params.id);
    if (!existing || !access.canSee(p, existing)) return res.status(404).json({ error: 'Không thấy bản nháp' });
    const result = await kiotInbox.issueInvoice(req.params.id, p && p.source === 'user' ? access.actor(p) : actorNameFrom(req));
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Kiot issue failed:', e.message);
    res.status(500).json({ error: 'Không xuất được hoá đơn' });
  }
}

async function kiotCreate(req, res) {
  try {
    const p = await who(req);
    if (!access.canKiot(p)) return deny(res);
    const existing = await drafts.getDraft(req.params.id);
    if (!existing || !access.canSee(p, existing)) return res.status(404).json({ error: 'Không thấy bản nháp' });
    const discount = req.body && req.body.discount;
    if (!access.canDiscount(p, discount)) return deny(res);
    const result = await kiotInbox.prepareOrCreate(req.params.id, req.body, p && p.source === 'user' ? access.actor(p) : actorNameFrom(req));
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Kiot create failed:', e.message);
    res.status(500).json({ error: 'Không tạo được đơn KiotViet' });
  }
}

async function customerCard(req, res) {
  try {
    const draft = await drafts.getDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Không thấy bản nháp' });
    res.json(await customerLink.viewForDraft(draft));
  } catch (e) {
    console.error('Customer profile failed:', e.message);
    res.status(500).json({ error: 'Không tải được hồ sơ khách' });
  }
}

async function customerLinkSave(req, res) {
  try {
    const draft = await drafts.getDraft(req.body && req.body.draft_id);
    if (!draft) return res.status(404).json({ error: 'Không thấy bản nháp' });
    const phone = db.normalizePhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Số điện thoại chưa đúng' });
    const name = typeof req.body?.name === 'string' ? req.body.name : draft.customer_name;
    const saved = await customerLink.note({
      phone,
      name,
      channel: draft.channel,
      userId: draft.customer_user_id,
    });
    if (!saved) return res.status(400).json({ error: 'Không gắn được hồ sơ' });
    if (draft.customer_phone !== phone) {
      await drafts.updateDraft(draft.id, { customer_phone: phone, customer_name: name || draft.customer_name }, {
        actorName: actorNameFrom(req),
      });
    }
    await audit.record({
      actor: audit.managerActor(actorNameFrom(req)),
      action: 'customer.linked',
      entity_type: 'customer',
      entity_id: phone,
      after: customerLink.present(saved),
      meta: { draft_id: draft.id, channel: draft.channel },
    });
    const fresh = await drafts.getDraft(draft.id);
    res.json(await customerLink.viewForDraft(fresh || draft));
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không gắn được hồ sơ' });
  }
}

async function customerUnlink(req, res) {
  try {
    const phone = db.normalizePhone(req.body && req.body.phone);
    const channel = String((req.body && req.body.channel) || '');
    if (!phone) return res.status(400).json({ error: 'Số điện thoại chưa đúng' });
    if (!['zalo', 'messenger', 'kiot'].includes(channel)) {
      return res.status(400).json({ error: 'Kênh không hợp lệ' });
    }
    const saved = await customerLink.unlink({ phone, channel });
    if (!saved) return res.status(404).json({ error: 'Không thấy hồ sơ' });
    await audit.record({
      actor: audit.managerActor(actorNameFrom(req)),
      action: 'customer.unlinked',
      entity_type: 'customer',
      entity_id: phone,
      after: { ...customerLink.present(saved), removed: channel },
    });
    res.json({ profile: customerLink.present(saved) });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không gỡ được hồ sơ' });
  }
}

async function resumeCustomer(req, res) {
  const raw = req.body && req.body.external_key;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return res.status(400).json({ error: 'Thiếu external_key' });
  if (key.length > 200) return res.status(400).json({ error: 'external_key quá dài' });
  try {
    const customer = await db.getCustomerByExternalId(key);
    if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách' });
    const resumed = await db.resumeBot(customer.id);
    if (!resumed) return res.status(503).json({ error: 'Chưa có database để mở lại bot' });
    res.json({
      ok: true,
      external_key: key,
      customer_id: customer.id,
      display_name: customer.display_name || null,
      bot_paused: false,
    });
  } catch (e) {
    console.error('Resume customer failed:', e.message);
    res.status(500).json({ error: 'Không mở lại được bot' });
  }
}

function roleOptions(selected) {
  return ['manager', 'sale', 'dv'].map(role =>
    `<option value="${role}"${role === selected ? ' selected' : ''}>${role}</option>`
  ).join('');
}

function usersHtml(data, error) {
  const rows = (data.users || []).map(user =>
    `<tr>
      <td>${esc(user.display_name || user.username)}<br><small>${esc(user.username)}</small></td>
      <td>${user.disabled ? 'khóa' : 'mở'}</td>
      <td>
        <form method="post" action="/admin/users">
          <input type="hidden" name="action" value="role">
          <input type="hidden" name="id" value="${esc(user.id)}">
          <select name="role">${roleOptions(user.role)}</select>
          <button type="submit">Lưu vai trò</button>
        </form>
      </td>
      <td>
        <form method="post" action="/admin/users">
          <input type="hidden" name="action" value="password">
          <input type="hidden" name="id" value="${esc(user.id)}">
          <input type="password" name="password" minlength="8" placeholder="Mật khẩu mới" required>
          <button type="submit">Đổi mật khẩu</button>
        </form>
      </td>
      <td>
        <form method="post" action="/admin/users">
          <input type="hidden" name="action" value="disable">
          <input type="hidden" name="id" value="${esc(user.id)}">
          <input type="hidden" name="disabled" value="${user.disabled ? '0' : '1'}">
          <button type="submit">${user.disabled ? 'Mở khóa' : 'Khóa'}</button>
        </form>
      </td>
    </tr>`
  ).join('');
  return brand.applyTemplate(`<!doctype html><html lang="vi"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0f5a35">
  <title>Người dùng — {{PRODUCT_NAME}}</title>
  <link rel="stylesheet" href="/admin/review.css"></head><body class="hitl"><div class="wrap">
  <p><a href="/admin">← Hàng chờ</a></p>
  <p class="brand">{{PRODUCT_NAME}} {{VERSION_LABEL}}</p>
  <h1>Người dùng</h1>
  ${error ? `<p>${esc(error)}</p>` : ''}
  <p>Duyệt &amp; Gửi cho sale/dv: <b>${data.staffCanSend ? 'bật' : 'tắt (chỉ quản lý)'}</b>. Giảm giá sale tối đa ${data.discountLimit}đ. Hoàn tiền, khiếu nại, xóa, và giảm giá lớn vẫn chỉ quản lý.</p>
  <form method="post" action="/admin/users">
    <input type="hidden" name="action" value="send-policy">
    <button type="submit">${data.staffCanSend ? 'Chỉ quản lý được gửi' : 'Cho sale/dv gửi tin thường'}</button>
  </form>
  <form method="post" action="/admin/users">
    <input type="hidden" name="action" value="create">
    <input name="username" placeholder="Tên đăng nhập" required maxlength="40">
    <input name="display_name" placeholder="Tên hiển thị" maxlength="80">
    <input type="password" name="password" placeholder="Mật khẩu" required minlength="8">
    <select name="role"><option value="sale">sale</option><option value="dv">dv</option><option value="manager">manager</option></select>
    <button type="submit">Thêm</button>
  </form>
  <table><thead><tr><th>Tên</th><th>Trạng thái</th><th>Vai trò</th><th>Mật khẩu</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  </div></body></html>`);
}

async function usersView(req, res) {
  guard(res);
  if (!auth.passwordAuthed(req)) return res.redirect(303, '/admin');
  if (!access.canManageUsers(await who(req))) return res.status(403).type('html').send('Không đủ quyền');
  const users = await adminUsers.list();
  res.type('html').send(usersHtml({
    users,
    staffCanSend: await adminUsers.staffCanSend(),
    discountLimit: access.discountLimit(),
  }, typeof req.query.err === 'string' ? req.query.err : ''));
}

async function usersSave(req, res) {
  guard(res);
  if (badOrigin(req)) return res.status(403).type('text/plain').send('Forbidden');
  if (!auth.passwordAuthed(req)) return res.status(401).type('text/plain').send('Unauthorized');
  if (!access.canManageUsers(await who(req))) return res.status(403).type('text/plain').send('Không đủ quyền');
  try {
    const action = String(req.body?.action || '');
    const actor = await auditActor(req);
    if (action === 'send-policy') {
      const next = !(await adminUsers.staffCanSend());
      await adminUsers.setStaffCanSend(next);
      await audit.record({
        actor,
        action: 'admin.send_policy',
        entity_type: 'admin_user',
        entity_id: 'staff_can_send',
        after: { staff_can_send: next },
      });
    } else if (action === 'create') {
      const created = await adminUsers.create({
        username: req.body?.username,
        password: req.body?.password,
        role: req.body?.role,
        display_name: req.body?.display_name,
      });
      await audit.record({
        actor,
        action: 'admin.user_created',
        entity_type: 'admin_user',
        entity_id: created.id,
        after: { username: created.username, role: created.role },
      });
    } else if (action === 'role') {
      const updated = await adminUsers.setRole(req.body?.id, req.body?.role);
      if (!updated) throw Object.assign(new Error('Không thấy người dùng'), { status: 404 });
      await audit.record({
        actor,
        action: 'admin.user_role',
        entity_type: 'admin_user',
        entity_id: updated.id,
        after: { username: updated.username, role: updated.role },
      });
    } else if (action === 'disable') {
      const off = String(req.body?.disabled || '') === '1';
      const updated = await adminUsers.setDisabled(req.body?.id, off);
      if (!updated) throw Object.assign(new Error('Không thấy người dùng'), { status: 404 });
      await audit.record({
        actor,
        action: 'admin.user_disabled',
        entity_type: 'admin_user',
        entity_id: updated.id,
        after: { username: updated.username, disabled: updated.disabled },
      });
    } else if (action === 'password') {
      const updated = await adminUsers.setPassword(req.body?.id, req.body?.password);
      if (!updated) throw Object.assign(new Error('Không thấy người dùng'), { status: 404 });
      await audit.record({
        actor,
        action: 'admin.user_password',
        entity_type: 'admin_user',
        entity_id: updated.id,
        after: { username: updated.username },
      });
    }
    res.redirect(303, '/admin/users');
  } catch (e) {
    res.redirect(303, '/admin/users?err=' + encodeURIComponent(e.message || 'Không lưu được'));
  }
}

function mount(app) {
  app.post('/admin/login', login);
  app.post('/admin/logout', logout);
  app.get('/admin/roster', rosterView);
  app.post('/admin/roster', rosterSave);
  app.get('/admin/users', usersView);
  app.post('/admin/users', usersSave);
  app.get('/admin/api/session', requireApi, async (req, res) => {
    const p = await who(req);
    if (!p) return res.status(401).json({ error: 'Chưa đăng nhập' });
    res.json(await access.sessionPayload(p));
  });
  app.get('/admin/review.css', requirePageAsset, sendAsset('review.css', 'text/css; charset=utf-8'));
  app.get('/admin/inbox-refresh.js', requirePageAsset, sendAsset('inbox-refresh.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/inbox-order.js', requirePageAsset, sendAsset('inbox-order.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/kiot-picker.js', requirePageAsset, sendAsset('kiot-picker.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/review.js', requirePageAsset, sendAsset('review.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/audit.js', requirePageAsset, sendAsset('audit.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/invoices.css', requirePageAsset, sendAsset('invoices.css', 'text/css; charset=utf-8'));
  app.get('/admin/invoices.js', requirePageAsset, sendAsset('invoices.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/invoices', invoicesPage);
  app.get('/admin/api/invoices.csv', requireApi, invoicesCsv);
  app.get('/admin/api/invoices', requireApi, invoicesList);
  app.get('/admin/api/invoices/:code/anh', requireApi, invoicesImage);
  app.post('/admin/api/invoices/:code/paid', requireApi, invoicesPaid);
  app.post('/admin/api/invoices/:code/sync', requireApi, invoicesSync);
  app.get('/hd/:code/anh', publicInvoiceImage);
  app.get('/hd/:code', publicInvoice);
  app.get('/admin/audit', auditPage);
  app.get('/admin/api/audit', requireApi, listAudit);
  app.get('/admin/api/channels', requireApi, channels);
  app.post('/admin/api/channels', requireApi, createChannel);
  app.get('/admin/api/stats', requireApi, stats);
  app.get('/admin/api/health', requireApi, (req, res) => {
    res.json(require('./healthWatch').adminView());
  });
  app.get('/admin/api/drafts', requireApi, list);
  app.post('/admin/api/drafts', requireApi, create);
  app.patch('/admin/api/drafts/:id', requireApi, patch);
  app.post('/admin/api/drafts/:id/biz-line', requireApi, moveLine);
  app.post('/admin/api/drafts/:id/delete', requireApi, removeDraft);
  app.post('/admin/api/drafts/:id/restore', requireApi, restoreOne);
  app.post('/admin/api/inbox/sync', requireApi, syncInbox);
  app.post('/admin/api/drafts/:id/folder', requireApi, setFolder);
  app.get('/admin/api/kiotviet/products', requireApi, kiotSearch);
  app.get('/admin/api/kiotviet/customer', requireApi, kiotCustomer);
  app.post('/admin/api/kiotviet/quick-entry', requireApi, kiotQuick);
  app.get('/admin/api/drafts/:id/kiotviet', requireApi, kiotPrefill);
  app.post('/admin/api/drafts/:id/kiotviet', requireApi, kiotCreate);
  app.post('/admin/api/drafts/:id/kiotviet/invoice', requireApi, kiotIssue);
  app.post('/admin/api/customers/resume', requireApi, resumeCustomer);
  app.get('/admin/api/drafts/:id/customer', requireApi, customerCard);
  app.post('/admin/api/customers/link', requireApi, customerLinkSave);
  app.post('/admin/api/customers/unlink', requireApi, customerUnlink);
}

function fallback(req, res) {
  guard(res);
  if (!auth.passwordConfigured()) {
    return res.status(503).type('text/plain').send('ADMIN_PASSWORD is not configured');
  }
  if (!auth.isAuthed(req)) return res.status(401).type('text/plain').send('Unauthorized');
  return res.status(404).type('text/plain').send('Not found');
}

module.exports = { mount, page, fallback };
