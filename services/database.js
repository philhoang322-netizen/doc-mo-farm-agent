const { Pool } = require('pg');

// DB is OPTIONAL. Without DATABASE_URL the bot still answers —
// it just has no long-term memory/orders (in-memory history only).
const DB_ENABLED = !!process.env.DATABASE_URL;

const pool = DB_ENABLED
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      // A hung query must not silently wedge the bot.
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 15000,
      connectionTimeoutMillis: 10000,
    })
  : {
      query: async () => { throw new Error('Database disabled (no DATABASE_URL)'); },
      connect: async () => { throw new Error('Database disabled (no DATABASE_URL)'); },
    };

// In-memory fallback conversation store (per process)
const memHistory = new Map(); // zaloUserId -> [{role, content}]
function memPush(zaloUserId, role, content) {
  const arr = memHistory.get(zaloUserId) || [];
  arr.push({ role, content, created_at: new Date() });
  while (arr.length > 20) arr.shift();
  memHistory.set(zaloUserId, arr);
}

// ============================================================
// CUSTOMERS
// ============================================================

async function getCustomerByZaloId(zaloUserId) {
  if (!DB_ENABLED) return null;
  const result = await pool.query(
    'SELECT * FROM customers WHERE zalo_user_id = $1',
    [zaloUserId]
  );
  return result.rows[0] || null;
}

// Keep old name for backward compat with server.js
async function getCustomer(zaloUserId) {
  return getCustomerByZaloId(zaloUserId);
}

// ============================================================
// CROSS-CHANNEL IDENTITY
// Zalo gives a different id per channel (OA vs Bot). We keep a
// mapping table and merge two customers once a shared phone proves
// they are the same person.
// ============================================================

/** "bot_123" → bot; "fb_123" → messenger; "98765" → oa. The stored id keeps the prefix. */
function parseKey(externalKey) {
  const s = String(externalKey || '');
  if (s.startsWith('bot_')) return { channel: 'bot', id: s };
  if (s.startsWith('fb_')) return { channel: 'messenger', id: s };
  if (s.startsWith('test_') || s === 'debug_user') return { channel: 'test', id: s };
  return { channel: 'oa', id: s };
}

function acquisitionChannel(channel) {
  if (channel === 'bot') return 'zalo_bot';
  if (channel === 'messenger') return 'messenger';
  if (channel === 'test') return 'test';
  return 'zalo_oa';
}

/** Resolve a channel-scoped key to its customer, following merges. */
async function getCustomerByExternalId(externalKey) {
  if (!DB_ENABLED) return null;
  const { channel, id } = parseKey(externalKey);
  const r = await pool.query(
    `SELECT c.* FROM customers c
     JOIN customer_identities i ON i.customer_id = c.id
     WHERE i.channel = $1 AND i.external_id = $2`,
    [channel, id]
  );
  if (r.rows[0]) return r.rows[0];
  // Fall back to the legacy column for rows created before 002.
  return getCustomerByZaloId(externalKey);
}

async function linkIdentity(customerId, externalKey) {
  if (!DB_ENABLED) return;
  const { channel, id } = parseKey(externalKey);
  await pool.query(
    `INSERT INTO customer_identities (customer_id, channel, external_id)
     VALUES ($1, $2, $3) ON CONFLICT (channel, external_id) DO NOTHING`,
    [customerId, channel, id]
  );
}

/** Every channel key that belongs to this customer. */
async function getIdentities(customerId) {
  if (!DB_ENABLED) return [];
  const r = await pool.query(
    'SELECT channel, external_id FROM customer_identities WHERE customer_id = $1',
    [customerId]
  );
  return r.rows;
}

/**
 * Fold `mergedId` into `survivorId`: move all history, keep the richer
 * profile fields, and record the merge. Idempotent-ish and transactional.
 */
