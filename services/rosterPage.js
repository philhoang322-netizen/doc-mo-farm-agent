/**
 * Minimal Omni Sale DMF page: edit shifts, see who received each handover.
 * Served at GET /admin/roster behind the same ADMIN_PASSWORD session as
 * the draft review queue.
 */
const { MODE_TEXT } = require('./handover');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

function when(d) {
  if (!d) return '';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (Number.isNaN(diff)) return '';
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return new Date(d).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function clock(mins) {
  if (mins == null) return '';
  if (mins === 1440) return '24:00';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function shiftForm(s) {
  const editing = !!s;
  return `
    <div class="draft">
      <form method="post" action="/admin/roster">
        ${editing ? `<input type="hidden" name="id" value="${esc(s.id)}">` : ''}
        <div class="grid">
          <label>Tên
            <input name="name" required maxlength="80" value="${esc(s?.name || '')}" placeholder="Lan">
          </label>
          <label>Chat Zalo Bot để báo
            <input name="notify_target" maxlength="120" value="${esc(s?.notify_target || '')}" placeholder="để trống = chủ farm">
          </label>
          <label>Ngày trong tuần
            <input name="weekdays" required value="${esc(s?.weekdays_spec || '1-5')}" placeholder="1-5 hoặc mon-fri hoặc *">
          </label>
          <label>Khung giờ (đến giờ kết thúc thì hết ca)
            <span class="hours">
              <input name="start" required value="${esc(s ? clock(s.start_min) : '08:00')}" placeholder="08:00" inputmode="numeric">
              <input name="end" required value="${esc(s ? clock(s.end_min) : '17:00')}" placeholder="17:00" inputmode="numeric">
            </span>
          </label>
        </div>
        <p class="hint">0 hoặc CN = Chủ nhật, 1 hoặc T2 = thứ Hai, 6 hoặc T7 = thứ Bảy. Ca qua đêm: 22:00–06:00. Múi giờ cố định Asia/Ho_Chi_Minh.</p>
        <div class="row-actions">
          <label class="chk"><input type="checkbox" name="active" value="1" ${!s || s.active ? 'checked' : ''}> Đang dùng</label>
          <label class="chk"><input type="checkbox" name="online" value="1" ${s?.online ? 'checked' : ''}> Online</label>
          <button type="submit" name="action" value="save">${editing ? 'Lưu ca' : 'Thêm ca'}</button>
          ${editing ? '<button type="submit" name="action" value="delete" class="danger">Xoá</button>' : ''}
        </div>
      </form>
      ${editing ? `
      <form method="post" action="/admin/roster" class="row-actions">
        <input type="hidden" name="action" value="online">
        <input type="hidden" name="id" value="${esc(s.id)}">
        <input type="hidden" name="online" value="${s.online ? '0' : '1'}">
        <button type="submit" class="ghost">${s.online ? 'Đang online — tắt' : 'Đánh dấu online'}</button>
      </form>` : ''}
    </div>`;
}

function render({ shifts, handoffs, flash, error }) {
  const rows = (handoffs || []).map(h => `
    <article class="draft">
      <div class="meta">
        <span class="tag ${h.label === 'NEEDS_HUMAN' ? 'warn' : ''}">${esc(h.label || 'HANDOFF')}</span>
        <span class="tag muted">${esc(MODE_TEXT[h.mode] || h.mode || '')}</span>
        <span class="when">${esc(when(h.created_at))}</span>
      </div>
      <h2>${esc(h.assignee_name || 'Chưa rõ')}</h2>
      <p class="sub">${esc(h.window_label || '')}${h.next_label ? ` · ca kế bắt đầu ${esc(h.next_label)}` : ''}</p>
      <p>${esc(h.reason || '')}</p>
      <p class="hint">${esc(h.external_id || 'không có id khách')}${h.last_message ? ` · “${esc(h.last_message).slice(0, 180)}”` : ''}</p>
    </article>`).join('');

  const cards = (shifts || []).map(shiftForm).join('') || '<p class="empty">Chưa có ca nào. Thêm ca bên dưới — ngoài giờ, hội thoại giao về chủ farm.</p>';

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#3f6b4c">
<title>Ca trực — Omni Sale DMF</title>
<link rel="stylesheet" href="/admin/review.css">
</head>
<body>
<header class="top">
  <div>
    <p class="brand">Omni Sale DMF</p>
    <h1>Ca trực &amp; bàn giao</h1>
    <p class="sub">Giờ Việt Nam (Asia/Ho_Chi_Minh). Khi cần người thật, hội thoại giao cho người đang trong ca — ưu tiên người online. Ngoài giờ thì ca kế tiếp, hoặc chủ farm nếu chưa cấu hình ca.</p>
  </div>
  <a class="ghost" href="/admin">Duyệt tin</a>
</header>
${flash ? `<p class="banner ok">${esc(flash)}</p>` : ''}
${error ? `<p class="banner bad">${esc(error)}</p>` : ''}
<p class="note">Thông báo nội bộ đi qua Zalo Bot (cùng đường với cảnh báo chủ farm, <code>ALERT_BOT_CHAT_ID</code>). Điền chat id của nhân viên vào ô báo cáo để người đó nhận thẻ bàn giao. Repo này không gửi Telegram.</p>
<h2 class="section">Ai nhận ca</h2>
<div class="stack">${rows || '<p class="empty">Chưa bàn giao cuộc nào.</p>'}</div>
<h2 class="section">Ca trực</h2>
<div class="stack">${cards}</div>
<h2 class="section">Thêm ca</h2>
<div class="stack">${shiftForm(null)}</div>
</body>
</html>`;
}

module.exports = { render };
