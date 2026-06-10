const { Pool } = require('pg');

// DB is OPTIONAL. Without DATABASE_URL the bot still answers —
// it just has no long-term memory/orders (in-memory history only).
const DB_ENABLED = !!process.env.DATABASE_URL;

const pool = DB_ENABLED
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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

async function getOrCreateCustomer(zaloUserId, name = null) {
  if (!DB_ENABLED) return null;
  const existing = await getCustomerByZaloId(zaloUserId);
  if (existing) {
    // Update last_seen
    await pool.query(
      'UPDATE customers SET last_seen_at = NOW() WHERE zalo_user_id = $1',
      [zaloUserId]
    );
    return existing;
  }
  const result = await pool.query(
    `INSERT INTO customers (zalo_user_id, display_name, full_name, last_seen_at)
     VALUES ($1, $2, $2, NOW()) RETURNING *`,
    [zaloUserId, name]
  );
  // Create empty LTV record
  await pool.query(
    'INSERT INTO customer_ltv (customer_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [result.rows[0].id]
  );
  return result.rows[0];
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
  const customer = await getCustomerByZaloId(zaloUserId);
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
  const result = await pool.query(
    `SELECT role, content, created_at
     FROM messages
     WHERE zalo_user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
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

// ============================================================
// LEGACY initDB — runs migration if tables don't exist
// Just ensures the DB is usable on fresh start
// ============================================================
async function initDB() {
  if (!DB_ENABLED) {
    console.log('ℹ️  DATABASE_URL not set — running without database (no persistent memory/orders).');
    return;
  }
  const client = await pool.connect();
  try {
    // Check if new schema is already applied
    const check = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'ai_memories'
      ) as exists`);

    if (check.rows[0].exists) {
      console.log('✅ Database schema up to date');
      return;
    }

    console.log('⚠️  New schema not found. Please run: psql $DATABASE_URL < supabase/migrations/001_full_schema.sql');
    console.log('   Or apply it via Supabase dashboard SQL editor.');
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDB,
  // Customer
  getCustomerByZaloId,
  getCustomer,
  getOrCreateCustomer,
  updateCustomer,
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