async function mergeCustomers(survivorId, mergedId, matchedOn = 'phone') {
  if (!DB_ENABLED || survivorId === mergedId) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL only applies inside a transaction — must follow BEGIN.
    // Fail fast instead of blocking forever behind someone else's row lock.
    await client.query("SET LOCAL lock_timeout = '4s'");
    await client.query("SET LOCAL statement_timeout = '8s'");

    await client.query('UPDATE customer_identities SET customer_id=$1 WHERE customer_id=$2', [survivorId, mergedId]);
    await client.query('UPDATE messages SET customer_id=$1 WHERE customer_id=$2', [survivorId, mergedId]);
    await client.query('UPDATE conversation_sessions SET customer_id=$1 WHERE customer_id=$2', [survivorId, mergedId]);
    await client.query('UPDATE orders SET customer_id=$1 WHERE customer_id=$2', [survivorId, mergedId]);
    await client.query('UPDATE events SET customer_id=$1 WHERE customer_id=$2', [survivorId, mergedId]);

    // ---- Tables with a UNIQUE key per customer ----
    // These CASCADE on delete, so anything not moved here is lost silently.
    // Move what doesn't collide; drop the rest (survivor's value wins).

    await client.query(
      `UPDATE ai_memories m SET customer_id=$1 WHERE customer_id=$2
         AND NOT EXISTS (SELECT 1 FROM ai_memories x
                         WHERE x.customer_id=$1 AND x.memory_type=m.memory_type AND x.memory_key=m.memory_key)`,
      [survivorId, mergedId]
    );
    await client.query('DELETE FROM ai_memories WHERE customer_id=$1', [mergedId]);

    await client.query(
      `UPDATE customer_preferences p SET customer_id=$1 WHERE customer_id=$2
         AND NOT EXISTS (SELECT 1 FROM customer_preferences x
                         WHERE x.customer_id=$1 AND x.preference_type=p.preference_type
                           AND x.preference_key=p.preference_key)`,
      [survivorId, mergedId]
    );
    await client.query('DELETE FROM customer_preferences WHERE customer_id=$1', [mergedId]);

    // One profile row per customer: move it if the survivor has none,
    // otherwise fill the survivor's blank fields from it.
    const hasProfile = await client.query(
      'SELECT 1 FROM customer_profiles WHERE customer_id=$1 LIMIT 1',
      [survivorId]
    );
    if (hasProfile.rowCount === 0) {
      await client.query('UPDATE customer_profiles SET customer_id=$1 WHERE customer_id=$2', [survivorId, mergedId]);
    } else {
      await client.query(
        `UPDATE customer_profiles s SET
           household_size    = COALESCE(s.household_size, m.household_size),
           has_children      = COALESCE(s.has_children, m.has_children),
           has_elderly       = COALESCE(s.has_elderly, m.has_elderly),
           health_concerns   = COALESCE(s.health_concerns, m.health_concerns),
           dietary_prefs     = COALESCE(s.dietary_prefs, m.dietary_prefs),
           allergies         = COALESCE(s.allergies, m.allergies),
           price_sensitivity = COALESCE(s.price_sensitivity, m.price_sensitivity),
           ai_notes          = COALESCE(s.ai_notes, '{}'::jsonb) || COALESCE(m.ai_notes, '{}'::jsonb)
         FROM customer_profiles m
         WHERE s.customer_id=$1 AND m.customer_id=$2`,
        [survivorId, mergedId]
      );
      await client.query('DELETE FROM customer_profiles WHERE customer_id=$1', [mergedId]);
    }

    // Fill any blank field on the survivor from the merged record.
    await client.query(
      `UPDATE customers s SET
         phone        = COALESCE(s.phone, m.phone),
         full_name    = COALESCE(s.full_name, m.full_name),
         display_name = COALESCE(s.display_name, m.display_name),
         full_address = COALESCE(s.full_address, m.full_address),
         city         = COALESCE(s.city, m.city),
         first_seen_at = LEAST(s.first_seen_at, m.first_seen_at),
         last_seen_at  = GREATEST(s.last_seen_at, m.last_seen_at),
         updated_at   = NOW()
       FROM customers m
       WHERE s.id=$1 AND m.id=$2`,
      [survivorId, mergedId]
    );

    await client.query('SAVEPOINT channel_names_merge');
    try {
      await client.query(
        `UPDATE customers s SET channel_names =
           COALESCE(s.channel_names, '{}'::jsonb) || COALESCE(m.channel_names, '{}'::jsonb)
         FROM customers m WHERE s.id=$1 AND m.id=$2`,
        [survivorId, mergedId]
      );
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT channel_names_merge');
      if (err.code !== '42703') throw err;
    }

    await client.query(
      'INSERT INTO customer_merges (survivor_id, merged_id, matched_on) VALUES ($1,$2,$3)',
      [survivorId, mergedId, matchedOn]
    );

    // customer_ltv has a UNIQUE customer_id and no ON DELETE CASCADE, so the
    // merged row must go before the customer can be deleted. Its numbers are
    // recomputed for the survivor by updateCustomerLtv() below.
    await client.query('DELETE FROM customer_ltv WHERE customer_id=$1', [mergedId]);

    await client.query('DELETE FROM customers WHERE id=$1', [mergedId]);

    await client.query('COMMIT');
    console.log(`🔗 Merged customer ${mergedId} → ${survivorId} (matched on ${matchedOn})`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Merge failed:', e.message);
    throw e;
  } finally {
    client.release();
  }

  await updateCustomerLtv(survivorId);
  return survivorId;
}

