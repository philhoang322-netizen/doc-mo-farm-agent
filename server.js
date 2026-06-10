require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const zaloService = require('./services/zaloService');
const db          = require('./services/database');
const aiAgent     = require('./services/aiAgent');
const faqService  = require('./services/faqService');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Init DB check on startup
db.initDB().catch(err => console.error('DB init error:', err));

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Doc Mo Farm AI Agent', version: '2.0' });
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
    const { text: reply, tokensUsed } = await aiAgent.respond('debug_user', req.query.text || 'Xin chào');
    res.json({ ok: true, reply, tokensUsed });
  } catch (e) {
    res.json({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
  }
});

// GET /debug/test-send?key=...&uid=...&text=... — test Zalo send only
app.get('/debug/test-send', async (req, res) => {
  if (!debugAuth(req, res)) return;
  try {
    const result = await zaloService.sendTextMessage(req.query.uid, req.query.text || 'Test từ Dốc Mơ Farm bot 🌿');
    res.json({ ok: !!result, zalo_response: result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

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
      if (event.event_name !== 'user_send_text') {
        logEvent({ type: 'skipped', event_name: event.event_name });
        continue;
      }

      const senderId   = event.sender.id;
      const userMsg    = event.message.text;
      const senderName = event.sender?.display_name || null;

      console.log(`📨 [${senderId}] ${userMsg}`);

      // Ensure customer exists
      await db.getOrCreateCustomer(senderId, senderName);

      // Save incoming message
      await db.saveMessage(senderId, 'user', userMsg);

      // Get AI response
      const { text: aiReply, tokensUsed } = await aiAgent.respond(senderId, userMsg);

      // Save AI reply
      await db.saveMessage(senderId, 'assistant', aiReply, {
        model: 'claude-sonnet-4-6',
        tokensUsed
      });

      // Send back to Zalo
      const sendResult = await zaloService.sendTextMessage(senderId, aiReply);
      console.log(`✓ Replied [${tokensUsed} tokens]: ${aiReply.substring(0, 80)}...`);
      logEvent({ type: 'replied', to: senderId, reply: aiReply.substring(0, 120), tokensUsed, send_ok: !!sendResult });
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

    const { text, tokensUsed } = await aiAgent.respond(zalo_user_id, message);

    await db.saveMessage(zalo_user_id, 'assistant', text, {
      model: 'claude-sonnet-4-6',
      tokensUsed
    });

    res.json({ reply: text, tokens: tokensUsed });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Doc Mo Farm AI Agent running on port ${PORT}`);
  console.log(`   Webhook: POST /webhook`);
  console.log(`   Test:    POST /chat`);
  console.log(`   FAQ:     GET  /api/faq | POST /api/faq/generate`);
});
