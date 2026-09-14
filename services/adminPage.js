/**
 * Server-rendered admin page. Deliberately one self-contained HTML string:
 * the farm opens it on a phone, so no build step and no external assets.
 */
const db = require('./database');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => Number(n || 0).toLocaleString('vi') + 'đ';

function when(d) {
  if (!d) return '';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return new Date(d).toLocaleDateString('vi-VN');
}

async function render(key) {
  if (!db.DB_ENABLED) {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">
      <h2>Chưa kết nối database</h2></body>`;
  }
  const q = async (sql, p = []) => (await db.pool.query(sql, p)).rows;

  const [stats] = await q(`
    SELECT
      (SELECT COUNT(*)::int FROM customers) AS customers,
      (SELECT COUNT(*)::int FROM customers WHERE created_at::date = CURRENT_DATE) AS new_today,
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE status NOT IN ('cancelled','refunded')) AS revenue,
      (SELECT COUNT(*)::int FROM messages WHERE created_at > NOW() - INTERVAL '24 hours') AS msgs24,
      (SELECT COUNT(*)::int FROM customers WHERE bot_paused = TRUE) AS waiting`);

  const customers = await q(`
    SELECT c.id, c.display_name, c.phone, c.customer_tier, c.bot_paused, c.paused_reason,
           c.last_seen_at,
           (SELECT COUNT(*)::int FROM messages m WHERE m.customer_id = c.id) AS msgs,
           (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = c.id) AS orders,
           (SELECT string_agg(i.channel, ',') FROM customer_identities i WHERE i.customer_id = c.id) AS channels,
           (SELECT i.external_id FROM customer_identities i WHERE i.customer_id = c.id LIMIT 1) AS ext
    FROM customers c ORDER BY c.last_seen_at DESC NULLS LAST LIMIT 50`);

  const orders = await q(`
    SELECT o.order_number, o.total_amount, o.status, o.created_at,
           c.display_name, c.phone
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    ORDER BY o.created_at DESC LIMIT 25`);

  const recent = await q(`
    SELECT m.role, m.content, m.created_at, c.display_name
    FROM messages m LEFT JOIN customers c ON c.id = m.customer_id
    ORDER BY m.created_at DESC LIMIT 40`);

  const card = (label, value, accent = '') =>
    `<div class="card"><div class="lbl">${label}</div><div class="val ${accent}">${value}</div></div>`;

  const rowsCustomers = customers.map(c => `
    <tr>
      <td><b>${esc(c.display_name || 'Khách')}</b>${c.bot_paused ? ' <span class="tag warn">chờ người</span>' : ''}
        <div class="sub">${esc(c.channels || '')}${c.ext ? ` · <code>${esc(c.ext)}</code>` : ''}</div></td>
      <td>${esc(c.phone || '—')}</td>
      <td class="num">${c.msgs}</td>
      <td class="num">${c.orders}</td>
      <td class="sub">${when(c.last_seen_at)}</td>
    </tr>`).join('');

  const rowsOrders = orders.map(o => `
    <tr>
      <td><code>${esc(o.order_number)}</code></td>
      <td>${esc(o.display_name || '—')}<div class="sub">${esc(o.phone || '')}</div></td>
      <td class="num">${money(o.total_amount)}</td>
      <td><span class="tag ${o.status === 'pending' ? 'warn' : ''}">${esc(o.status)}</span></td>
      <td class="sub">${when(o.created_at)}</td>
    </tr>`).join('');

  const chat = recent.reverse().map(m => `
    <div class="msg ${m.role}">
      <div class="who">${m.role === 'user' ? esc(m.display_name || 'Khách') : 'Bot'} · ${when(m.created_at)}</div>
      <div class="body">${esc(m.content).slice(0, 400)}</div>
    </div>`).join('');

  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Dốc Mơ Farm — Quản trị</title>
<style>
  :root { --bg:#faf8f5; --ink:#2c2a26; --soft:#8a8580; --line:#e8e3dc; --green:#4a7c59; --warn:#b8860b; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:20px 16px 8px; }
  h1 { font-size:20px; margin:0 0 2px; font-weight:650 }
  .sub { color:var(--soft); font-size:12px }
  .wrap { padding:0 16px 40px; max-width:960px; margin:0 auto }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin:16px 0 24px }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:12px 14px }
  .card .lbl { font-size:11px; color:var(--soft); text-transform:uppercase; letter-spacing:.04em }
  .card .val { font-size:22px; font-weight:650; margin-top:2px }
  .card .val.green { color:var(--green) } .card .val.warn { color:var(--warn) }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:var(--soft);
       margin:28px 0 10px; font-weight:600 }
  table { width:100%; border-collapse:collapse; background:#fff;
          border:1px solid var(--line); border-radius:12px; overflow:hidden }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
       color:var(--soft); padding:10px 12px; border-bottom:1px solid var(--line); font-weight:600 }
  td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top }
  tr:last-child td { border-bottom:none }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap }
  code { font-size:12px; background:#f2efe9; padding:1px 5px; border-radius:4px }
  .tag { font-size:11px; background:#eef2ee; color:var(--green); padding:2px 7px; border-radius:20px }
  .tag.warn { background:#fdf4e3; color:var(--warn) }
  .msg { background:#fff; border:1px solid var(--line); border-radius:10px; padding:9px 12px; margin-bottom:8px }
  .msg.assistant { background:#f6f8f6 }
  .msg .who { font-size:11px; color:var(--soft); margin-bottom:3px }
  .msg .body { white-space:pre-wrap; font-size:14px }
  .scroll { max-height:520px; overflow:auto }
  @media (max-width:600px){ .card .val{font-size:19px} td,th{padding:8px 9px} }
</style></head>
<body>
<header class="wrap">
  <h1>🌿 Dốc Mơ Farm — Quản trị</h1>
  <div class="sub">Cập nhật ${new Date().toLocaleString('vi-VN')} · tự làm mới mỗi 60 giây</div>
</header>
<div class="wrap">
  <div class="cards">
    ${card('Khách hàng', stats.customers)}
    ${card('Khách mới hôm nay', stats.new_today, 'green')}
    ${card('Đơn hàng', stats.orders)}
    ${card('Doanh thu', money(stats.revenue), 'green')}
    ${card('Tin nhắn 24h', stats.msgs24)}
    ${card('Chờ người thật', stats.waiting, stats.waiting > 0 ? 'warn' : '')}
  </div>

  <h2>Khách hàng gần đây</h2>
  <table><thead><tr><th>Khách</th><th>Điện thoại</th><th class="num">Tin</th><th class="num">Đơn</th><th>Lần cuối</th></tr></thead>
  <tbody>${rowsCustomers || '<tr><td colspan="5" class="sub">Chưa có khách nào.</td></tr>'}</tbody></table>

  <h2>Đơn hàng</h2>
  <table><thead><tr><th>Mã</th><th>Khách</th><th class="num">Tổng</th><th>Trạng thái</th><th>Lúc</th></tr></thead>
  <tbody>${rowsOrders || '<tr><td colspan="5" class="sub">Chưa có đơn nào.</td></tr>'}</tbody></table>

  <h2>Hội thoại gần nhất</h2>
  <div class="scroll">${chat || '<div class="sub">Chưa có tin nhắn.</div>'}</div>
</div>
<script>setTimeout(function(){location.reload()},60000)</script>
</body></html>`;
}

module.exports = { render };
