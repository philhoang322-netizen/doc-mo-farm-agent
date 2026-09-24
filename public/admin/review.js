(function () {
  const brand = window.OMNI_SALE;
  if (brand && typeof brand === 'object') {
    const nameEl = document.getElementById('product-name');
    const verEl = document.getElementById('app-version');
    if (nameEl && brand.product) nameEl.textContent = brand.product;
    if (verEl && brand.label) verEl.textContent = brand.label;
    if (brand.product) document.title = 'Duyệt tin nhắn — ' + brand.product;
  }

  const STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SENT'];
  const LABELS = {
    PENDING_REVIEW: 'Chờ duyệt',
    APPROVED: 'Đã duyệt',
    REJECTED: 'Từ chối',
    SENT: 'Đã gửi',
  };

  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  const storageEl = document.getElementById('storage');
  const toastEl = document.getElementById('toast');
  const actorInput = document.getElementById('actor-name');
  const tabs = [...document.querySelectorAll('[data-status]')];
  const ACTOR_KEY = 'dmf_actor_name';

  if (actorInput) {
    actorInput.value = localStorage.getItem(ACTOR_KEY) || '';
    actorInput.addEventListener('input', () => {
      localStorage.setItem(ACTOR_KEY, actorInput.value.trim());
    });
  }

  function actorName() {
    return actorInput ? actorInput.value.trim() : '';
  }

  const initial = new URLSearchParams(location.search).get('status');
  let status = STATUSES.includes(initial) ? initial : 'PENDING_REVIEW';
  let drafts = [];
  let counts = {};
  let selectedId = location.hash ? location.hash.slice(1) : null;
  let dirty = false;
  let busy = false;
  let loadedOnce = false;
  let listStamp = '';
  let detailStamp = '';

  function needsHumanTicket(d) {
    return String(d.ticket_status || '').indexOf('NEEDS_HUMAN') !== -1;
  }

  function rememberUrl() {
    const hash = selectedId ? '#' + selectedId : '';
    history.replaceState(null, '', location.pathname + '?status=' + status + hash);
  }

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.status === status) return;
      if (dirty && !confirm('Bạn đang sửa dở. Đổi mục sẽ bỏ phần chưa lưu?')) return;
      dirty = false;
      status = btn.dataset.status;
      selectedId = null;
      detailStamp = '';
      document.body.classList.remove('show-detail');
      rememberUrl();
      syncTabs();
      load();
    });
  });

  function syncTabs() {
    tabs.forEach(btn => {
      const on = btn.dataset.status === status;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      const n = counts[btn.dataset.status];
      const b = btn.querySelector('.count');
      b.textContent = n ? String(n) : '';
    });
  }

  function toast(text) {
    toastEl.hidden = false;
    toastEl.textContent = text;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  function when(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (Number.isNaN(diff)) return '';
    if (diff < 60) return 'vừa xong';
    if (diff < 3600) return Math.floor(diff / 60) + ' phút trước';
    if (diff < 86400) return Math.floor(diff / 3600) + ' giờ trước';
    return new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  }

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
    (children || []).forEach(child => {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function field(name, label, value, opts) {
    opts = opts || {};
    const input = opts.multiline
      ? el('textarea', { name, rows: opts.rows || '5' })
      : el(opts.options ? 'select' : 'input', { name });
    if (opts.options) {
      opts.options.forEach(opt => {
        const o = el('option', { value: opt.value, text: opt.label });
        if ((value || '') === opt.value) o.selected = true;
        input.appendChild(o);
      });
    } else {
      input.value = value || '';
    }
    if (opts.disabled) input.disabled = true;
    const mark = () => { dirty = true; };
    input.addEventListener('input', mark);
    input.addEventListener('change', mark);
    const wrap = el('label', { class: opts.wide ? 'span-2' : '' }, [
      document.createTextNode(label),
      input,
    ]);
    return wrap;
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts || {}));
    if (res.status === 401) {
      location.reload();
      throw new Error('unauthorized');
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || 'Không thực hiện được');
    return data;
  }

  async function load() {
    if (!loadedOnce) listEl.textContent = 'Đang tải…';
    try {
      const data = await api('/admin/api/drafts?status=' + encodeURIComponent(status));
      drafts = data.drafts || [];
      counts = data.counts || {};
      loadedOnce = true;
      syncTabs();
      if (data.storage && data.storage !== 'postgres') {
        storageEl.hidden = false;
        storageEl.textContent = 'Bản nháp đang nằm trong bộ nhớ của server. Khởi động lại máy sẽ mất hàng đợi. Trên Railway hãy đặt DATABASE_URL để lưu vào Postgres.';
      } else {
        storageEl.hidden = true;
      }
      const stamp = JSON.stringify(drafts);
      if (stamp !== listStamp) {
        listStamp = stamp;
        renderList();
      }
      const open = selectedId && drafts.find(d => d.id === selectedId);
      if (open) {
        const nextStamp = JSON.stringify(open);
        if (!dirty && nextStamp !== detailStamp) {
          detailStamp = nextStamp;
          renderDetail();
        }
      } else if (selectedId) {
        selectedId = null;
        detailStamp = '';
        document.body.classList.remove('show-detail');
        showPlaceholder();
      }
    } catch (e) {
      if (e.message === 'unauthorized') return;
      listEl.textContent = '';
      listEl.appendChild(el('p', { class: 'empty', text: e.message }));
    }
  }

  function showPlaceholder() {
    detailEl.replaceChildren(el('div', { class: 'draft' }, [
      el('p', { class: 'empty', text: 'Chọn một tin để đọc và sửa.' }),
    ]));
  }

  function renderList() {
    listEl.textContent = '';
    if (!drafts.length) {
      listEl.appendChild(el('p', {
        class: 'empty',
        text: 'Chưa có tin nào ở mục này. Khi có bản nháp mới, tin sẽ hiện ở đây để bạn sửa rồi mới gửi.',
      }));
      if (!selectedId) showPlaceholder();
      return;
    }
    drafts.forEach(d => {
      const btn = el('button', { type: 'button', class: 'item' + (d.id === selectedId ? ' selected' : '') });
      btn.appendChild(el('div', { class: 'name', text: d.customer_name || 'Khách chưa có tên' }));
      btn.appendChild(el('div', { class: 'intent', text: d.customer_intent || d.draft_reply || '' }));
      const meta = el('div', { class: 'meta' });
      meta.appendChild(el('span', {
        class: 'tag' + (d.channel === 'messenger' ? ' messenger' : ''),
        text: d.channel === 'messenger' ? 'FB / Messenger' : 'Zalo',
      }));
      if (d.assigned_department) meta.appendChild(el('span', { class: 'tag muted', text: d.assigned_department }));
      if (needsHumanTicket(d)) {
        meta.appendChild(el('span', { class: 'tag warn', text: 'Cần human hỗ trợ khẩn cấp' }));
      }
      meta.appendChild(el('span', { class: 'when', text: when(d.created_at) }));
      btn.appendChild(meta);
      btn.addEventListener('click', () => {
        if (dirty && selectedId !== d.id && !confirm('Bạn đang sửa dở. Chuyển tin khác sẽ bỏ phần chưa lưu?')) return;
        dirty = false;
        selectedId = d.id;
        detailStamp = JSON.stringify(d);
        rememberUrl();
        document.body.classList.add('show-detail');
        renderList();
        renderDetail();
      });
      listEl.appendChild(btn);
    });
    if (!selectedId) showPlaceholder();
  }

  function currentDraft() {
    return drafts.find(d => d.id === selectedId) || null;
  }

  function readForm() {
    const form = detailEl.querySelector('form');
    const data = { id: selectedId };
    if (!form) return data;
    new FormData(form).forEach((value, key) => { data[key] = value; });
    return data;
  }

  function renderDetail() {
    const d = currentDraft();
    detailEl.textContent = '';
    if (!d) return;
    const locked = d.approval_status === 'SENT';
    const back = el('button', { type: 'button', class: 'ghost back', text: '← Danh sách' });
    back.addEventListener('click', () => {
      document.body.classList.remove('show-detail');
    });

    const form = el('form', { class: 'draft' });
    form.addEventListener('submit', e => e.preventDefault());
    form.appendChild(back);
    form.appendChild(el('h2', { text: d.customer_name || 'Khách chưa có tên' }));
    form.appendChild(el('p', { class: 'sub', text: LABELS[d.approval_status] + ' · ' + when(d.created_at) }));
    if (d.pii_note) {
      form.appendChild(el('p', { class: 'hint', text: d.pii_note }));
    }

    if (needsHumanTicket(d)) {
      form.appendChild(el('p', {
        class: 'banner warn',
        text: 'Cần human hỗ trợ khẩn cấp — bản nháp này chỉ là câu chờ, không phải câu bán hàng. Sửa trước khi gửi.',
      }));
    }

    if (d.send_error) {
      form.appendChild(el('p', {
        class: 'banner ' + (d.approval_status === 'SENT' ? 'warn' : 'bad'),
        text: d.send_error,
      }));
    }

    const grid = el('div', { class: 'grid' });
    grid.appendChild(field('customer_name', 'Tên khách', d.customer_name, { disabled: locked }));
    grid.appendChild(field('customer_phone', 'Số điện thoại', d.customer_phone, { disabled: locked }));
    grid.appendChild(field('customer_user_id', 'User id', d.customer_user_id, { disabled: locked, wide: true }));
    grid.appendChild(field('channel', 'Kênh', d.channel, {
      disabled: locked,
      options: [
        { value: 'zalo', label: 'Zalo' },
        { value: 'messenger', label: 'FB / Messenger' },
      ],
    }));
    grid.appendChild(field('customer_intent', 'Khách đang muốn', d.customer_intent, { disabled: locked }));
    form.appendChild(grid);
    form.appendChild(el('p', {
      class: 'hint',
      text: 'Zalo OA: dán user id. Zalo Bot: bot_ rồi tới chat id. Messenger: fb_ rồi tới PSID. Bộ phận là tuyến lọc (Sales, FAQ, Người thật, Khác). Duyệt và gửi mới đẩy tin đi.',
    }));

    const extra = el('details');
    if (d.kiot_summary || d.invoice_code || d.customer_code || d.qr_image_url || d.assigned_department || d.ticket_status) {
      extra.open = true;
    }
    extra.appendChild(el('summary', { text: 'Đơn, Kiot và bộ phận' }));
    const extraGrid = el('div', { class: 'grid' });
    extraGrid.appendChild(field('assigned_department', 'Bộ phận', d.assigned_department, { disabled: locked }));
    extraGrid.appendChild(field('ticket_status', 'Trạng thái ticket', d.ticket_status, { disabled: locked }));
    extraGrid.appendChild(field('invoice_code', 'Mã hoá đơn', d.invoice_code, { disabled: locked }));
    extraGrid.appendChild(field('customer_code', 'Mã khách hàng (mã KH)', d.customer_code, { disabled: locked }));
    extraGrid.appendChild(field('kiot_summary', 'Tóm tắt Kiot', d.kiot_summary, { disabled: locked, wide: true, multiline: true, rows: '3' }));
    extraGrid.appendChild(field('qr_image_url', 'Link ảnh QR', d.qr_image_url, { disabled: locked, wide: true }));
    extra.appendChild(extraGrid);
    if (d.qr_image_url && /^https?:\/\//i.test(d.qr_image_url)) {
      const img = el('img', { class: 'qr', alt: 'Mã QR', src: d.qr_image_url });
      extra.appendChild(img);
    }
    form.appendChild(extra);

    form.appendChild(field('draft_reply', 'Bản nháp trả lời', d.draft_reply, {
      disabled: locked, wide: true, multiline: true, rows: '8',
    }));

    const actions = el('div', { class: 'actions' });
    if (!locked) {
      actions.appendChild(actionButton('Duyệt và gửi', 'send', () => send()));
      actions.appendChild(actionButton('Lưu', 'ghost', () => save()));
      if (d.approval_status !== 'REJECTED') {
        actions.appendChild(actionButton('Từ chối', 'danger', () => reject()));
      }
      if (d.approval_status !== 'PENDING_REVIEW') {
        actions.appendChild(actionButton('Đưa về chờ duyệt', 'ghost', () => reopen()));
      }
    }
    form.appendChild(actions);
    detailEl.appendChild(form);
    document.body.classList.add('show-detail');
  }

  function actionButton(label, kind, onClick) {
    const btn = el('button', { type: 'button', class: kind === 'send' ? 'send' : kind, text: label });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function payload(extra) {
    const data = readForm();
    return Object.assign({
      channel: data.channel,
      customer_name: data.customer_name,
      customer_phone: data.customer_phone,
      customer_user_id: data.customer_user_id,
      customer_intent: data.customer_intent,
      assigned_department: data.assigned_department,
      ticket_status: data.ticket_status,
      draft_reply: data.draft_reply,
      kiot_summary: data.kiot_summary,
      invoice_code: data.invoice_code,
      customer_code: data.customer_code,
      qr_image_url: data.qr_image_url,
      actor_name: actorName(),
    }, extra || {});
  }

  async function patch(body, okText) {
    if (busy || !selectedId) return;
    busy = true;
    detailEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const res = await api('/admin/api/drafts/' + selectedId, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      dirty = false;
      const send = res.send;
      if (send && send.sent) toast('Đã gửi cho khách.');
      else if (send && !send.sent) toast('Đã duyệt, chưa gửi được. Xem lý do phía trên.');
      else toast(okText);
      const nextStatus = res.draft && res.draft.approval_status;
      if (nextStatus && nextStatus !== status) {
        status = nextStatus;
        selectedId = res.draft.id;
        syncTabs();
      }
      detailStamp = '';
      listStamp = '';
      rememberUrl();
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
      detailEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
    } finally {
      busy = false;
    }
  }

  function save() { return patch(payload(), 'Đã lưu.'); }
  function reject() { return patch(payload({ approval_status: 'REJECTED' }), 'Đã từ chối.'); }
  function reopen() {
    return patch({ approval_status: 'PENDING_REVIEW', actor_name: actorName() }, 'Đã đưa về chờ duyệt.');
  }
  function send() {
    const data = readForm();
    const msg = data.channel === 'messenger'
      ? 'Gửi tin này cho khách trên Facebook Messenger?'
      : 'Gửi tin này cho khách?';
    if (!confirm(msg)) return;
    return patch(payload({ approval_status: 'APPROVED', send: true }), 'Đã duyệt.');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !dirty && !busy) load();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !dirty && !busy) load();
  }, 20000);

  syncTabs();
  load();
})();
