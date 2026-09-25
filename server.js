require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const zaloService = require('./services/zaloService');
const botService  = require('./services/zaloBotService');
const db          = require('./services/database');
const aiAgent     = require('./services/aiAgent');
const faqService  = require('./services/faqService');
const selfCheck   = require('./services/selfCheck');
const pipeline    = require('./services/pipeline');
const notify      = require('./services/notify');
const ops         = require('./services/ops');
const adminPage   = require('./services/adminPage');
const catalog     = require('./services/catalog');
const knowledge   = require('./services/knowledge');
const state       = require('./services/state');
const faqPage     = require('./services/faqPage');
const rewrite     = require('./services/rewrite');
const followup    = require('./services/followup');
const shipping    = require('./services/shipping');
const hitlAdmin   = require('./services/hitlAdmin');
const hitl        = require('./services/hitlGate');
const confidenceGate = require('./services/confidenceGate');
const audit       = require('./services/audit');
const messenger   = require('./services/messenger');

const app  = express();
const PORT = process.env.PORT || 3000;

// Meta signs the raw POST bytes. Capture them before express.json, which
// skips any content type that is not JSON and would leave rawBody empty.
// express.raw runs only on this route, consumes the stream, and tags the
// buffer as capture_raw. The global JSON parser then sees a finished
// request and does not read or decode it. Its verify hook fills rawBody
// only when capture did not (tests, or a parser skip) and tags verify_hook.
app.use('/messenger/webhook', messenger.captureRawBody);
app.use(express.json({
  verify: (req, _res, buf) => {
    if (!Buffer.isBuffer(req.rawBody)) {
      req.rawBody = buf;
      req.messengerRawSource = 'verify_hook';
    }
  },
}));
app.use(express.urlencoded({ extended: false })); // admin form posts
app.set('trust proxy', 1);

// The Zalo verifier file stays public. Everything under /admin is gated
// separately (draft review by ADMIN_PASSWORD, the older dashboard by ?key=).
const publicStatic = express.static('public');
app.use((req, res, next) => {
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  return publicStatic(req, res, next);
});

hitlAdmin.mount(app);

// Boot: migrate, then restore the Zalo tokens the previous run may have rotated.
db.initDB()
  .then(() => zaloService.loadTokens())
  .then(() => zaloService.startTokenRefresh())
  .then(() => ops.pruneEvents(3))
  .then(() => catalog.refresh())
  .then(() => knowledge.refreshTaught())
  .then(() => shipping.refresh())
  .then(() => promo.refresh())
  .catch(err => console.error('Startup error:', err));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Doc Mo Farm AI Agent',
    version: '3.0',
    channels: {
      oa_webhook: '/webhook',
      bot_webhook: '/bot/webhook',
      bot_enabled: !!process.env.ZALO_BOT_TOKEN,
      messenger_webhook: '/messenger/webhook',
      messenger_enabled: messenger.enabled(),
    },
  });
});

// ============================================================
// ZALO OAUTH — one-click token grant
// 1. OA admin opens GET /zalo/oauth/login  → redirected to Zalo
// 2. Grants permission → Zalo calls /zalo/oauth/callback?code=...
// 3. Server exchanges code for access+refresh tokens, activates them
// ============================================================
const OAUTH_CALLBACK = 'https://docmofarm.com/zalo/oauth/callback';

app.get('/zalo/oauth/login', (req, res) => {
  const url =
    'https://oauth.zaloapp.com/v4/oa/permission' +
    `?app_id=${process.env.ZALO_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}` +
    '&state=dmf_setup';
  res.redirect(url);
});

app.get('/zalo/oauth/callback', async (req, res) => {
  const { code, oa_id } = req.query;
  if (!code) return res.status(400).send('Missing ?code from Zalo. Grant may have failed.');
  try {
    const axios = require('axios');
    const r = await axios.post(
      'https://oauth.zaloapp.com/v4/oa/access_token',
      new URLSearchParams({
        code,
        app_id: process.env.ZALO_APP_ID,
        grant_type: 'authorization_code',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          secret_key: process.env.ZALO_APP_SECRET,
        },
      }
    );
    if (!r.data?.access_token) {
      console.error('OAuth exchange failed:', r.data);
      return res.status(500).send('<h2>❌ Token exchange failed</h2><pre>' + JSON.stringify(r.data, null, 2) + '</pre>');
    }
    zaloService.setTokens(r.data.access_token, r.data.refresh_token);
    console.log('✅ New Zalo tokens activated via OAuth (oa_id:', oa_id, ')');
    res.send(`
      <h2>✅ Bot connected to Zalo OA thành công!</h2>
      <p>Tokens are active NOW (in memory). To survive server restarts, copy these into Railway → Variables:</p>
      <p><b>ZALO_ACCESS_TOKEN</b></p><textarea rows="5" cols="80">${r.data.access_token}</textarea>
      <p><b>ZALO_REFRESH_TOKEN</b></p><textarea rows="5" cols="80">${r.data.refresh_token}</textarea>
    `);
  } catch (e) {
    console.error('OAuth callback error:', e.response?.data || e.message);
    res.status(500).send('<h2>❌ OAuth error</h2><pre>' + JSON.stringify(e.response?.data || e.message, null, 2) + '</pre>');
  }
});

