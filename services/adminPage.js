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

async function render(key, flash = null) {
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
    SELECT o.id, o.order_number, o.total_amount, o.status, o.created_at,
           c.display_name, c.phone
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    ORDER BY o.created_at DESC LIMIT 25`);

  const products = await q(
    `SELECT id, sku, name_vi, base_price, sale_price, unit, stock_qty, is_available
     FROM products ORDER BY is_available DESC, name_vi`
  );

  let lessons = [];
  let botRules = '';
  try {
    lessons = await q(
      'SELECT id, question, answer, is_active FROM bot_lessons ORDER BY updated_at DESC LIMIT 50'
    );
    const r = await q(`SELECT value FROM app_state WHERE key = 'bot_rules'`);
    botRules = r[0]?.value || '';
  } catch (e) {
    // Migration 004 not applied yet — show the sections empty rather than 500.
  }

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

  const STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];

  const rowsOrders = orders.map(o => `
    <tr>
      <td><code>${esc(o.order_number)}</code></td>
      <td>${esc(o.display_name || '—')}<div class="sub">${esc(o.phone || '')}</div></td>
      <td class="num">${money(o.total_amount)}</td>
      <td>
        <form method="post" action="/admin/order" class="inline">
          <input type="hidden" name="key" value="${esc(key)}">
          <input type="hidden" name="id" value="${esc(o.id)}">
          <select name="status" onchange="this.form.submit()">
            ${STATUSES.map(s => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </form>
      </td>
      <td class="sub">${when(o.created_at)}</td>
    </tr>`).join('');

  // Each product is its own form. A <form> inside <tr> is invalid HTML and
  // browsers hoist it out of the table, so these are cards, not table rows.
  const cardsProducts = products.map(p => `
    <form method="post" action="/admin/product" class="prod ${p.is_available ? '' : 'off'}">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="id" value="${esc(p.id)}">
      <div class="prod-head">
        <input name="name_vi" value="${esc(p.name_vi)}" class="in name">
        <code>${esc(p.sku)}</code>
      </div>
      <div class="prod-grid">
        <label>Giá<input name="base_price" type="number" step="1000" value="${Number(p.base_price)}" class="in"></label>
        <label>Giá KM<input name="sale_price" type="number" step="1000" value="${p.sale_price ?? ''}" placeholder="—" class="in"></label>
        <label>Đơn vị<input name="unit" value="${esc(p.unit)}" class="in"></label>
        <label>Tồn<input name="stock_qty" type="number" value="${p.stock_qty ?? 0}" class="in"></label>
      </div>
      <div class="prod-foot">
        <label class="chk"><input type="checkbox" name="is_available" ${p.is_available ? 'checked' : ''}> Đang bán</label>
        <button type="submit">Lưu</button>
      </div>
    </form>`).join('');

  const newProductForm = `
    <form method="post" action="/admin/product" class="prod new">
      <input type="hidden" name="key" value="${esc(key)}">
      <div class="prod-head"><input name="name_vi" placeholder="Tên sản phẩm mới" class="in name" required></div>
      <div class="prod-grid">
        <label>SKU<input name="sku" placeholder="DMF-XXX-001" class="in" required></label>
        <label>Giá<input name="base_price" type="number" step="1000" placeholder="0" class="in" required></label>
        <label>Đơn vị<input name="unit" placeholder="chai" class="in"></label>
        <label>Tồn<input name="stock_qty" type="number" placeholder="0" class="in"></label>
      </div>
      <div class="prod-foot">
        <span class="sub">Thêm sản phẩm — bot dùng ngay sau 1 phút</span>
        <button type="submit">Thêm</button>
      </div>
    </form>`;

  // Oldest-first so a bot reply sits under the question it answered — that
  // pairing is what makes the "Dạy lại" button useful.
  const ordered = recent.reverse();
  const chat = ordered.map((m, i) => {
    const head = `<div class="who">${m.role === 'user' ? esc(m.display_name || 'Khách') : 'Bot'} · ${when(m.created_at)}</div>`;
    const body = `<div class="body">${esc(m.content).slice(0, 600)}</div>`;
    if (m.role !== 'assistant') return `<div class="msg ${m.role}">${head}${body}</div>`;

    // The customer message immediately before is the question this answered.
    let q = '';
    for (let j = i - 1; j >= 0; j--) {
      if (ordered[j].role === 'user') { q = ordered[j].content; break; }
    }
    return `<div class="msg assistant">${head}${body}
      <details class="teach">
        <summary>✏️ Dạy lại câu này</summary>
        <form method="post" action="/admin/lesson">
          <input type="hidden" name="key" value="${esc(key)}">
          <label>Khi khách hỏi<input name="question" class="in" value="${esc(q).slice(0, 300)}"></label>
          <label>Bot phải trả lời<textarea name="answer" class="in" rows="4"
            placeholder="Gõ câu trả lời đúng mà bạn muốn bot dùng từ giờ...">${esc(m.content).slice(0, 900)}</textarea></label>
          <button type="submit">Lưu bài học</button>
        </form>
      </details>
    </div>`;
  }).join('');

  const lessonCards = lessons.map(l => `
    <form method="post" action="/admin/lesson" class="prod">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="id" value="${esc(l.id)}">
      <label class="sub">Khách hỏi<input name="question" class="in" value="${esc(l.question)}"></label>
      <label class="sub">Bot trả lời<textarea name="answer" class="in" rows="4">${esc(l.answer)}</textarea></label>
      <div class="prod-foot">
        <label class="chk"><input type="checkbox" name="is_active" ${l.is_active ? 'checked' : ''}> Đang dùng</label>
        <span>
          <button type="submit">Lưu</button>
          <button type="submit" name="delete" value="1" class="danger">Xoá</button>
        </span>
      </div>
    </form>`).join('');

  const newLesson = `
    <form method="post" action="/admin/lesson" class="prod new">
      <input type="hidden" name="key" value="${esc(key)}">
      <label class="sub">Khách hỏi<input name="question" class="in" placeholder="vd: Giao hàng mất mấy ngày?" required></label>
      <label class="sub">Bot trả lời<textarea name="answer" class="in" rows="4" placeholder="Câu trả lời đúng bạn muốn bot dùng..." required></textarea></label>
      <div class="prod-foot"><span class="sub">Thêm câu mẫu</span><button type="submit">Thêm</button></div>
    </form>`;

  const rulesForm = `
    <form method="post" action="/admin/rules">
      <input type="hidden" name="key" value="${esc(key)}">
      <textarea name="rules" class="in" rows="6" placeholder="Mỗi dòng một quy tắc. Ví dụ:
- Luôn nhắc khách giao hàng trong 2 ngày ở TP.HCM
- Không hứa chữa bệnh, không nói 'điều trị'
- Nếu khách hỏi giá sỉ thì chuyển cho người thật
- Không dùng quá 2 emoji mỗi tin">${esc(botRules)}</textarea>
      <div class="prod-foot"><span class="sub">Áp dụng cho mọi câu trả lời, có hiệu lực sau 1 phút</span>
      <button type="submit">Lưu quy tắc</button></div>
    </form>`;

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
  form.inline { margin:0 }
  select, .in { font:inherit; color:inherit; background:#fff; border:1px solid var(--line);
                border-radius:7px; padding:5px 7px; width:100% }
  .in.name { font-weight:600 }
  button { font:inherit; font-weight:600; background:var(--green); color:#fff; border:0;
           border-radius:8px; padding:7px 16px; cursor:pointer }
  .prods { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:10px }
  .prod { background:#fff; border:1px solid var(--line); border-radius:12px; padding:12px }
  .prod.off { opacity:.55 }
  .prod.new { border-style:dashed }
  .prod-head { display:flex; gap:8px; align-items:center; margin-bottom:8px }
  .prod-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px }
  .prod-grid label { font-size:11px; color:var(--soft) }
  .prod-foot { display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:8px }
  .chk { font-size:13px; display:flex; gap:5px; align-items:center }
  .chk input { width:auto }
  /* Fixed, not inline: the farm is usually scrolled far down when they save,
     and a banner at the top of the document would go unseen. */
  .ok { position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:99;
        background:var(--green); color:#fff; border:0;
        padding:11px 18px; border-radius:999px; font-size:14px; font-weight:600;
        box-shadow:0 6px 20px rgba(0,0,0,.18); animation:pop .25s ease }
  @keyframes pop { from{opacity:0;transform:translate(-50%,-8px)} to{opacity:1} }
  textarea.in { resize:vertical; font-size:14px; line-height:1.45 }
  button.danger { background:transparent; color:#a33; border:1px solid #e3cccc; margin-left:6px }
  .teach { margin-top:8px; border-top:1px dashed var(--line); padding-top:7px }
  .teach summary { cursor:pointer; font-size:12px; color:var(--soft); user-select:none }
  .teach form { margin-top:8px; display:grid; gap:8px }
  .teach label, .prod label.sub { display:block; font-size:11px; color:var(--soft) }
  .teach label input, .teach label textarea { margin-top:3px }
  .prod label.sub + label.sub { margin-top:8px }
  @media (max-width:600px){ .card .val{font-size:19px} td,th{padding:8px 9px} }
</style></head>
<body>
<header class="wrap">
  <h1>🌿 Dốc Mơ Farm — Quản trị</h1>
  <div class="sub">Cập nhật ${new Date().toLocaleString('vi-VN')} ·
    <span id="auto">Tự làm mới mỗi 60 giây, dừng khi bạn đang nhập</span> ·
    <a href="#" onclick="location.reload();return false">Làm mới ngay</a></div>
</header>
<div class="wrap">
  ${flash ? `<div class="ok" id="flash">${esc(flash)}</div>` : ''}
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

  <h2 id="gia">Bảng giá — sửa ở đây, bot cập nhật ngay</h2>
  <div class="prods">${cardsProducts}${newProductForm}</div>

  <h2>Đơn hàng</h2>
  <table><thead><tr><th>Mã</th><th>Khách</th><th class="num">Tổng</th><th>Trạng thái</th><th>Lúc</th></tr></thead>
  <tbody>${rowsOrders || '<tr><td colspan="5" class="sub">Chưa có đơn nào.</td></tr>'}</tbody></table>

  <h2 id="quytac">Quy tắc chung cho bot</h2>
  ${rulesForm}

  <h2 id="caumau">Câu trả lời mẫu — bot ưu tiên dùng (${lessons.length})</h2>
  <div class="prods">${lessonCards}${newLesson}</div>

  <h2>Hội thoại gần nhất — bấm "Dạy lại" dưới câu bot trả lời</h2>
  <div class="scroll">${chat || '<div class="sub">Chưa có tin nhắn.</div>'}</div>
</div>
<script>
// Auto-refresh keeps the numbers current, but it must never eat something
// the farm is in the middle of typing. Any edit, any focused field, or any
// open "Dạy lại" panel cancels it until the page is reloaded by hand.
(function () {
  var dirty = false;
  document.addEventListener('input', function () { dirty = true; markPaused(); });
  document.addEventListener('submit', function () { dirty = false; });

  function busy() {
    if (dirty) return true;
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    if (document.querySelector('details.teach[open]')) return true;
    return false;
  }
  function markPaused() {
    var el = document.getElementById('auto');
    if (el) el.textContent = 'Tự làm mới: đã tạm dừng vì bạn đang nhập';
  }
  setInterval(function () { if (!busy()) location.reload(); }, 60000);

  // Fade the toast out; keep the URL clean so a manual refresh doesn't re-show it.
  var flash = document.getElementById('flash');
  if (flash) {
    setTimeout(function () { flash.style.transition = 'opacity .4s'; flash.style.opacity = '0'; }, 2600);
    setTimeout(function () { flash.remove(); }, 3100);
    if (history.replaceState) {
      var u = new URL(location.href); u.searchParams.delete('ok');
      history.replaceState(null, '', u.toString() + location.hash);
    }
  }

  // Come back to the section you were editing instead of the top of the page.
  if (location.hash) {
    var t = document.querySelector(location.hash);
    if (t) t.scrollIntoView();
  }
  document.addEventListener('focusin', function (e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) markPaused();
  });
})();
</script>
</body></html>`;
}

module.exports = { render };