/** Normalize VN phone numbers so 0912…, +8491…, 8491… all compare equal. */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  else if (p.startsWith('84') && p.length >= 10) p = '0' + p.slice(2);
  if (!p.startsWith('0')) p = '0' + p;
  return p.length >= 9 && p.length <= 11 ? p : null;
}

/**
 * Record a phone for this customer and merge any other customer that
 * already has it — this is what links an OA chat to a Bot chat.
 * Returns the surviving customer id.
 */
async function setPhoneAndMerge(customerId, rawPhone) {
  if (!DB_ENABLED || !customerId) return customerId;
  const phone = normalizePhone(rawPhone);
  if (!phone) return customerId;

  await pool.query('UPDATE customers SET phone=$1, updated_at=NOW() WHERE id=$2', [phone, customerId]);

  const dupes = await pool.query(
    'SELECT id, first_seen_at FROM customers WHERE phone=$1 AND id <> $2 ORDER BY first_seen_at ASC',
    [phone, customerId]
  );
  if (dupes.rows.length === 0) return customerId;

  // Oldest record wins, so the longest history is preserved.
  const all = [...dupes.rows.map(r => r.id), customerId];
  const survivorRow = await pool.query(
    'SELECT id FROM customers WHERE id = ANY($1::uuid[]) ORDER BY first_seen_at ASC LIMIT 1',
    [all]
  );
  const survivor = survivorRow.rows[0].id;

  for (const id of all) {
    if (id !== survivor) await mergeCustomers(survivor, id, 'phone');
  }
  return survivor;
}

async function getOrCreateCustomer(zaloUserId, name = null) {
  if (!DB_ENABLED) return null;
  const existing = await getCustomerByExternalId(zaloUserId);
  if (existing) {
    await pool.query('UPDATE customers SET last_seen_at = NOW() WHERE id = $1', [existing.id]);
    // Heals rows created before the identity table existed.
    await linkIdentity(existing.id, zaloUserId);
    return existing;
  }

  const { channel } = parseKey(zaloUserId);
  const result = await pool.query(
    `INSERT INTO customers (zalo_user_id, display_name, full_name, acquisition_channel, last_seen_at)
     VALUES ($1, $2, $2, $3, NOW()) RETURNING *`,
    [zaloUserId, name, acquisitionChannel(channel)]
  );
  await linkIdentity(result.rows[0].id, zaloUserId);
  await pool.query(
    'INSERT INTO customer_ltv (customer_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [result.rows[0].id]
  );
  return result.rows[0];
}

// ============================================================
// HUMAN HANDOFF — while paused, the AI stays silent for this customer
// ============================================================

/** Record what we learn about how to address someone. */
async function setGender(customerId, gender, fullName = null) {
  if (!DB_ENABLED || !customerId) return false;
  if (!['male', 'female'].includes(gender)) return false;
  await pool.query(
    `UPDATE customers
     SET gender = $2,
         full_name = COALESCE($3, full_name),
         updated_at = NOW()
     WHERE id = $1`,
    [customerId, gender, fullName]
  );
  return true;
}