// GET /debug/tokens?key=... — current in-memory tokens (for Railway env sync)
app.get('/debug/tokens', (req, res) => {
  if (!debugAuth(req, res)) return;
  res.json(zaloService.getTokens());
});

// ============================================================
// ZALO WEBHOOK — Verification (GET)
// ============================================================
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.ZALO_WEBHOOK_TOKEN) {
    console.log('✓ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(mode && token ? 403 : 400);
});

// ============================================================
// DEBUG — ring buffer of recent webhook events + outcomes
// ============================================================
const lastEvents = [];
function logEvent(entry) {
  lastEvents.push({ at: new Date().toISOString(), ...entry });
  while (lastEvents.length > 30) lastEvents.shift();
}

function debugAuth(req, res) {
  if (req.query.key !== process.env.ZALO_WEBHOOK_TOKEN) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// GET /debug/events?key=... — recent webhook activity
app.get('/debug/events', (req, res) => {
  if (!debugAuth(req, res)) return;
  res.json({ count: lastEvents.length, events: lastEvents });
});

// GET /debug/test-ai?key=...&text=... — test Claude pipeline only
app.get('/debug/test-ai', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    const result = await aiAgent.respond('debug_user', req.query.text || 'Xin chào');
    const low = confidenceGate.isLow(result.confidence);
    res.json({
      ok: true,
      reply: low ? confidenceGate.WAITING_REPLY : result.text,
      tokensUsed: result.tokensUsed,
      confidence: result.confidence,
      needs_human: low,
      ticket_status: low ? confidenceGate.TICKET_STATUS : null,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
  }
});

// GET /debug/test-send?key=...&uid=...&text=... — test Zalo send only
app.get('/debug/test-send', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    const result = await zaloService.sendTextMessage(req.query.uid, req.query.text || 'Test từ Dốc Mơ Farm bot 🌿');
    res.json({ ok: !!result, zalo_response: result, last_error: zaloService.getLastError() });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /admin?key=<ZALO_WEBHOOK_TOKEN> — existing farm dashboard (giá, đơn, FAQ).
// GET /admin — password-gated HITL draft review (ADMIN_PASSWORD). Never public.
app.get('/admin', async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.query, 'key')) {
    if (!process.env.ZALO_WEBHOOK_TOKEN || req.query.key !== process.env.ZALO_WEBHOOK_TOKEN) {
      return res.status(403).send('Forbidden');
    }
    try {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('X-Robots-Tag', 'noindex, nofollow');
      res.send(await adminPage.render(req.query.key, req.query.ok || null));
    } catch (e) {
      res.status(500).send(`<pre>${e.message}</pre>`);
    }
    return;
  }
  try {
    await hitlAdmin.page(req, res);
  } catch (e) {
    console.error('HITL page failed:', e.message);
    res.status(500).type('text/plain').send('Không mở được trang duyệt');
  }
});

// POST /admin/product — create or update one product, then back to the page.
app.post('/admin/product', async (req, res) => {
  const key = req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) return res.status(403).send('Forbidden');

  // Land back on the section that was edited, not the top of the page.
  const back = (msg) => res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent(msg)}#gia`);
  try {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const available = req.body.is_available === 'on';

    if (req.body.id) {
      await db.pool.query(
        `UPDATE products SET name_vi=$2, base_price=$3, sale_price=$4, unit=$5,
                             stock_qty=$6, is_available=$7, updated_at=NOW()
         WHERE id=$1`,
        [req.body.id, req.body.name_vi, num(req.body.base_price), num(req.body.sale_price),
         req.body.unit || 'cái', num(req.body.stock_qty) ?? 0, available]
      );
      await catalog.refresh();
      return back(`Đã lưu "${req.body.name_vi}"`);
    }

    await db.pool.query(
      `INSERT INTO products (sku, name, name_vi, category, base_price, unit, stock_qty, is_available)
       VALUES ($1,$2,$2,'general',$3,$4,$5,TRUE)`,
      [req.body.sku, req.body.name_vi, num(req.body.base_price),
       req.body.unit || 'cái', num(req.body.stock_qty) ?? 0]
    );
    await catalog.refresh();
    return back(`Đã thêm "${req.body.name_vi}"`);
  } catch (e) {
    return back(`Lỗi: ${e.message}`);
  }
});

// ============================================================
// FAQ WORKBENCH
// ============================================================
const faqAuth = (req, res) => {
  const key = req.query.key || req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) { res.status(403).send('Forbidden'); return null; }
  return key;
};

app.get('/faq', async (req, res) => {
  const key = faqAuth(req, res); if (!key) return;
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.send(await faqPage.render(key, { flash: req.query.ok || null }));
  } catch (e) {
    res.status(500).send(`<pre>${e.message}</pre>`);
  }
});

