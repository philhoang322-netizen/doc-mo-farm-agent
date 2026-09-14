/**
 * Self-check — runs on a timer inside the server.
 *
 * Gathers the same picture as /debug/health, repairs what it safely can
 * (merging customers that share a phone), and pings the owner on Zalo
 * ONLY when something is wrong. Silence means healthy.
 */
const db = require('./database');
const knowledge = require('./knowledge');
const zaloService = require('./zaloService');
const botService = require('./zaloBotService');

const DEFAULT_INTERVAL_H = Number(process.env.HEALTH_CHECK_INTERVAL_HOURS || 24);
const FIRST_RUN_DELAY_MS = 60 * 1000; // let the app finish booting

let lastReport = null;
let timer = null;

/** Read-only snapshot of everything that can rot quietly. */
async function gather() {
  const out = {
    at: new Date().toISOString(),
    db_enabled: db.DB_ENABLED,
    bot_enabled: !!process.env.ZALO_BOT_TOKEN,
    knowledge: knowledge.stats(),
    oa_token_present: !!zaloService.getTokens().accessToken,
    oa_last_error: zaloService.getLastError(),
  };

  if (db.DB_ENABLED) {
    const one = async (sql) => (await db.pool.query(sql)).rows[0];
    out.counts = {
      customers: (await one('SELECT COUNT(*)::int n FROM customers')).n,
      identities: (await one('SELECT COUNT(*)::int n FROM customer_identities')).n,
      messages: (await one('SELECT COUNT(*)::int n FROM messages')).n,
      orders: (await one('SELECT COUNT(*)::int n FROM orders')).n,
      merges: (await one('SELECT COUNT(*)::int n FROM customer_merges')).n,
    };
    out.duplicate_phones = (await db.pool.query(
      `SELECT phone, COUNT(*)::int n FROM customers
       WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING COUNT(*) > 1`
    )).rows;
    out.customers_without_identity = (await one(
      `SELECT COUNT(*)::int n FROM customers c
       WHERE NOT EXISTS (SELECT 1 FROM customer_identities i WHERE i.customer_id = c.id)`
    )).n;
    out.migrations = (await db.pool.query('SELECT filename FROM _migrations ORDER BY filename')).rows
      .map(r => r.filename);
    out.messages_24h = (await one(
      `SELECT COUNT(*)::int n FROM messages WHERE created_at > NOW() - INTERVAL '24 hours'`
    )).n;
  }

  return out;
}

/** Merge every group of customers sharing a phone. Returns what it did. */
async function autoMerge(duplicates) {
  const done = [];
  for (const g of duplicates) {
    const rows = await db.pool.query(
      'SELECT id FROM customers WHERE phone=$1 ORDER BY first_seen_at ASC',
      [g.phone]
    );
    const survivor = rows.rows[0].id;
    for (const r of rows.rows.slice(1)) {
      try {
        await db.mergeCustomers(survivor, r.id, 'auto-sweep');
        done.push(g.phone);
      } catch (e) {
        console.error('Auto-merge failed for', g.phone, e.message);
      }
    }
  }
  return done;
}

/** Turn a snapshot into a list of human-readable problems. */
function findProblems(h) {
  const p = [];
  if (!h.db_enabled) p.push('Database chưa kết nối — bot không nhớ được khách.');
  if (!h.bot_enabled) p.push('ZALO_BOT_TOKEN trống — kênh Bot không chạy.');
  if (!h.oa_token_present) p.push('Token OA trống — kênh OA không trả lời được.');
  if (h.oa_last_error) {
    p.push(`Zalo OA báo lỗi ${h.oa_last_error.error}: ${h.oa_last_error.message}`);
  }
  if (h.knowledge && h.knowledge.sections === 0) p.push('Kho kiến thức sản phẩm rỗng.');
  if (h.customers_without_identity > 0) {
    p.push(`${h.customers_without_identity} khách chưa có danh tính kênh.`);
  }
  if (h.migrations && !h.migrations.includes('002_identities.sql')) {
    p.push('Migration 002 chưa chạy.');
  }
  return p;
}

function formatAlert(problems, merged) {
  const lines = ['⚠️ Dốc Mơ Farm AI — có việc cần xem', ''];
  for (const p of problems) lines.push(`• ${p}`);
  if (merged.length) {
    lines.push('', `🔗 Đã tự gộp ${merged.length} khách trùng số: ${merged.join(', ')}`);
  }
  lines.push('', `Chi tiết: ${process.env.PUBLIC_URL || 'https://docmofarm.com'}/debug/health?key=***`);
  return lines.join('\n');
}

/** One pass: gather → repair → alert if needed. */
async function run(reason = 'scheduled') {
  try {
    const before = await gather();

    let merged = [];
    if (before.duplicate_phones && before.duplicate_phones.length > 0) {
      merged = await autoMerge(before.duplicate_phones);
    }

    const after = merged.length > 0 ? await gather() : before;
    const problems = findProblems(after);

    lastReport = { ...after, reason, merged, problems, healthy: problems.length === 0 };

    if (problems.length === 0) {
      console.log(`💚 Self-check (${reason}): healthy${merged.length ? ` · merged ${merged.length}` : ''}`);
    } else {
      console.warn(`💛 Self-check (${reason}) found ${problems.length} problem(s):`, problems.join(' | '));
      await notifyOwner(formatAlert(problems, merged));
    }

    return lastReport;
  } catch (e) {
    console.error('Self-check crashed:', e.message);
    lastReport = { at: new Date().toISOString(), error: e.message, healthy: false };
    // A crashed self-check is itself worth reporting.
    await notifyOwner(`⚠️ Dốc Mơ Farm AI — self-check lỗi: ${e.message}`);
    return lastReport;
  }
}

/** Alerts go over the Bot channel: free, and not bound by OA messaging windows. */
async function notifyOwner(text) {
  const chatId = process.env.ALERT_BOT_CHAT_ID;
  if (!chatId) {
    console.warn('⚠️  ALERT_BOT_CHAT_ID not set — alert not delivered:\n' + text);
    return false;
  }
  try {
    const r = await botService.sendMessage(chatId, text);
    return !!r;
  } catch (e) {
    console.error('Alert send failed:', e.message);
    return false;
  }
}

function start() {
  if (process.env.HEALTH_CHECK_ENABLED === 'false') {
    console.log('ℹ️  Self-check disabled by HEALTH_CHECK_ENABLED=false');
    return;
  }
  const hours = DEFAULT_INTERVAL_H > 0 ? DEFAULT_INTERVAL_H : 24;
  setTimeout(() => run('startup').catch(() => {}), FIRST_RUN_DELAY_MS);
  timer = setInterval(() => run('scheduled').catch(() => {}), hours * 3600 * 1000);
  if (timer.unref) timer.unref();
  console.log(`🩺 Self-check every ${hours}h (first run in 60s)`);
}

function getLastReport() {
  return lastReport;
}

module.exports = { start, run, gather, getLastReport, notifyOwner };
