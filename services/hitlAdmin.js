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
const roster = require('./roster');
const handover = require('./handover');
const rosterPage = require('./rosterPage');
const brand = require('./brand');

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
           min-height:48px; border:0; border-radius:12px; background:#2f6b45; color:#fff; cursor:pointer; }
  .err { color:#8d2f2f; font-weight:700; }
  input:focus-visible, button:focus-visible { outline:2px solid #2f6b45; outline-offset:2px; }
`;

function loginHtml(error) {
  return brand.applyTemplate(`<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#3f6b4c">
<title>Đăng nhập — {{PRODUCT_NAME}}</title>
<style>${GATE_CSS}</style>
</head>
<body>
  <form class="login" method="post" action="/admin/login">
    <h1><span id="product-name">{{PRODUCT_NAME}}</span> <span class="ver" id="app-version">{{VERSION_LABEL}}</span></h1>
    <p class="sub">Duyệt tin nội bộ. Nhập mật khẩu quản trị để xem bản nháp trước khi gửi.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <label>Mật khẩu
      <input type="password" name="password" autocomplete="current-password" autofocus required maxlength="200">
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

function requireApi(req, res, next) {
  guard(res);
  if (badOrigin(req)) return res.status(403).json({ error: 'Yêu cầu khác trang bị chặn' });
  if (!auth.passwordConfigured()) {
    return res.status(503).json({ error: 'Chưa cấu hình ADMIN_PASSWORD' });
  }
  if (!auth.isAuthed(req)) {
    res.set('WWW-Authenticate', `Basic realm="${brand.PRODUCT_NAME}", charset="UTF-8"`);
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }
  next();
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
  const html = await fs.promises.readFile(path.join(PUBLIC, 'review.html'), 'utf8');
  res.type('html').send(brand.applyTemplate(html));
}

function login(req, res) {
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

async function list(req, res) {
  try {
    const q = req.query || {};
    res.json(await drafts.listDrafts({
      status: typeof q.status === 'string' && q.status ? q.status : null,
      ops: typeof q.ops === 'string' && q.ops ? q.ops : null,
      type: typeof q.type === 'string' && q.type ? q.type : null,
      salesChannel: typeof q.kenh === 'string' && q.kenh ? q.kenh : null,
      triage: typeof q.triage === 'string' && q.triage ? q.triage : null,
      platform: typeof q.platform === 'string' && q.platform ? q.platform : null,
      nhom: typeof q.nhom === 'string' && q.nhom ? q.nhom : null,
      zline: typeof q.zline === 'string' && q.zline ? q.zline : null,
      hop: typeof q.hop === 'string' && q.hop ? q.hop : null,
    }));
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
    const channel = await drafts.addChannel(req.body && req.body.name);
    res.status(201).json({ channel });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Không thêm được kênh' });
  }
}

async function create(req, res) {
  try {
    const draft = await drafts.createDraft(req.body, {
      actor: audit.managerActor(actorNameFrom(req)),
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
    const draft = await drafts.moveBizLine(req.params.id, req.body && req.body.biz_line, {
      actor: audit.managerActor(actorNameFrom(req)),
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
    const draft = await drafts.softDelete(req.params.id, {
      actor: audit.managerActor(actorNameFrom(req)),
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
    const draft = await drafts.restoreDraft(req.params.id, {
      actor: audit.managerActor(actorNameFrom(req)),
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
    const draft = await drafts.setInboxStatus(req.params.id, req.body && req.body.inbox_status, {
      actor: audit.managerActor(actorNameFrom(req)),
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
    const result = await drafts.updateDraft(req.params.id, req.body, {
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
  const html = await fs.promises.readFile(path.join(PUBLIC, 'audit.html'), 'utf8');
  res.type('html').send(html);
}

async function rosterView(req, res) {
  guard(res);
  if (!auth.passwordConfigured()) {
    return res.status(503).type('html').send(unconfiguredHtml());
  }
  if (!auth.passwordAuthed(req)) return res.redirect(303, '/admin');
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
    const products = await kiotviet.searchProducts(q);
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

async function kiotCreate(req, res) {
  try {
    const result = await kiotInbox.prepareOrCreate(req.params.id, req.body, actorNameFrom(req));
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('Kiot create failed:', e.message);
    res.status(500).json({ error: 'Không tạo được đơn KiotViet' });
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

function mount(app) {
  app.post('/admin/login', login);
  app.post('/admin/logout', logout);
  app.get('/admin/roster', rosterView);
  app.post('/admin/roster', rosterSave);
  app.get('/admin/review.css', requirePageAsset, sendAsset('review.css', 'text/css; charset=utf-8'));
  app.get('/admin/review.js', requirePageAsset, sendAsset('review.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/audit.js', requirePageAsset, sendAsset('audit.js', 'text/javascript; charset=utf-8'));
  app.get('/admin/audit', auditPage);
  app.get('/admin/api/audit', requireApi, listAudit);
  app.get('/admin/api/channels', requireApi, channels);
  app.post('/admin/api/channels', requireApi, createChannel);
  app.get('/admin/api/stats', requireApi, stats);
  app.get('/admin/api/drafts', requireApi, list);
  app.post('/admin/api/drafts', requireApi, create);
  app.patch('/admin/api/drafts/:id', requireApi, patch);
  app.post('/admin/api/drafts/:id/biz-line', requireApi, moveLine);
  app.post('/admin/api/drafts/:id/delete', requireApi, removeDraft);
  app.post('/admin/api/drafts/:id/restore', requireApi, restoreOne);
  app.post('/admin/api/inbox/sync', requireApi, syncInbox);
  app.post('/admin/api/drafts/:id/folder', requireApi, setFolder);
  app.get('/admin/api/kiotviet/products', requireApi, kiotSearch);
  app.post('/admin/api/kiotviet/quick-entry', requireApi, kiotQuick);
  app.get('/admin/api/drafts/:id/kiotviet', requireApi, kiotPrefill);
  app.post('/admin/api/drafts/:id/kiotviet', requireApi, kiotCreate);
  app.post('/admin/api/customers/resume', requireApi, resumeCustomer);
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