// POST /faq/save — create, update or delete one FAQ entry.
app.post('/faq/save', async (req, res) => {
  const key = faqAuth(req, res); if (!key) return;
  const back = (msg) => res.redirect(`/faq?key=${encodeURIComponent(key)}&ok=${encodeURIComponent(msg)}`);
  try {
    const { id, question, answer, product } = req.body;
    const active = req.body.is_active === 'on';

    if (id && req.body.delete) {
      await db.pool.query('DELETE FROM bot_lessons WHERE id=$1', [id]);
      await knowledge.refreshTaught();
      return back('Đã xoá câu hỏi');
    }
    if (!question?.trim() || !answer?.trim()) return back('Thiếu câu hỏi hoặc câu trả lời');

    if (id) {
      await db.pool.query(
        `UPDATE bot_lessons SET question=$2, answer=$3, product=$4, is_active=$5, updated_at=NOW()
         WHERE id=$1`,
        [id, question.trim(), answer.trim(), product || 'Chung', active]
      );
    } else {
      await db.pool.query(
        'INSERT INTO bot_lessons (question, answer, product) VALUES ($1,$2,$3)',
        [question.trim(), answer.trim(), product || 'Chung']
      );
    }
    await knowledge.refreshTaught();
    return back('Đã lưu');
  } catch (e) {
    return back(`Lỗi: ${e.message}`);
  }
});

// POST /faq/rewrite — propose a Thu-voice version. Saves nothing: the farm
// reads the proposal beside the original and decides.
app.post('/faq/rewrite', async (req, res) => {
  const key = faqAuth(req, res); if (!key) return;
  try {
    const { id, question, answer } = req.body;
    const result = await rewrite.toThuVoice(answer, question);
    if (!result.ok) {
      return res.redirect(`/faq?key=${encodeURIComponent(key)}&ok=${encodeURIComponent('Viết lại thất bại: ' + result.error)}`);
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(await faqPage.render(key, {
      proposal: { id, text: result.text, tokens: result.tokens, warnings: result.warnings },
    }));
  } catch (e) {
    res.redirect(`/faq?key=${encodeURIComponent(key)}&ok=${encodeURIComponent('Lỗi: ' + e.message)}`);
  }
});

// POST /admin/lesson — teach, edit or delete one canned answer.
app.post('/admin/lesson', async (req, res) => {
  const key = req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) return res.status(403).send('Forbidden');
  const back = (msg) => res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent(msg)}#caumau`);
  try {
    const { id, question, answer } = req.body;
    const active = req.body.is_active === 'on';

    if (id && req.body.delete) {
      await db.pool.query('DELETE FROM bot_lessons WHERE id=$1', [id]);
      await knowledge.refreshTaught();
      return back('Đã xoá câu mẫu');
    }
    if (!question?.trim() || !answer?.trim()) return back('Thiếu câu hỏi hoặc câu trả lời');

    if (id) {
      await db.pool.query(
        'UPDATE bot_lessons SET question=$2, answer=$3, is_active=$4, updated_at=NOW() WHERE id=$1',
        [id, question.trim(), answer.trim(), active]
      );
    } else {
      await db.pool.query(
        'INSERT INTO bot_lessons (question, answer) VALUES ($1,$2)',
        [question.trim(), answer.trim()]
      );
    }
    await knowledge.refreshTaught();
    return back('Đã dạy bot câu này');
  } catch (e) {
    return back(`Lỗi: ${e.message}`);
  }
});