async function pauseBot(customerId, reason = null) {
  if (!DB_ENABLED) return false;
  await pool.query(
    'UPDATE customers SET bot_paused=TRUE, paused_reason=$2, paused_at=NOW(), updated_at=NOW() WHERE id=$1',
    [customerId, reason]
  );
  return true;
}

async function resumeBot(customerId) {
  if (!DB_ENABLED) return false;
  await pool.query(
    'UPDATE customers SET bot_paused=FALSE, paused_reason=NULL, paused_at=NULL, updated_at=NOW() WHERE id=$1',
    [customerId]
  );
  return true;
}

async function listPaused() {
  if (!DB_ENABLED) return [];
  const r = await pool.query(
    `SELECT c.id, c.display_name, c.phone, c.paused_reason, c.paused_at,
            (SELECT json_agg(json_build_object('channel', i.channel, 'external_id', i.external_id))
             FROM customer_identities i WHERE i.customer_id = c.id) AS identities
     FROM customers c WHERE c.bot_paused = TRUE ORDER BY c.paused_at DESC`
  );
  return r.rows;
}

async function updateCustomer(zaloUserId, data) {
  const { full_name, phone, full_address } = data;
  const result = await pool.query(
    `UPDATE customers
     SET full_name = COALESCE($1, full_name),
         phone     = COALESCE($2, phone),
         full_address = COALESCE($3, full_address),
         updated_at = NOW()
     WHERE zalo_user_id = $4 RETURNING *`,
    [full_name, phone, full_address, zaloUserId]
  );
  return result.rows[0];
}

// ============================================================
// CONVERSATIONS & MESSAGES
// ============================================================

async function getOrCreateSession(zaloUserId, customerId = null) {
  // Find active session from last 30 minutes
  const existing = await pool.query(`
    SELECT * FROM conversation_sessions
    WHERE zalo_user_id = $1
      AND status = 'active'
      AND last_message_at > NOW() - INTERVAL '30 minutes'
    ORDER BY last_message_at DESC
    LIMIT 1`,
    [zaloUserId]
  );
  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE conversation_sessions SET last_message_at = NOW(), message_count = message_count + 1 WHERE id = $1',
      [existing.rows[0].id]
    );
    return existing.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO conversation_sessions (customer_id, zalo_user_id)
     VALUES ($1, $2) RETURNING *`,
    [customerId, zaloUserId]
  );
  return result.rows[0];
}

async function saveMessage(zaloUserId, role, content, options = {}) {
  if (!DB_ENABLED) { memPush(zaloUserId, role, content); return; }
  const customer = await getCustomerByExternalId(zaloUserId);
  const session = await getOrCreateSession(zaloUserId, customer?.id);

  await pool.query(
    `INSERT INTO messages
       (session_id, customer_id, zalo_user_id, role, content, model_used, tokens_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      session.id,
      customer?.id || null,
      zaloUserId,
      role,
      content,
      options.model || null,
      options.tokensUsed || null
    ]
  );

  // Track event
  if (customer) {
    await trackEvent(customer.id, session.id, role === 'user' ? 'message_received' : 'message_sent', {
      content_length: content.length
    });
  }
}

async function getConversationHistory(zaloUserId, limit = 10) {
  if (!DB_ENABLED) return (memHistory.get(zaloUserId) || []).slice(-limit);

  // Prefer customer_id so history spans every channel after a merge.
  const customer = await getCustomerByExternalId(zaloUserId);
  const result = customer
    ? await pool.query(
        `SELECT role, content, created_at FROM messages
         WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [customer.id, limit]
      )
    : await pool.query(
        `SELECT role, content, created_at FROM messages
         WHERE zalo_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [zaloUserId, limit]
      );
  return result.rows.reverse();
}

// ============================================================
// AI MEMORIES
// ============================================================

async function saveMemory(customerId, memoryType, memoryKey, memoryValue, importance = 3) {
  if (!DB_ENABLED) return;
  await pool.query(
    `INSERT INTO ai_memories
       (customer_id, memory_type, memory_key, memory_value, importance)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (customer_id, memory_type, memory_key)
     DO UPDATE SET
       memory_value = EXCLUDED.memory_value,
       importance = EXCLUDED.importance,
       last_referenced = NOW(),
       reference_count = ai_memories.reference_count + 1,
       updated_at = NOW()`,
    [customerId, memoryType, memoryKey, memoryValue, importance]
  );
}

