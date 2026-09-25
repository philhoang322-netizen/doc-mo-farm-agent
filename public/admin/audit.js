(function () {
  const LABELS = {
    'message.received': 'Khách nhắn',
    'draft.created': 'Tạo bản nháp',
    'draft.edited': 'Quản lý sửa',
    'draft.approved': 'Quản lý duyệt',
    'draft.sent': 'Đã gửi cho khách',
    'draft.send_failed': 'Duyệt nhưng chưa gửi được',
    'draft.rejected': 'Từ chối',
    'draft.reopened': 'Đưa về chờ duyệt',
    'order.created': 'AI tạo đơn',
    'order.pushed': 'Đẩy KiotViet',
    'order.push_failed': 'Đẩy KiotViet lỗi',
    'order.push_blocked': 'Chưa đẩy vì kho',
    'order.confirmed': 'Nhân viên xác nhận đơn',
    'order.status_changed': 'Đổi trạng thái đơn',
  };

  const listEl = document.getElementById('list');
  const storageEl = document.getElementById('storage');
  const form = document.getElementById('filters');
  const params = new URLSearchParams(location.search);

  ['conversation', 'order', 'from', 'to'].forEach(name => {
    const input = form.elements[name];
    if (input && params.get(name)) input.value = params.get(name);
  });

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.entries(attrs).forEach(([k, v]) => {
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(child => { if (child) node.appendChild(child); });
    return node;
  }

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('vi-VN', {
      hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
    });
  }

  function show(value) {
    if (value == null) return '';
    return JSON.stringify(value, null, 2);
  }

  async function load() {
    const q = new URLSearchParams();
    ['conversation', 'order', 'from', 'to'].forEach(name => {
      const value = String(form.elements[name].value || '').trim();
      if (value) q.set(name, value);
    });
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
    listEl.textContent = 'Đang tải…';
    const res = await fetch('/admin/api/audit?' + q.toString(), { credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/admin';
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      listEl.textContent = data.error || 'Không tải được nhật ký';
      return;
    }
    if (data.storage && data.storage !== 'postgres') {
      storageEl.hidden = false;
      storageEl.textContent = 'Nhật ký đang nằm trong bộ nhớ của server. Khởi động lại máy sẽ mất. Trên Railway hãy đặt DATABASE_URL.';
    } else {
      storageEl.hidden = true;
    }
    const logs = data.logs || [];
    listEl.replaceChildren();
    if (!logs.length) {
      listEl.appendChild(el('p', { class: 'note', text: 'Chưa có dòng nào khớp bộ lọc.' }));
      return;
    }
    logs.forEach(row => {
      const title = LABELS[row.action] || row.action;
      const card = el('article', { class: 'audit-row' });
      card.appendChild(el('h2', { text: title }));
      card.appendChild(el('p', {
        class: 'who',
        text: `${when(row.at)} · ${row.actor} · ${row.entity_type} ${row.entity_id}`,
      }));
      const sent = window.cardTime && row.after && window.cardTime.sentLabel(row.after);
      if (sent) {
        card.appendChild(el('p', { class: 'who', text: sent.text + ' · ' + sent.who }));
      }
      if (row.before || row.after) {
        const pair = el('div', { class: 'pair' });
        if (row.before) {
          const box = el('div');
          box.appendChild(el('div', { class: 'hint', text: 'Trước' }));
          box.appendChild(el('pre', { text: show(row.before) }));
          pair.appendChild(box);
        }
        if (row.after) {
          const box = el('div');
          box.appendChild(el('div', { class: 'hint', text: 'Sau' }));
          box.appendChild(el('pre', { text: show(row.after) }));
          pair.appendChild(box);
        }
        card.appendChild(pair);
      }
      listEl.appendChild(card);
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load().catch(() => { listEl.textContent = 'Không tải được nhật ký'; });
  });
  load().catch(() => { listEl.textContent = 'Không tải được nhật ký'; });
})();