// POST /admin/shipping — add, edit or remove one delivery zone.
app.post('/admin/shipping', async (req, res) => {
  const key = req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) return res.status(403).send('Forbidden');
  const back = (msg) =>
    res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent(msg)}#giaohang`);
  try {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const active = req.body.is_active === 'on';

    if (req.body.id && req.body.delete) {
      await db.pool.query('DELETE FROM shipping_zones WHERE id=$1', [req.body.id]);
      await shipping.refresh();
      return back('Đã xoá khu vực');
    }
    if (!req.body.name?.trim()) return back('Thiếu tên khu vực');

    if (req.body.id) {
      await db.pool.query(
        `UPDATE shipping_zones SET name=$2, keywords=$3, fee=$4, free_from=$5,
                                   eta=$6, is_active=$7, updated_at=NOW()
         WHERE id=$1`,
        [req.body.id, req.body.name.trim(), req.body.keywords || null,
         num(req.body.fee) ?? 0, num(req.body.free_from), req.body.eta || null, active]
      );
    } else {
      await db.pool.query(
        `INSERT INTO shipping_zones (name, keywords, fee, free_from, eta)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.body.name.trim(), req.body.keywords || null,
         num(req.body.fee) ?? 0, num(req.body.free_from), req.body.eta || null]
      );
    }
    await shipping.refresh();
    return back('Đã lưu khu vực giao hàng');
  } catch (e) {
    return back(`Lỗi: ${e.message}`);
  }
});

// POST /admin/promo — thêm, sửa hoặc xoá một chương trình khuyến mãi.
// Không có sku là chính sách chung; có sku là khuyến mãi của riêng món đó.
app.post('/admin/promo', async (req, res) => {
  const key = req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) return res.status(403).send('Forbidden');
  const back = (msg) =>
    res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent(msg)}#khuyenmai`);
  try {
    const day = (v) => (v && String(v).trim() ? String(v).trim() : null);
    const sku = req.body.sku && String(req.body.sku).trim() ? String(req.body.sku).trim() : null;

    if (req.body.id && req.body.delete) {
      await db.pool.query('DELETE FROM promotions WHERE id=$1', [req.body.id]);
      await promo.refresh();
      return back('Đã xoá khuyến mãi');
    }
    if (!req.body.title?.trim())  return back('Thiếu tên chương trình');
    if (!req.body.detail?.trim()) return back('Thiếu câu bot nói với khách');

    if (req.body.id) {
      await db.pool.query(
        `UPDATE promotions SET sku=$2, title=$3, detail=$4, starts_on=$5, ends_on=$6,
                               is_active=$7, updated_at=NOW()
         WHERE id=$1`,
        [req.body.id, sku, req.body.title.trim(), req.body.detail.trim(),
         day(req.body.starts_on), day(req.body.ends_on), req.body.is_active === 'on']
      );
    } else {
      await db.pool.query(
        `INSERT INTO promotions (sku, title, detail, starts_on, ends_on)
         VALUES ($1,$2,$3,$4,$5)`,
        [sku, req.body.title.trim(), req.body.detail.trim(),
         day(req.body.starts_on), day(req.body.ends_on)]
      );
    }
    await promo.refresh();
    return back('Đã lưu khuyến mãi');
  } catch (e) {
    return back(`Lỗi: ${e.message}`);
  }
});

// POST /admin/rules — house rules, or the delivery terms block.
app.post('/admin/rules', async (req, res) => {
  const key = req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) return res.status(403).send('Forbidden');
  try {
    // The same form handles two different text blocks; `which` says so.
    const target = req.body.which === 'shipping_terms' ? 'shipping_terms' : 'bot_rules';
    await state.set(target, String(req.body.rules || '').slice(0, 4000));
    if (target === 'shipping_terms') await shipping.refresh();
    await knowledge.refreshTaught();
    res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent('Đã lưu quy tắc')}`);
  } catch (e) {
    res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent('Lỗi: ' + e.message)}`);
  }
});

