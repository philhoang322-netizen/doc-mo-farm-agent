/**
 * Durable key/value state (app_state table).
 *
 * Exists because Zalo rotates the refresh token on every renewal: keeping it
 * only in memory means the next restart falls back to an already-spent token
 * and the OA channel dies silently.
 */
const db = require('./database');

async function get(key) {
  if (!db.DB_ENABLED) return null;
  try {
    const r = await db.pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  } catch (e) {
    console.warn('state.get failed:', e.message);
    return null;
  }
}

async function set(key, value) {
  if (!db.DB_ENABLED) return false;
  try {
    await db.pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value == null ? null : String(value)]
    );
    return true;
  } catch (e) {
    console.warn('state.set failed:', e.message);
    return false;
  }
}

async function getMany(keys) {
  if (!db.DB_ENABLED) return {};
  try {
    const r = await db.pool.query('SELECT key, value FROM app_state WHERE key = ANY($1)', [keys]);
    return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  } catch (e) {
    return {};
  }
}

module.exports = { get, set, getMany };
