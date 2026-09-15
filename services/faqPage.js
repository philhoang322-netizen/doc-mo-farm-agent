/**
 * /faq — the FAQ workbench.
 *
 * Built for the real shape of the job: ~20 products, ~20 answers each. That
 * means a few hundred rows, so the page leads with search and keeps everything
 * collapsed; you open one answer at a time and the rest stays out of the way.
 *
 * Design decisions worth keeping:
 *  - Search filters as you type, in the browser. No round trip, no waiting.
 *  - Answers are collapsed by default (<details>) — native, keyboard-friendly,
 *    works without JavaScript.
 *  - "Viết lại giọng Thu" never writes to the database. It returns a proposal
 *    shown next to the original, and only "Dùng bản này" saves.
 *  - Auto-refresh is absent here on purpose: this is a writing surface.
 */
const db = require('./database');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd').toLowerCase();
}

async function render(key, opts = {}) {
  const { flash = null, proposal = null } = opts;

  if (!db.DB_ENABLED) {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">
      <h2>Chưa kết nối database</h2></body>`;
  }

  let rows = [];
  let products = [];
  try {
    rows = (await db.pool.query(
      `SELECT id, question, answer, COALESCE(product,'Chung') AS product, sku,
              is_active, sort_order, updated_at
       FROM bot_lessons ORDER BY product, sort_order, question`
    )).rows;
    products = (await db.pool.query(
      `SELECT name_vi, sku FROM products WHERE is_available = TRUE ORDER BY name_vi`
    )).rows;
  } catch (e) {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">
      <h2>Chưa chạy migration FAQ</h2><pre>${esc(e.message)}</pre></body>`;
  }

  // Group by product so a few hundred rows stay navigable.
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.product)) groups.set(r.product, []);
    groups.get(r.product).push(r);
  }

  // A product the farm sells but has written nothing about is the thing the
  // bot will fail on, and it is invisible unless the page says so. Show those
  // as empty groups rather than letting them silently not exist.
  const missing = products
    .map(p => p.name_vi)
    .filter(n => !groups.has(n));
  for (const n of missing) groups.set(n, []);

  const productOptions = [...new Set([
    ...products.map(p => p.name_vi),
    ...groups.keys(),
  ])].sort();

  const skuFor = (name) => products.find(p => p.name_vi === name)?.sku || '';

  const item = (r) => `
    <details class="faq" data-search="${esc(norm(r.question + ' ' + r.answer + ' ' + r.product))}"
             data-product="${esc(r.product)}" ${proposal && proposal.id === r.id ? 'open' : ''}>
      <summary>
        <span class="q">${esc(r.question)}</span>
        ${r.is_active ? '' : '<span class="tag off">tắt</span>'}
      </summary>
      <div class="ans">
        ${proposal && proposal.id === r.id ? proposalBlock(key, r, proposal) : editForm(key, r, productOptions)}
      </div>
    </details>`;

  const editForm = (k, r, opts2) => `
    <form method="post" action="/faq/save" class="grid">
      <input type="hidden" name="key" value="${esc(k)}">
      <input type="hidden" name="id" value="${esc(r.id)}">
      <label>Câu hỏi của khách
        <input name="question" class="in" value="${esc(r.question)}" required></label>
      <label>Câu trả lời của bot
        <textarea name="answer" class="in" rows="7" required>${esc(r.answer)}</textarea></label>
      <div class="row">
        <label class="grow">Thuộc sản phẩm
          <select name="product" class="in">
            ${opts2.map(p => `<option${p === r.product ? ' selected' : ''}>${esc(p)}</option>`).join('')}
            <option${r.product === 'Chung' ? ' selected' : ''}>Chung</option>
          </select></label>
        <label class="chk"><input type="checkbox" name="is_active" ${r.is_active ? 'checked' : ''}> Đang dùng</label>
      </div>
      <div class="row end">
        <button type="submit" formaction="/faq/rewrite" name="intent" value="rewrite" class="ghost">
          ✍️ Viết lại giọng Thu</button>
        <button type="submit" name="delete" value="1" class="danger">Xoá</button>
        <button type="submit" class="primary">Lưu</button>
      </div>
    </form>`;

  const proposalBlock = (k, r, pr) => `
    <div class="proposal">
      <div class="warnhead">
        Bản viết lại theo giọng Thu — <b>chưa lưu</b>. Đọc kỹ rồi quyết định.
        ${pr.tokens ? `<span class="sub"> · ${pr.tokens} token</span>` : ''}
      </div>
      ${(pr.warnings || []).length ? `<div class="warn">⚠️ ${pr.warnings.map(esc).join(' · ')}<br>
        <span class="sub">Kiểm lại trước khi dùng — có thể mất dữ kiện quan trọng.</span></div>` : ''}
      <div class="cols">
        <div><div class="collab">Bản hiện tại</div><pre class="old">${esc(r.answer)}</pre></div>
        <div><div class="collab new">Bản giọng Thu</div><pre class="new">${esc(pr.text)}</pre></div>
      </div>
      <form method="post" action="/faq/save" class="grid">
        <input type="hidden" name="key" value="${esc(k)}">
        <input type="hidden" name="id" value="${esc(r.id)}">
        <input type="hidden" name="question" value="${esc(r.question)}">
        <input type="hidden" name="product" value="${esc(r.product)}">
        <input type="hidden" name="is_active" value="${r.is_active ? 'on' : ''}">
        <label>Sửa thêm trước khi lưu, nếu cần
          <textarea name="answer" class="in" rows="7">${esc(pr.text)}</textarea></label>
        <div class="row end">
          <a class="ghost btn" href="/faq?key=${encodeURIComponent(k)}">Giữ bản cũ</a>
          <button type="submit" class="primary">Dùng bản này</button>
        </div>
      </form>
    </div>`;

  // Products with nothing written come first: that is the work to do.
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[1].length === 0 && b[1].length > 0) return -1;
    if (b[1].length === 0 && a[1].length > 0) return 1;
    return a[0].localeCompare(b[0], 'vi');
  });

  const sections = ordered.map(([prod, list]) => `
    <section class="group ${list.length ? '' : 'empty-group'}" data-group="${esc(norm(prod))}">
      <h2>${esc(prod)}
        <span class="count ${list.length ? '' : 'zero'}">${list.length || 'chưa có câu nào'}</span>
      </h2>
      ${list.length ? list.map(item).join('') : `
        <div class="nudge">
          Bot chưa biết gì về <b>${esc(prod)}</b> ngoài giá bán.
          Khách hỏi chi tiết là nó phải nói "farm sẽ hỏi lại".
          <a href="#them" onclick="document.getElementById('them').open=true;
             document.querySelector('#them select').value=${JSON.stringify(prod)};">
             Viết câu đầu tiên cho ${esc(prod)} →</a>
        </div>`}
    </section>`).join('');

  const addForm = `
    <details class="add" id="them">
      <summary>➕ Thêm câu hỏi mới</summary>
      <form method="post" action="/faq/save" class="grid">
        <input type="hidden" name="key" value="${esc(key)}">
        <label>Câu hỏi của khách
          <input name="question" class="in" placeholder="vd: Xúc xích để ngăn mát được mấy ngày?" required></label>
        <label>Câu trả lời của bot
          <textarea name="answer" class="in" rows="6" placeholder="Viết thô cũng được — lưu xong bấm Viết lại giọng Thu." required></textarea></label>
        <label>Thuộc sản phẩm
          <select name="product" class="in">
            ${productOptions.map(p => `<option>${esc(p)}</option>`).join('')}
            <option>Chung</option>
          </select></label>
        <div class="row end"><button type="submit" class="primary">Thêm</button></div>
      </form>
    </details>`;

  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>FAQ — Dốc Mơ Farm</title>