async function getTopMemories(customerId, limit = 8) {
  if (!DB_ENABLED) return [];
  const result = await pool.query(
    `SELECT memory_type, memory_key, memory_value, importance, confidence
     FROM ai_memories
     WHERE customer_id = $1
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY importance DESC, last_referenced DESC
     LIMIT $2`,
    [customerId, limit]
  );
  return result.rows;
}

// ============================================================
// ORDERS
// ============================================================

async function createOrderNew(customerId, items, deliveryAddress = null, customerNote = null, paymentMethod = 'cod') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const total = items.reduce((sum, i) => sum + (i.quantity * (i.unit_price || 0)), 0);

    const order = await client.query(
      `INSERT INTO orders
         (customer_id, total_amount, subtotal, delivery_address, customer_note, payment_method)
       VALUES ($1, $2, $2, $3, $4, $5) RETURNING *`,
      [customerId, total, deliveryAddress, customerNote, paymentMethod]
    );
    const orderId = order.rows[0].id;

    for (const item of items) {
      // Try to find product by name
      const prod = await client.query(
        'SELECT id FROM products WHERE name_vi ILIKE $1 OR name ILIKE $1 LIMIT 1',
        [item.product_name]
      );
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, prod.rows[0]?.id || null, item.product_name, item.quantity, item.unit_price]
      );
    }

    await client.query('COMMIT');

    // Update LTV
    await updateCustomerLtv(customerId);

    return order.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Keep backward-compat
async function createOrder(customerId, items, deliveryDate = null, notes = null) {
  return createOrderNew(customerId, items.map(i => ({
    product_name: i.name,
    quantity: i.quantity,
    unit_price: i.price || 0
  })), null, notes);
}

async function getCustomerOrders(customerId, limit = 5) {
  if (!DB_ENABLED) return [];
  const result = await pool.query(
    `SELECT o.*, json_agg(
       json_build_object('name', oi.product_name, 'qty', oi.quantity, 'price', oi.unit_price)
     ) as items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC LIMIT $2`,
    [customerId, limit]
  );
  return result.rows;
}

async function getRecentOrders(customerId, limit = 3) {
  return getCustomerOrders(customerId, limit);
}

// ============================================================
// CUSTOMER PREFERENCES
// ============================================================

async function getCustomerPreferences(customerId) {
  if (!DB_ENABLED) return [];
  const result = await pool.query(
    `SELECT preference_key, preference_value, confidence
     FROM customer_preferences
     WHERE customer_id = $1 AND confidence >= 0.5
     ORDER BY confidence DESC`,
    [customerId]
  );
  return result.rows;
}

// ============================================================
// LTV
// ============================================================

async function updateCustomerLtv(customerId) {
  const stats = await pool.query(`
    SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(total_amount), 0) as total_revenue,
      COALESCE(AVG(total_amount), 0) as avg_order_value,
      MIN(created_at) as first_order_at,
      MAX(created_at) as last_order_at
    FROM orders
    WHERE customer_id = $1 AND status NOT IN ('cancelled','refunded')`,
    [customerId]
  );
  const s = stats.rows[0];

  await pool.query(`
    INSERT INTO customer_ltv (customer_id, total_orders, total_revenue, avg_order_value, first_order_at, last_order_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (customer_id) DO UPDATE SET
      total_orders = EXCLUDED.total_orders,
      total_revenue = EXCLUDED.total_revenue,
      avg_order_value = EXCLUDED.avg_order_value,
      first_order_at = EXCLUDED.first_order_at,
      last_order_at = EXCLUDED.last_order_at,
      updated_at = NOW()`,
    [customerId, s.total_orders, s.total_revenue, s.avg_order_value, s.first_order_at, s.last_order_at]
  );
}

// ============================================================
// EVENTS
// ============================================================

