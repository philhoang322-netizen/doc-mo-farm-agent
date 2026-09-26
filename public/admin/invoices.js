(function () {
  const listEl = document.getElementById('list');
  const noteEl = document.getElementById('note');
  const form = document.getElementById('filters');
  const qEl = document.getElementById('q');
  const fromEl = document.getElementById('from');
  const toEl = document.getElementById('to');
  const csv = document.getElementById('csv');
  const channels = { zalo: 'Zalo', fb: 'Facebook' };
  const pending = new Map();
  let paymentFilter = '';
  let rows = [];

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
    if (paymentFilter) q.set('payment', paymentFilter);
    return q;
  }

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Không tải được');
    return data;
  }

  function note(text) { noteEl.textContent = text || ''; }

  function viewOf(row) {
    const held = pending.get(row.code);
    if (held) return { status: held.status, method: held.method };
    return {
      status: row.payment_status === 'da_tt' ? 'da_tt' : 'chua_tt',
      method: row.payment_method === 'cash' ? 'cash' : 'transfer',
    };
  }

  function clearToast(code) {
    const node = document.querySelector('#undo-toasts [data-pay="' + code + '"]');
    if (node) node.remove();
  }

  function pushToast(code, status) {
    const host = document.getElementById('undo-toasts');
    const node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    node.dataset.pay = code;
    node.appendChild(document.createTextNode(status === 'da_tt' ? 'Đã chuyển sang Đã TT. ' : 'Đã chuyển sang Chưa TT. '));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'linkish';
    b.textContent = 'Hoàn tác';
    b.addEventListener('click', () => undo(code));
    node.appendChild(b);
    if (host) host.appendChild(node);
  }

  function undo(code) {
    const held = pending.get(code);
    if (!held || !held.timer) return;
    held.timer.undo();
    pending.delete(code);
    clearToast(code);
    paint();
  }

  async function finalize(code) {
    const held = pending.get(code);
    if (!held) return;
    pending.delete(code);
    clearToast(code);
    try {
      await api('/admin/api/invoices/' + encodeURIComponent(code) + '/paid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: held.status, method: held.method }),
      });
      await load();
    } catch (err) {
      note(err.message);
      paint();
    }
  }

  function schedule(row, status, method) {
    const policy = window.payToggle;
    if (!policy || !row) return;
    const now = viewOf(row);
    const methodName = method === 'cash' ? 'cash' : 'transfer';
    if (now.status === status && now.method === methodName && !pending.get(row.code)) return;
    const held = pending.get(row.code);
    const previous = held ? held.previous : { status: now.status, method: now.method };
    if (held && held.timer) held.timer.undo();
    clearToast(row.code);
    const timer = policy.schedule(row.code, { onFinalize: () => finalize(row.code) });
    pending.set(row.code, { status, method: methodName, previous, timer });
    if (status !== previous.status) pushToast(row.code, status);
    paint();
  }

  function payControls(row) {
    const state = viewOf(row);
    const wrap = document.createElement('div');
    wrap.className = 'pay-controls';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pay-chip' + (state.status === 'da_tt' ? ' is-paid' : '');
    chip.textContent = state.status === 'da_tt' ? 'Đã TT' : 'Chưa TT';
    chip.setAttribute('aria-pressed', state.status === 'da_tt' ? 'true' : 'false');
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = viewOf(row);
      schedule(row, current.status === 'da_tt' ? 'chua_tt' : 'da_tt', current.method);
    });
    wrap.appendChild(chip);
    [['transfer', 'Chuyển khoản'], ['cash', 'Tiền mặt']].forEach(([method, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pay-method' + (state.method === method ? ' is-on' : '');
      b.textContent = label;
      b.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        schedule(row, viewOf(row).status, method);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function card(row) {
    const el = document.createElement('article');
    el.className = 'card';
    const open = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'id-head';
    const rowEl = document.createElement('div');
    rowEl.className = 'id-row';
    const name = document.createElement('span');
    name.className = 'id-name';
    name.textContent = row.customer_name || 'Khách';
    rowEl.appendChild(name);
    if (row.customer_code) {
      const kh = document.createElement('span');
      kh.className = 'id-code';
      kh.title = 'Mã KH';
      kh.textContent = row.customer_code;
      rowEl.appendChild(kh);
    }
    const hd = document.createElement('span');
    hd.className = 'id-code';
    hd.title = 'Mã HĐ';
    hd.textContent = row.code;
    rowEl.appendChild(hd);
    head.appendChild(rowEl);
    head.appendChild(payControls(row));
    const meta = document.createElement('p');
    meta.className = 'meta';
    const line = document.createElement('span');
    line.className = 'meta-line';
    const bits = [
      row.customer_phone || '',
      channels[row.channel] || '',
      vnd(row.total),
      when(row.sent_at || row.created_at),
    ].filter(Boolean);
    line.textContent = bits.join(' · ');
    meta.appendChild(line);
    open.appendChild(head);
    open.appendChild(meta);
    if (row.delivery_address) {
      const place = document.createElement('p');
      place.className = 'addr-line';
      place.textContent = row.delivery_address;
      open.appendChild(place);
    }
    const items = Array.isArray(row.items) ? row.items : [];
    if (items.length) {
      const lines = document.createElement('ul');
      lines.className = 'lines';
      items.forEach(item => {
        const li = document.createElement('li');
        const amount = item.amount != null ? item.amount : Number(item.price) * Number(item.quantity);
        li.textContent = (item.name || item.product_name || 'Sản phẩm') + ' × ' + (item.quantity ?? '') + ' · ' + vnd(amount);
        lines.appendChild(li);
      });
      open.appendChild(lines);
    }
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
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'btn';
    syncBtn.textContent = 'Đồng bộ KiotViet';
    actions.appendChild(syncBtn);
    extra.appendChild(actions);
    el.appendChild(extra);

    open.addEventListener('click', () => { extra.hidden = !extra.hidden; });
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

  function paint() {
    listEl.textContent = '';
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Chưa có hoá đơn khớp bộ lọc.';
      listEl.appendChild(empty);
      return;
    }
    rows.forEach(row => listEl.appendChild(card(row)));
  }

  async function load() {
    const q = params();
    csv.href = '/admin/api/invoices.csv' + (q.toString() ? '?' + q.toString() : '');
    note('Đang tải…');
    try {
      const data = await api('/admin/api/invoices' + (q.toString() ? '?' + q.toString() : ''));
      rows = data.invoices || [];
      paint();
      note(rows.length + ' chứng từ');
    } catch (err) {
      note(err.message);
    }
  }

  document.querySelectorAll('.pay-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      paymentFilter = btn.dataset.pay || '';
      document.querySelectorAll('.pay-filter').forEach(other => {
        other.classList.toggle('is-on', other === btn);
      });
      load();
    });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  load();
})();
