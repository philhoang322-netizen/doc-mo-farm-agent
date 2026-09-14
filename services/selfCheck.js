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
const ops = require('./ops');
const vietqr = require('./vietqr');
const kiotviet = require('./kiotviet');

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
    active_locks: ops.activeLocks(),
    vietqr_configured: vietqr.configured(),
    kiotviet: await kiotviet.ping(),
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
  if (h.kiotviet?.enabled && h.kiotviet.ok === false) {
    p.push(`KiotViet không gọi được: ${h.kiotviet.error || 'không rõ'} — đơn sẽ phải nhập tay.`);
  }
  if (h.active_locks > 50) {
    p.push(`${h.active_locks} khoá đang treo — có thể một câu trả lời bị kẹt.`);
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

/**
 * Yesterday-and-today business summary, in the farm's language.
 * Sent every morning and available on demand via /baocao.
 */
async function dailyReportText() {
  if (!db.DB_ENABLED) return 'Chưa kết nối database nên chưa có số liệu ạ.';
  const q = async (sql, p = []) => (await db.pool.query(sql, p)).rows;

  const [today] = await q(`
    SELECT
      (SELECT COUNT(*)::int FROM messages WHERE created_at::date = CURRENT_DATE) AS msgs,
      (SELECT COUNT(DISTINCT customer_id)::int FROM messages WHERE created_at::date = CURRENT_DATE) AS chatters,
      (SELECT COUNT(*)::int FROM customers WHERE created_at::date = CURRENT_DATE) AS new_customers,
      (SELECT COUNT(*)::int FROM orders WHERE created_at::date = CURRENT_DATE) AS orders,
      (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE created_at::date = CURRENT_DATE
         AND status NOT IN ('cancelled','refunded')) AS revenue`);

  const [week] = await q(`
    SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_amount),0) AS revenue
    FROM orders WHERE created_at > NOW() - INTERVAL '7 days'
      AND status NOT IN ('cancelled','refunded')`);

  const topProducts = await q(`
    SELECT oi.product_name, SUM(oi.quantity)::int AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at > NOW() - INTERVAL '7 days'
      AND o.status NOT IN ('cancelled','refunded')
    GROUP BY oi.product_name ORDER BY qty DESC LIMIT 3`);

  const waiting = await db.listPaused();
  const pendingOrders = await q(
    `SELECT order_number, total_amount FROM orders WHERE status='pending' ORDER BY created_at DESC LIMIT 5`
  );

  const money = n => Number(n || 0).toLocaleString('vi') + 'đ';
  const L = [
    `☀️ Dốc Mơ Farm — báo cáo ${new Date().toLocaleDateString('vi-VN')}`,
    '',
    `💬 Hôm nay: ${today.msgs} tin · ${today.chatters} khách trò chuyện · ${today.new_customers} khách mới`,
    `🛒 Đơn hôm nay: ${today.orders} · ${money(today.revenue)}`,
    `📈 7 ngày: ${week.orders} đơn · ${money(week.revenue)}`,
  ];

  if (topProducts.length) {
    L.push('', '🔥 Bán chạy 7 ngày:');
    topProducts.forEach((p, i) => L.push(`  ${i + 1}. ${p.product_name} — ${p.qty}`));
  }
  if (pendingOrders.length) {
    L.push('', `⏳ Đơn chờ xử lý (${pendingOrders.length}):`);
    pendingOrders.forEach(o => L.push(`  • ${o.order_number} — ${money(o.total_amount)}`));
  }
  if (waiting.length) {
    L.push('', `🙋 ${waiting.length} khách đang chờ người thật — gõ /cho để xem`);
  }
  if (today.orders === 0 && today.msgs === 0) {
    L.push('', 'Hôm nay chưa có ai nhắn ạ.');
  }
  return L.join('\n');
}

/**
 * Weekly lead digest.
 *
 * The daily report says how business went. This says who is still worth a
 * phone call: people who talked to the farm this week, showed real interest,
 * and did not buy. Without it they sit in the database and quietly go cold.
 */
async function weeklyLeadsText() {
  if (!db.DB_ENABLED) return 'Chưa kết nối database nên chưa có số liệu ạ.';
  const q = async (sql, p = []) => (await db.pool.query(sql, p)).rows;

  const leads = await q(`
    SELECT c.id, c.display_name, c.full_name, c.phone, c.gender,
           c.convo_summary, c.last_seen_at, c.bot_paused, c.followup_stage,
           c.interest_product, c.interest_note, c.lead_stage,
           (SELECT COUNT(*)::int FROM messages m WHERE m.customer_id = c.id) AS msgs,
           (SELECT i.external_id FROM customer_identities i
             WHERE i.customer_id = c.id ORDER BY i.created_at LIMIT 1) AS ext
    FROM customers c
    WHERE c.last_seen_at > NOW() - INTERVAL '7 days'
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
      AND (SELECT COUNT(*) FROM messages m WHERE m.customer_id = c.id) >= 3
    ORDER BY
      -- Closest to buying first: that is where a phone call pays off most.
      CASE c.lead_stage WHEN 'deciding' THEN 1 WHEN 'interested' THEN 2
                        WHEN 'browsing' THEN 3 WHEN 'lost' THEN 5 ELSE 4 END,
      c.last_seen_at DESC
    LIMIT 20`);

  const [won] = await q(`
    SELECT COUNT(DISTINCT o.customer_id)::int AS buyers,
           COUNT(*)::int AS orders,
           COALESCE(SUM(o.total_amount),0) AS revenue
    FROM orders o
    WHERE o.created_at > NOW() - INTERVAL '7 days'
      AND o.status NOT IN ('cancelled','refunded')`);

  const [talked] = await q(`
    SELECT COUNT(DISTINCT customer_id)::int AS n FROM messages
    WHERE created_at > NOW() - INTERVAL '7 days'`);

  const money = n => Number(n || 0).toLocaleString('vi') + 'đ';
  const rate = talked.n > 0 ? Math.round((won.buyers / talked.n) * 100) : 0;

  const L = [
    '📊 Dốc Mơ Farm — khách tiềm năng tuần này',
    '',
    `Đã trò chuyện: ${talked.n} khách`,
    `Đã mua: ${won.buyers} khách · ${won.orders} đơn · ${money(won.revenue)}`,
    `Tỉ lệ chốt: ${rate}%`,
  ];

  if (leads.length === 0) {
    L.push('', 'Không có khách nào đang bỏ ngỏ. Tuần sạch ✅');
    return L.join('\n');
  }

  L.push('', `🙋 ${leads.length} khách đã hỏi mà chưa mua:`, '');
  const STAGE = {
    deciding: '🔥 sắp chốt',
    interested: '👀 đang quan tâm',
    browsing: '· hỏi dạo',
    lost: '✕ đã từ chối',
    new: '· mới',
  };

  leads.forEach((c, i) => {
    const call = c.gender === 'male' ? 'anh ' : c.gender === 'female' ? 'chị ' : '';
    const days = Math.floor((Date.now() - new Date(c.last_seen_at).getTime()) / 86400000);
    L.push(`${i + 1}. ${STAGE[c.lead_stage] || '·'} ${call}${c.display_name || c.full_name || 'Khách'}` +
           `${c.phone ? ` · ${c.phone}` : ' · chưa có số'}`);
    if (c.interest_product) {
      L.push(`   Muốn: ${c.interest_product}${c.interest_note ? ` — ${c.interest_note}` : ''}`);
    } else if (c.convo_summary) {
      L.push(`   ${c.convo_summary.split('\n')[0].slice(0, 110)}`);
    }
    L.push(`   ${c.msgs} tin · ${days === 0 ? 'hôm nay' : days + ' ngày trước'}` +
           `${c.bot_paused ? ' · ĐANG CHỜ NGƯỜI THẬT' : ''}` +
           `${c.followup_stage >= 2 ? ' · đã nhắc 2 lần' : ''}`);
    L.push('');
  });

  L.push('Khách có số điện thoại thì gọi trực tiếp thường ăn hơn nhắn tin.');
  return L.join('\n');
}

/** Fire the morning report once per day, at REPORT_HOUR local time. */
function startDailyReport() {
  if (process.env.DAILY_REPORT_ENABLED === 'false') return;
  const hour = Number(process.env.DAILY_REPORT_HOUR || 8);
  const tz = process.env.TZ_NAME || 'Asia/Ho_Chi_Minh';
  let lastSentDay = null;

  const tick = async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', day: '2-digit', hour12: false,
    }).formatToParts(now);
    const hh = Number(parts.find(p => p.type === 'hour').value);
    const dd = parts.find(p => p.type === 'day').value;
    if (hh === hour && lastSentDay !== dd) {
      lastSentDay = dd;
      try {
        await notifyOwner(await dailyReportText());
        console.log('📬 Daily report sent');

        // Monday also gets the lead digest — sent second so it lands under
        // the daily numbers rather than competing with them.
        const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' })
          .format(new Date());
        if (weekday === 'Mon') {
          await notifyOwner(await weeklyLeadsText());
          console.log('📊 Weekly lead digest sent');
        }
      } catch (e) {
        console.error('Daily report failed:', e.message);
      }
    }
  };

  const t = setInterval(tick, 10 * 60 * 1000); // check every 10 minutes
  if (t.unref) t.unref();
  console.log(`📬 Daily report at ${hour}:00 ${tz}`);
}

function start() {
  startDailyReport();
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

module.exports = {
  start, run, gather, getLastReport, notifyOwner, dailyReportText, weeklyLeadsText,
};