async function trackEvent(customerId, sessionId, eventType, eventData = {}) {
  try {
    await pool.query(
      `INSERT INTO events (customer_id, session_id, event_type, event_data)
       VALUES ($1, $2, $3, $4)`,
      [customerId, sessionId, eventType, JSON.stringify(eventData)]
    );
  } catch (err) {
    // Don't crash the main flow if event tracking fails
    console.warn('Event tracking error:', err.message);
  }
}

/**
 * Give an identity row to any customer that lacks one — covers rows written
 * while the app was running an older build. Cheap and idempotent.
 */
async function healIdentities(client) {
  try {
    const r = await client.query(`
      INSERT INTO customer_identities (customer_id, channel, external_id)
      SELECT c.id,
             CASE
               WHEN c.zalo_user_id LIKE 'bot\\_%'  THEN 'bot'
               WHEN c.zalo_user_id LIKE 'fb\\_%'   THEN 'messenger'
               WHEN c.zalo_user_id LIKE 'test\\_%' THEN 'test'
               WHEN c.zalo_user_id = 'debug_user'  THEN 'test'
               ELSE 'oa'
             END,
             c.zalo_user_id
      FROM customers c
      WHERE c.zalo_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM customer_identities i WHERE i.customer_id = c.id)
      ON CONFLICT (channel, external_id) DO NOTHING`);
    if (r.rowCount > 0) console.log(`🔗 Healed ${r.rowCount} missing customer identities`);
  } catch (e) {
    console.warn('Identity heal skipped:', e.message);
  }
}

// ============================================================
// initDB — migration runner
// Applies every supabase/migrations/*.sql that hasn't run yet,
// in filename order, recording each in _migrations.
// ============================================================
async function initDB() {
  if (!DB_ENABLED) {
    console.log('ℹ️  DATABASE_URL not set — running without database (no persistent memory/orders).');
    return;
  }
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    // Databases migrated before the runner existed already have 001 applied.
    const legacy = await client.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='ai_memories') AS e`
    );
    if (legacy.rows[0].e) {
      await client.query(
        `INSERT INTO _migrations (filename) VALUES ('001_full_schema.sql') ON CONFLICT DO NOTHING`
      );
    }

    // Extensions are environment-dependent (Railway Postgres has no pgvector).
    let hasUuidOssp = false;
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      hasUuidOssp = true;
    } catch (e) {
      console.warn('⚠️  uuid-ossp unavailable → using built-in gen_random_uuid()');
    }
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (e) {
      // pgvector not present — no vector columns in our schema, safe to skip.
    }

    if (!fs.existsSync(dir)) {
      console.error('❌ Migrations folder not found:', dir);
      return;
    }

    const done = new Set(
      (await client.query('SELECT filename FROM _migrations')).rows.map(r => r.filename)
    );
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const pending = files.filter(f => !done.has(f));

    if (pending.length === 0) {
      console.log('✅ Database schema up to date');
      await healIdentities(client);
      return;
    }

    for (const file of pending) {
      let sql = fs.readFileSync(path.join(dir, file), 'utf8');
      sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS\s+"?[\w-]+"?\s*;/gi, '');
      if (!hasUuidOssp) sql = sql.replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');

      console.log(`🔧 Applying migration ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✅ ${file} applied`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${e.message}`);
      }
    }
    await healIdentities(client);
  } catch (err) {
    console.error('❌ DB init failed:', err.message);
    console.error('   Bot keeps running without persistence.');
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  DB_ENABLED,
  initDB,
  // Identity
  getCustomerByExternalId,
  linkIdentity,
  getIdentities,
  mergeCustomers,
  setPhoneAndMerge,
  normalizePhone,
  parseKey,
  // Customer
  getCustomerByZaloId,
  getCustomer,
  getOrCreateCustomer,
  updateCustomer,
  setGender,
  // Handoff
  pauseBot,
  resumeBot,
  listPaused,
  // Conversation
  getOrCreateSession,
  saveMessage,
  getConversationHistory,
  // Memory
  saveMemory,
  getTopMemories,
  // Orders
  createOrder,
  createOrderNew,
  getCustomerOrders,
  getRecentOrders,
  // Preferences
  getCustomerPreferences,
  // LTV
  updateCustomerLtv,
  // Events
  trackEvent,
};