// POST /admin/order — change an order's status.
app.post('/admin/order', async (req, res) => {
  const key = req.body.key;
  if (key !== process.env.ZALO_WEBHOOK_TOKEN) return res.status(403).send('Forbidden');
  try {
    const prev = await db.pool.query(
      'SELECT order_number, status, customer_id FROM orders WHERE id=$1',
      [req.body.id]
    );
    const before = prev.rows[0];
    const r = await db.pool.query(
      'UPDATE orders SET status=$2, updated_at=NOW() WHERE id=$1 RETURNING order_number, customer_id, status',
      [req.body.id, req.body.status]
    );
    const row = r.rows[0];
    if (row) await db.updateCustomerLtv(row.customer_id).catch(() => {});
    if (before && row && before.status !== row.status) {
      await audit.record({
        actor: audit.staffActor(req.body.staff_name),
        action: audit.orderStatusAction(row.status),
        entity_type: 'order',
        entity_id: String(row.order_number),
        before: { status: before.status },
        after: { status: row.status, order_number: row.order_number },
        meta: {
          order_number: String(row.order_number),
          customer_id: row.customer_id,
          source: 'admin',
        },
      });
    }
    res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent(
      `Đơn ${row ? row.order_number : ''} → ${req.body.status}`)}`);
  } catch (e) {
    res.redirect(`/admin?key=${encodeURIComponent(key)}&ok=${encodeURIComponent('Lỗi: ' + e.message)}`);
  }
});

// GET /debug/identity?key=...&id=<any channel key> — see a customer's linked channels
app.get('/debug/identity', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    const customer = await db.getCustomerByExternalId(req.query.id);
    if (!customer) return res.json({ found: false });
    const identities = await db.getIdentities(customer.id);
    const msgs = await db.pool.query(
      'SELECT COUNT(*)::int AS n FROM messages WHERE customer_id=$1',
      [customer.id]
    );
    res.json({
      found: true,
      customer: { id: customer.id, name: customer.display_name, phone: customer.phone, tier: customer.customer_tier },
      identities,
      message_count: msgs.rows[0].n,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /debug/merge?key=...&phone=... — force the phone-merge and surface any error
app.get('/debug/merge', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    const phone = db.normalizePhone(req.query.phone);
    if (!phone) return res.json({ ok: false, error: 'bad phone' });
    const rows = await db.pool.query(
      'SELECT id, zalo_user_id, first_seen_at FROM customers WHERE phone=$1 ORDER BY first_seen_at ASC',
      [phone]
    );
    if (rows.rows.length < 2) {
      return res.json({ ok: true, merged: false, reason: 'only one customer with that phone', rows: rows.rows });
    }
    const survivor = rows.rows[0].id;
    const merged = [];
    for (const r of rows.rows.slice(1)) {
      await db.mergeCustomers(survivor, r.id, 'phone-manual');
      merged.push(r.id);
    }
    const identities = await db.getIdentities(survivor);
    res.json({ ok: true, merged: true, survivor, absorbed: merged, identities });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) });
  }
});

// GET /debug/merge-all?key=... — merge every set of customers sharing a phone
app.get('/debug/merge-all', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    const groups = await db.pool.query(
      `SELECT phone, COUNT(*)::int AS n FROM customers
       WHERE phone IS NOT NULL AND phone <> ''
       GROUP BY phone HAVING COUNT(*) > 1`
    );
    const results = [];
    for (const g of groups.rows) {
      const rows = await db.pool.query(
        'SELECT id FROM customers WHERE phone=$1 ORDER BY first_seen_at ASC',
        [g.phone]
      );
      const survivor = rows.rows[0].id;
      const absorbed = [];
      for (const r of rows.rows.slice(1)) {
        try {
          await db.mergeCustomers(survivor, r.id, 'phone-sweep');
          absorbed.push(r.id);
        } catch (e) {
          results.push({ phone: g.phone, error: e.message });
        }
      }
      if (absorbed.length) results.push({ phone: g.phone, survivor, absorbed });
    }
    res.json({ ok: true, groups: groups.rows.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /health — per-integration status for an external uptime monitor.
// No auth and no secrets. 503 when something we have seen is degraded.
app.get('/health', (req, res) => {
  const healthWatch = require('./services/healthWatch');
  const body = healthWatch.publicView();
  res.status(body.status === 'ok' ? 200 : 503).json(body);
});

// GET /debug/health?key=... — one look at everything that can silently rot.
// Same data the scheduled self-check uses. Add &run=1 to force a full pass
// (repairs + alert) instead of a read-only snapshot.
app.get('/debug/health', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    if (req.query.run === '1') {
      return res.json(await selfCheck.run('manual'));
    }
    const snapshot = await selfCheck.gather();
    res.json({ ...snapshot, last_self_check: selfCheck.getLastReport() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /debug/knowledge?key=...&q=... — inspect the product knowledge base
app.get('/debug/knowledge', (req, res) => {
  if (!debugAuth(req, res)) return;
  const knowledge = require('./services/knowledge');
  res.json({
    stats: knowledge.stats(),
    db_enabled: db.DB_ENABLED,
    result: req.query.q ? knowledge.search(req.query.q) : undefined,
  });
});

// ============================================================
// ZALO BOT API (free channel — no OA Tier Package required)
// ============================================================

// GET /bot/setup?key=... — register the bot webhook with Zalo
app.get('/bot/setup', async (req, res) => {
  if (!debugAuth(req, res)) return;
  const url = req.query.url || `${process.env.PUBLIC_URL || 'https://docmofarm.com'}/bot/webhook`;
  const secret = process.env.ZALO_BOT_WEBHOOK_SECRET || process.env.ZALO_WEBHOOK_TOKEN;
  const result = await botService.setWebhook(url, secret);
  const info = await botService.getWebhookInfo();
  res.json({ ok: !!result, set: result, info });
});

// GET /bot/info?key=... — bot identity + current webhook registration
app.get('/bot/info', async (req, res) => {
  if (!debugAuth(req, res)) return;
  const [me, webhook] = await Promise.all([botService.getMe(), botService.getWebhookInfo()]);
  res.json({ me, webhook });
});

// GET /bot/test-send?key=...&chat=...&text=...
app.get('/bot/test-send', async (req, res) => {
  if (!debugAuth(req, res)) return;
  const result = await botService.sendMessage(req.query.chat, req.query.text || 'Test Bot Dốc Mơ Farm 🌿');
  res.json({ ok: !!result, response: result });
});

// POST /bot/webhook — inbound messages from the Zalo Bot API
app.post('/bot/webhook', async (req, res) => {
  // Answer fast; Zalo retries if we are slow.
  res.status(200).json({ ok: true });

  const secret = process.env.ZALO_BOT_WEBHOOK_SECRET || process.env.ZALO_WEBHOOK_TOKEN;
  const got = req.headers['x-bot-api-secret-token'];
  if (secret && got && got !== secret) {
    logEvent({ type: 'bot_bad_secret' });
    return;
  }

  logEvent({ type: 'bot_incoming', body: req.body });

  const body = req.body || {};
  const msg = body.message || {};
  const chatId = msg.chat?.id || msg.from?.id;
  const eventName = String(body.event_name || '');

  const evt = botService.parseTextEvent(body);

  // Owner control commands arrive on the owner's own bot chat.
  if (evt && chatId && String(chatId) === String(notify.ownerChatId())) {
    const handled = await handleOwnerCommand(evt.text, (t) => botService.sendMessage(chatId, t));
    if (handled) {
      logEvent({ type: 'owner_command', text: evt.text.slice(0, 60) });
      return;
    }
  }

  if (evt) {
    console.log(`🤖 [bot ${evt.chatId}] ${evt.text}`);
    await pipeline.handleMessage({
      channel: 'bot',
      externalKey: `bot_${evt.chatId}`,
      replyTo: evt.chatId,
      text: evt.text,
      msgId: evt.messageId,
      senderName: evt.senderName,
      send: (to, text) => botService.sendMessage(to, text),
      sendPhoto: (to, url, caption) => botService.sendPhoto(to, url, caption),
      typing: (to) => botService.sendTyping(to),
      log: logEvent,
    });
    return;
  }

  // Non-text: image / sticker / audio / video / file
  const kind = /image/.test(eventName) ? 'image'
    : /sticker/.test(eventName) ? 'sticker'
    : /audio|voice/.test(eventName) ? 'audio'
    : /video/.test(eventName) ? 'video'
    : /file|document/.test(eventName) ? 'file'
    : null;

  if (kind && chatId) {
    await pipeline.handleNonText({
      channel: 'bot',
      kind,
      externalKey: `bot_${chatId}`,
      replyTo: chatId,
      msgId: msg.message_id,
      senderName: msg.from?.display_name,
      send: (to, text) => botService.sendMessage(to, text),
      log: logEvent,
    });
    return;
  }

  logEvent({ type: 'bot_skipped', event_name: eventName });
});

// ============================================================
// FACEBOOK MESSENGER
// GET  /messenger/webhook — Meta hub.challenge (FB_VERIFY_TOKEN)
// POST /messenger/webhook — inbound Page events → same HITL pipeline
// Approve & Send delivers with Graph POST /me/messages.
// MESSENGER_ENABLED defaults off; POST is ignored until it is true.
// ============================================================
messenger.mount(app, { pipeline, log: logEvent });

// ============================================================
// OWNER COMMANDS (sent from the farm's own Zalo to the bot)
//   /mo <id>     resume the AI for that customer
//   /dung <id>   pause the AI (a person will answer)
//   /cho         list conversations waiting for a human
//   /tinhtrang   health snapshot
// ============================================================
async function handleOwnerCommand(text, reply) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return false;

  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(' ').trim();

  try {
    if (cmd === '/mo' || cmd === '/resume') {
      if (!arg) return reply('Cú pháp: /mo <id khách>'), true;
      const c = await db.getCustomerByExternalId(arg);
      if (!c) return reply(`Không tìm thấy khách: ${arg}`), true;
      await db.resumeBot(c.id);
      await reply(`✅ Đã mở lại bot cho ${c.display_name || arg}`);
      return true;
    }

    if (cmd === '/dung' || cmd === '/pause') {
      if (!arg) return reply('Cú pháp: /dung <id khách>'), true;
      const c = await db.getCustomerByExternalId(arg);
      if (!c) return reply(`Không tìm thấy khách: ${arg}`), true;
      await db.pauseBot(c.id, 'Chủ farm tạm dừng');
      await reply(`⏸️ Đã tạm dừng bot cho ${c.display_name || arg}. Mở lại: /mo ${arg}`);
      return true;
    }

    if (cmd === '/cho' || cmd === '/waiting') {
      const rows = await db.listPaused();
      if (rows.length === 0) return reply('Không có khách nào đang chờ người thật ✅'), true;
      const lines = rows.map(r => {
        const id = (r.identities || [])[0]?.external_id || r.id;
        return `• ${r.display_name || 'Khách'}${r.phone ? ` · ${r.phone}` : ''}\n  ${r.paused_reason || ''}\n  mở lại: /mo ${id}`;
      });
      await reply(`⏳ ${rows.length} khách đang chờ:\n\n${lines.join('\n\n')}`);
      return true;
    }

    if (cmd === '/tinhtrang' || cmd === '/status') {
      const h = await selfCheck.run('owner-command');
      const head = h.healthy ? '💚 Hệ thống bình thường' : `💛 ${h.problems.length} vấn đề`;
      const c = h.counts || {};
      await reply(
        `${head}\n\n` +
        `👥 Khách: ${c.customers ?? '?'} · 💬 Tin: ${c.messages ?? '?'} · 🛒 Đơn: ${c.orders ?? '?'}\n` +
        `📨 Tin 24h: ${h.messages_24h ?? '?'}\n` +
        (h.problems?.length ? `\n${h.problems.map(x => '• ' + x).join('\n')}` : '')
      );
      return true;
    }

    if (cmd === '/help' || cmd === '/lenh') {
      await reply(
        'Lệnh dành cho farm:\n' +
        '/cho — khách đang chờ người thật\n' +
        '/mo <id> — mở lại bot cho khách\n' +
        '/dung <id> — tạm dừng bot cho khách\n' +
        '/tinhtrang — kiểm tra hệ thống\n' +
        '/baocao — báo cáo kinh doanh hôm nay\n' +
        '/khach — khách đã hỏi mà chưa mua (tuần này)'
      );
      return true;
    }

    if (cmd === '/baocao' || cmd === '/report') {
      await reply(await selfCheck.dailyReportText());
      return true;
    }

    if (cmd === '/khach' || cmd === '/leads') {
      await reply(await selfCheck.weeklyLeadsText());
      return true;
    }
  } catch (e) {
    await reply(`Lỗi lệnh: ${e.message}`);
    return true;
  }

  // Anything else starting with "/" from the owner is a mistyped command.
  // Answering it as a customer question would burn ~6k tokens for nothing.
  await reply(
    `Không có lệnh "${esc(cmd)}".\n\n` +
    'Lệnh hiện có:\n' +
    '/cho — khách đang chờ người thật\n' +
    '/mo <id> — mở lại bot cho khách\n' +
    '/dung <id> — tạm dừng bot cho khách\n' +
    '/tinhtrang — kiểm tra hệ thống\n' +
    '/baocao — báo cáo kinh doanh'
  );
  return true;
}

/** Keep a mistyped command from being echoed back with markup. */
function esc(s) {
  return String(s || '').replace(/[<>]/g, '').slice(0, 40);
}

// ============================================================
// ZALO WEBHOOK — Message Handler (POST)
// ============================================================
app.post('/webhook', async (req, res) => {
  // Respond immediately to Zalo (< 5s required)
  res.status(200).json({ message: 'ok' });

  logEvent({ type: 'incoming', event_name: req.body?.event_name || (req.body?.events ? 'batch' : 'unknown'), body: req.body });

  try {
    // Verify signature
    const signature = req.headers['x-zalo-signature'];
    if (signature && process.env.ZALO_OA_SECRET_KEY) {
      const expected = crypto
        .createHmac('sha256', process.env.ZALO_OA_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest('base64');
      if (signature !== expected) {
        console.warn('⚠️  Invalid webhook signature');
        return;
      }
    }

    // Zalo OA sends ONE event per POST at top level: {event_name, sender, message, ...}
    // Support both shapes just in case.
    const events = Array.isArray(req.body.events) ? req.body.events : [req.body];

    for (const event of events) {
      const name = String(event.event_name || '');
      const senderId = event.sender?.id;
      const senderName = event.sender?.display_name || null;
      const send = (to, text) => zaloService.sendTextMessage(to, text);

      // Our own outbound messages come back as events — ignore them.
      if (name.startsWith('oa_') || name === 'user_received_message' || name === 'user_seen_message') {
        logEvent({ type: 'skipped', event_name: name });
        continue;
      }

      if (name === 'follow') {
        await pipeline.handleFollow({
          channel: 'oa', externalKey: senderId, replyTo: senderId,
          senderName, send, log: logEvent,
        });
        continue;
      }

      if (name === 'unfollow') {
        logEvent({ type: 'unfollow', from: senderId });
        continue;
      }

      if (name === 'user_send_text') {
        console.log(`📨 [${senderId}] ${event.message?.text}`);
        await pipeline.handleMessage({
          channel: 'oa',
          externalKey: senderId,
          replyTo: senderId,
          text: event.message?.text || '',
          msgId: event.message?.msg_id,
          senderName,
          send,
          log: logEvent,
        });
        continue;
      }

      const kind = name === 'user_send_image' ? 'image'
        : name === 'user_send_sticker' ? 'sticker'
        : name === 'user_send_audio' ? 'audio'
        : name === 'user_send_video' ? 'video'
        : name === 'user_send_file' ? 'file'
        : null;

      if (kind) {
        await pipeline.handleNonText({
          channel: 'oa', kind, externalKey: senderId, replyTo: senderId,
          msgId: event.message?.msg_id, senderName, send, log: logEvent,
        });
        continue;
      }

      logEvent({ type: 'skipped', event_name: name });
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    logEvent({ type: 'error', error: error.message });
  }
});

// ============================================================
// CUSTOMERS API
// ============================================================
app.get('/api/customers', async (req, res) => {
  try {
    const result = await db.pool.query(
      `SELECT c.*, ltv.total_orders, ltv.total_revenue, ltv.churn_risk
       FROM customers c
       LEFT JOIN customer_ltv ltv ON ltv.customer_id = c.id
       ORDER BY c.last_seen_at DESC`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customers/:zaloId', async (req, res) => {
  try {
    const customer = await db.getCustomerByZaloId(req.params.zaloId);
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const [orders, memories, prefs, ltv] = await Promise.all([
      db.getCustomerOrders(customer.id, 10),
      db.getTopMemories(customer.id, 20),
      db.getCustomerPreferences(customer.id),
      db.pool.query('SELECT * FROM customer_ltv WHERE customer_id = $1', [customer.id])
    ]);

    res.json({ customer, orders, memories, preferences: prefs, ltv: ltv.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customers/:zaloId/orders', async (req, res) => {
  try {
    const customer = await db.getCustomerByZaloId(req.params.zaloId);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const orders = await db.getCustomerOrders(customer.id);
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customers/:zaloId/memories', async (req, res) => {
  try {
    const customer = await db.getCustomerByZaloId(req.params.zaloId);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const memories = await db.getTopMemories(customer.id, 50);
    res.json(memories);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// FAQ API
// ============================================================

/**
 * GET /api/faq
 * List FAQs. Query params: category, published (true/false)
 */
app.get('/api/faq', async (req, res) => {
  try {
    const { category, published } = req.query;
    const faqs = await faqService.getAllFaqs({
      category: category || null,
      published: published !== undefined ? published === 'true' : null
    });
    res.json({ count: faqs.length, faqs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/faq/generate
 * Generate FAQ from chat history
 * Body: { days: 30, minMessages: 20, autoPublish: false }
 */
app.post('/api/faq/generate', async (req, res) => {
  try {
    const { days = 30, minMessages = 20, autoPublish = false } = req.body;
    console.log(`🤖 FAQ generation requested: last ${days} days`);
    const result = await faqService.generateFaqFromHistory({ days, minMessages, autoPublish });
    res.json(result);
  } catch (e) {
    console.error('FAQ generation error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/faq/:id/publish
 * Publish or unpublish a FAQ
 * Body: { publish: true }
 */
app.patch('/api/faq/:id/publish', async (req, res) => {
  try {
    const { publish = true } = req.body;
    const faq = await faqService.togglePublish(req.params.id, publish);
    if (!faq) return res.status(404).json({ error: 'FAQ not found' });
    res.json(faq);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/faq/published
 * Public FAQ list (for website/Zalo OA menu)
 */
app.get('/api/faq/published', async (req, res) => {
  try {
    const faqs = await faqService.getPublishedFaqs(req.query.category || null);
    res.json({ count: faqs.length, faqs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ANALYTICS API
// ============================================================
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const [customers, orders, messages, topProducts] = await Promise.all([
      db.pool.query(`
        SELECT
          COUNT(*) as total_customers,
          COUNT(*) FILTER (WHERE customer_tier = 'vip') as vip_customers,
          COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '7 days') as active_7d
        FROM customers`),
      db.pool.query(`
        SELECT
          COUNT(*) as total_orders,
          COALESCE(SUM(total_amount), 0) as total_revenue,
          COALESCE(AVG(total_amount), 0) as avg_order_value,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_orders
        FROM orders`),
      db.pool.query(`
        SELECT COUNT(*) as total_messages
        FROM messages
        WHERE created_at > NOW() - INTERVAL '30 days'`),
      db.pool.query(`
        SELECT oi.product_name, SUM(oi.quantity) as total_qty, SUM(oi.subtotal) as revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('cancelled','refunded')
        GROUP BY oi.product_name
        ORDER BY revenue DESC LIMIT 5`)
    ]);

    res.json({
      customers: customers.rows[0],
      orders: orders.rows[0],
      messages: messages.rows[0],
      top_products: topProducts.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// TEST CHAT (for local testing without Zalo)
// ============================================================
app.post('/chat', async (req, res) => {
  try {
    const { message, zalo_user_id = 'test_user_001' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    await db.getOrCreateCustomer(zalo_user_id, 'Test User');
    await db.saveMessage(zalo_user_id, 'user', message);

    const result = await aiAgent.respond(zalo_user_id, message);
    const low = confidenceGate.isLow(result.confidence);
    const text = low ? confidenceGate.WAITING_REPLY : result.text;

    await db.saveMessage(zalo_user_id, 'assistant', text, {
      model: 'claude-sonnet-4-6',
      tokensUsed: result.tokensUsed,
    });

    res.json({
      reply: text,
      tokens: result.tokensUsed,
      confidence: result.confidence,
      needs_human: low,
      ticket_status: low ? confidenceGate.TICKET_STATUS : null,
    });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Unmatched /admin/* must not fall through to a public handler.
app.use('/admin', hitlAdmin.fallback);

selfCheck.start();
followup.start();
require('./services/healthWatch').start();

app.listen(PORT, () => {
  console.log(`🚀 Doc Mo Farm AI Agent running on port ${PORT}`);
  console.log(`   Webhook: POST /webhook`);
  console.log(`   Messenger: POST /messenger/webhook (${messenger.enabled() ? 'on' : 'off'})`);
  console.log(`   Test:    POST /chat`);
  console.log(`   FAQ:     GET  /api/faq | POST /api/faq/generate`);
  console.log(`   Drafts:  GET  /admin`);
  console.log(`   HITL:    ${hitl.hitlRequired() ? 'ON — replies wait as PENDING_REVIEW' : 'OFF — auto-send (HITL_REQUIRE_APPROVAL=false)'}`);
  console.log(`   Confidence: below ${confidenceGate.minConfidence()} → ${confidenceGate.TICKET_STATUS} (AI_CONFIDENCE_MIN)`);
  const piiOn = require('./services/pii').maskingEnabled();
  console.log(`   PII:     ${piiOn ? 'ON — prompts masked before the model' : 'OFF — PII_MASKING_ENABLED is false'}`);
});