<style>
  :root { --bg:#faf8f5; --ink:#2c2a26; --soft:#8a8580; --line:#e8e3dc;
          --green:#4a7c59; --warn:#b8860b; --card:#fff; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1100px; margin:0 auto; padding:0 24px 80px }
  header { position:sticky; top:0; z-index:20; background:var(--bg);
           padding:18px 0 12px; border-bottom:1px solid var(--line) }
  h1 { font-size:20px; margin:0 0 3px; font-weight:650 }
  .sub { color:var(--soft); font-size:13px }
  a { color:var(--green) }
  .tools { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap }
  #q { flex:1; min-width:200px }
  .in { width:100%; font:inherit; color:inherit; background:var(--card);
        border:1px solid var(--line); border-radius:10px; padding:10px 12px }
  .in:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible {
        outline:2px solid var(--green); outline-offset:2px }
  select.in { cursor:pointer }
  textarea.in { resize:vertical; line-height:1.55 }
  button, .btn { font:inherit; font-weight:600; border-radius:10px; padding:10px 16px;
                 cursor:pointer; border:1px solid transparent; min-height:44px }
  .primary { background:var(--green); color:#fff }
  .ghost { background:var(--card); color:var(--ink); border-color:var(--line);
           text-decoration:none; display:inline-flex; align-items:center }
  .danger { background:transparent; color:#a33; border-color:#e3cccc }
  button:hover, .btn:hover { filter:brightness(.96); transition:filter .2s }
  h2 { font-size:15px; margin:26px 0 8px; font-weight:650;
       display:flex; align-items:center; gap:8px }
  .count { font-size:11px; font-weight:600; color:var(--soft);
           background:var(--line); border-radius:99px; padding:2px 8px }
  details.faq { background:var(--card); border:1px solid var(--line);
                border-radius:12px; margin-bottom:8px; overflow:hidden }
  details.faq > summary { list-style:none; cursor:pointer; padding:13px 15px;
                          display:flex; gap:10px; align-items:flex-start; min-height:44px }
  details.faq > summary::-webkit-details-marker { display:none }
  details.faq > summary::before { content:'▸'; color:var(--soft); flex:none; margin-top:1px }
  details.faq[open] > summary::before { content:'▾' }
  details.faq[open] > summary { border-bottom:1px solid var(--line); background:#fcfbf9 }
  .q { font-weight:600 }
  .tag.off { font-size:11px; background:#f2efe9; color:var(--soft);
             padding:1px 8px; border-radius:99px; margin-left:auto }
  .ans { padding:14px 15px }
  .grid { display:grid; gap:12px }
  label { display:block; font-size:12px; color:var(--soft) }
  label .in, label select { margin-top:5px }
  .row { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap }
  .row.end { justify-content:flex-end }
  .grow { flex:1; min-width:180px }
  .chk { display:flex; align-items:center; gap:6px; font-size:14px; color:var(--ink);
         padding-bottom:10px }
  .chk input { width:auto; min-height:auto }
  details.add { background:var(--card); border:1px dashed var(--line);
                border-radius:12px; margin-top:26px; padding:0 }
  details.add > summary { cursor:pointer; padding:14px 15px; font-weight:600; min-height:44px }
  details.add[open] > summary { border-bottom:1px solid var(--line) }
  details.add .grid { padding:14px 15px }
  .proposal { border:1px solid var(--green); border-radius:12px; padding:14px; background:#f7faf7 }
  .warnhead { font-size:13px; margin-bottom:10px }
  .warn { background:#fdf4e3; border:1px solid #efdfba; color:#7a5c12;
          padding:9px 11px; border-radius:9px; font-size:13px; margin-bottom:12px }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px }
  .collab { font-size:11px; color:var(--soft); text-transform:uppercase;
            letter-spacing:.05em; margin-bottom:4px; font-weight:600 }
  .collab.new { color:var(--green) }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:inherit;
        background:var(--card); border:1px solid var(--line); border-radius:9px; padding:11px }
  pre.new { border-color:#cfe3d5; background:#fff }
  .ok { position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:99;
        background:var(--green); color:#fff; padding:11px 18px; border-radius:99px;
        font-size:14px; font-weight:600; box-shadow:0 6px 20px rgba(0,0,0,.18) }
  .empty { color:var(--soft); padding:26px 0; text-align:center }
  .count.zero { background:#fdf3e0; color:var(--warn) }
  .empty-group h2 { color:var(--warn) }
  .nudge { background:var(--card); border:1px dashed #efdfba; border-radius:12px;
           padding:16px 18px; color:var(--soft); font-size:15px; line-height:1.6 }
  .nudge b { color:var(--ink) }
  .nudge a { display:inline-block; margin-top:8px; font-weight:650 }
  .busy { opacity:.55; pointer-events:none }
  @media (max-width:640px){ .cols { grid-template-columns:1fr } }
  @media (prefers-reduced-motion:reduce){ * { transition:none !important; animation:none !important } }
</style></head>
<body>
${flash ? `<div class="ok" id="flash">${esc(flash)}</div>` : ''}
<div class="wrap">
  <header>
    <h1>Câu hỏi thường gặp</h1>
    <div class="sub">${rows.length} câu · ${groups.size} sản phẩm${
      missing.length
        ? ` · <b style="color:var(--warn)">${missing.length} sản phẩm chưa có câu nào</b>`
        : ''
    } · <a href="/admin?key=${encodeURIComponent(key)}">← Về trang quản trị</a></div>
    <div class="tools">
      <input id="q" class="in" type="search" placeholder="Tìm câu hỏi, nội dung, sản phẩm…"
             autocomplete="off" aria-label="Tìm trong FAQ">
      <select id="filter" class="in" style="width:auto" aria-label="Lọc theo sản phẩm">
        <option value="">Tất cả sản phẩm</option>
        ${[...groups.keys()].map(p => `<option>${esc(p)}</option>`).join('')}
      </select>
    </div>
  </header>

  <div id="list">
    ${sections || '<div class="empty">Chưa có câu nào. Bấm “Thêm câu hỏi mới” bên dưới.</div>'}
    <div class="empty" id="noresult" hidden>
      Không tìm thấy câu nào khớp.<br>
      <span class="sub">Thử từ khoá ngắn hơn, hoặc bỏ bộ lọc sản phẩm.</span>
    </div>
  </div>

  ${addForm}
</div>

<script>
(function () {
  var q = document.getElementById('q');
  var filter = document.getElementById('filter');
  var noresult = document.getElementById('noresult');

  function strip(s) {
    return s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/đ/gi,'d').toLowerCase();
  }
  function apply() {
    var term = strip(q.value.trim());
    var prod = filter.value;
    var shown = 0;
    document.querySelectorAll('details.faq').forEach(function (el) {
      var okText = !term || el.dataset.search.indexOf(term) !== -1;
      var okProd = !prod || el.dataset.product === prod;
      var vis = okText && okProd;
      el.hidden = !vis;
      if (vis) shown++;
    });
    document.querySelectorAll('section.group').forEach(function (s) {
      s.hidden = !s.querySelector('details.faq:not([hidden])');
    });
    noresult.hidden = shown > 0;
  }
  var t;
  q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(apply, 120); });
  filter.addEventListener('change', apply);

  // Rewriting calls a model and takes a few seconds — say so, and stop
  // double submits, which would bill twice and race each other.
  document.addEventListener('submit', function (e) {
    var b = e.submitter;
    if (b && b.value === 'rewrite') {
      b.textContent = '✍️ Đang viết lại…';
      e.target.classList.add('busy');
    }
  });

  var flash = document.getElementById('flash');
  if (flash) {
    setTimeout(function(){ flash.style.transition='opacity .4s'; flash.style.opacity='0'; }, 2600);
    setTimeout(function(){ flash.remove(); }, 3100);
  }

  // Warn before losing an edit in progress.
  var dirty = false;
  document.addEventListener('input', function(e){ if (e.target.closest('form')) dirty = true; });
  document.addEventListener('submit', function(){ dirty = false; });
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
})();
</script>
</body></html>`;
}

module.exports = { render };
