(function () {
  const listEl = document.getElementById('list');
  const noteEl = document.getElementById('note');
  const form = document.getElementById('filters');
  const qEl = document.getElementById('q');
  const fromEl = document.getElementById('from');
  const toEl = document.getElementById('to');
  const csv = document.getElementById('csv');
  const labels = { chua_tt: 'Chưa thanh toán', da_tt: 'Đã thanh toán', mot_phan: 'Một phần' };
  const channels = { zalo: 'Zalo', fb: 'Facebook' };

  function vnd(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '0đ';
    return Math.round(x).toLocaleString('vi-VN') + 'đ';
  }

  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(d);
  }

  function params() {
    const q = new URLSearchParams();
    if (qEl.value.trim()) q.set('q', qEl.value.trim());
    if (fromEl.value) q.set('from', fromEl.value);
    if (toEl.value) q.set('to', toEl.value);
    return q;
  }

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Không tải được');
    return data;
  }

  function note(text) { noteEl.textContent = text || ''; }

  function card(row) {
    const el = document.createElement('article');
    el.className = 'card';
    const open = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = row.code;
    const meta = document.createElement('p');
    meta.className = 'meta';
    const who = [row.customer_name || 'Khách', row.customer_phone || '', channels[row.channel] || ''].filter(Boolean).join(' · ');
    meta.textContent = who + ' · ' + vnd(row.total) + ' · Gửi ' + when(row.sent_at);
    const badge = document.createElement('span');
    badge.className = 'badge ' + (row.payment_status || 'chua_tt');
    badge.textContent = labels[row.payment_status] || row.payment_status;
    open.appendChild(title);
    open.appendChild(meta);
    open.appendChild(badge);
    el.appendChild(open);

    const extra = document.createElement('div');
    extra.hidden = true;
    if (row.document_type === 'invoice') {
      const img = document.createElement('img');
      img.className = 'shot';
      img.alt = 'Hoá đơn ' + row.code;
      img.src = '/admin/api/invoices/' + encodeURIComponent(row.code) + '/anh';
      extra.appendChild(img);
    }
    const pay = document.createElement('div');
    pay.className = 'pay';
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = '1000';
    amount.inputMode = 'numeric';
    amount.value = String(row.amount_paid || 0);
    amount.setAttribute('aria-label', 'Số tiền đã thu ' + row.code);
    const paidBtn = document.createElement('button');
    paidBtn.type = 'button';
    paidBtn.className = 'btn primary';
    paidBtn.textContent = 'Đánh dấu đã thanh toán';
    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn';
    syncBtn.textContent = 'Đồng bộ KiotViet';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(paidBtn);
    actions.appendChild(syncBtn);
    pay.appendChild(amount);
    extra.appendChild(pay);
    extra.appendChild(actions);
    el.appendChild(extra);

    open.addEventListener('click', () => { extra.hidden = !extra.hidden; });
    paidBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      paidBtn.disabled = true;
      try {
        await api('/admin/api/invoices/' + encodeURIComponent(row.code) + '/paid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Number(amount.value) }),
        });
        note('Đã cập nhật ' + row.code);
        await load();
      } catch (err) {
        note(err.message);
      } finally {
        paidBtn.disabled = false;
      }
    });
    syncBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      syncBtn.disabled = true;
      try {
        await api('/admin/api/invoices/' + encodeURIComponent(row.code) + '/sync', { method: 'POST' });
        note('Đã đồng bộ ' + row.code);
        await load();
      } catch (err) {
        note(err.message);
      } finally {
        syncBtn.disabled = false;
      }
    });
    return el;
  }

  async function load() {
    const q = params();
    csv.href = '/admin/api/invoices.csv' + (q.toString() ? '?' + q.toString() : '');
    note('Đang tải…');
    try {
      const data = await api('/admin/api/invoices' + (q.toString() ? '?' + q.toString() : ''));
      listEl.textContent = '';
      const rows = data.invoices || [];
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Chưa có hoá đơn khớp bộ lọc.';
        listEl.appendChild(empty);
      } else {
        rows.forEach(row => listEl.appendChild(card(row)));
      }
      note(rows.length + ' chứng từ');
    } catch (err) {
      note(err.message);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  load();
})();
