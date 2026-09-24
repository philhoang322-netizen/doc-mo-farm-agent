(function () {
  const brand = window.OMNI_SALE;
  if (brand && typeof brand === 'object') {
    const nameEl = document.getElementById('product-name');
    const verEl = document.getElementById('app-version');
    if (nameEl && brand.product) nameEl.textContent = brand.product;
    if (verEl && brand.label) verEl.textContent = brand.label;
    if (brand.product) document.title = 'Tin nhắn — ' + brand.product;
  }

  const OPS = ['success', 'failure', 'pending', 'sending', 'queued', 'rejected'];
  const OPS_LABEL = {
    success: 'Thành công',
    failure: 'Thất bại',
    pending: 'Chờ xử lý',
    sending: 'Đang gửi',
    queued: 'Chờ gửi',
    rejected: 'Từ chối',
  };
  const TYPE_LABEL = { follower: 'Follower', zns: 'ZNS', broadcast: 'Broadcast' };

  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  const storageEl = document.getElementById('storage');
  const toastEl = document.getElementById('toast');
  const actorInput = document.getElementById('actor-name');
  const ACTOR_KEY = 'dmf_actor_name';
  const dayEl = document.getElementById('stats-day');
  const tplEl = document.getElementById('stats-template');
  const channelEl = document.getElementById('channels');
  const tabs = [...document.querySelectorAll('[data-ops]')];
  const typeTabs = [...document.querySelectorAll('[data-type]')];

  if (actorInput) {
    actorInput.value = localStorage.getItem(ACTOR_KEY) || '';
    actorInput.addEventListener('input', () => {
      localStorage.setItem(ACTOR_KEY, actorInput.value.trim());
    });
  }

  function actorName() {
    return actorInput ? actorInput.value.trim() : '';
  }

  const params = new URLSearchParams(location.search);
  let ops = OPS.includes(params.get('ops')) ? params.get('ops') : 'pending';
  let messageType = Object.prototype.hasOwnProperty.call(TYPE_LABEL, params.get('type')) ? params.get('type') : '';
  let salesChannel = params.get('kenh') || 'farm';
  let channels = [];
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
    const q = new URLSearchParams();
    q.set('ops', ops);
    q.set('kenh', salesChannel);
    if (messageType) q.set('type', messageType);
    const hash = selectedId ? '#' + selectedId : '';
    history.replaceState(null, '', location.pathname + '?' + q.toString() + hash);
  }

  function guardSwitch(next) {
    if (dirty && !confirm('Bạn đang sửa dở. Đổi mục sẽ bỏ phần chưa lưu?')) return false;
    dirty = false;
    selectedId = null;
    detailStamp = '';
    document.body.classList.remove('show-detail');
    next();
    rememberUrl();
    syncTabs();
    load();
    return true;
  }

  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.ops === ops) return;
      guardSwitch(() => { ops = btn.dataset.ops; });
    });
  });

  typeTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.type || '';
      if (next === messageType) return;
      guardSwitch(() => { messageType = next; });
    });
  });

  document.getElementById('add-channel').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.name;
    const name = input.value.trim();
    if (!name) return;
    try {
      const res = await api('/admin/api/channels', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      input.value = '';
      salesChannel = res.channel.id;
      toast('Đã thêm kênh ' + res.channel.name + '.');
      rememberUrl();
      await loadChannels();
      await load();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message);
    }
  });

  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const res = await api('/admin/api/drafts', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'zalo',
          sales_channel: salesChannel,
          customer_name: data.customer_name,
          message_type: data.message_type,
          template_name: data.template_name,
          draft_reply: data.draft_reply,
        }),
      });
      if (!res.draft || res.draft.approval_status !== 'PENDING_REVIEW') {
        toast('Tin mới phải ở Chờ xử lý.');
        return;
      }
      e.target.reset();
      ops = 'pending';
      messageType = '';
      selectedId = res.draft.id;
      dirty = false;
      toast('Đã đưa vào chờ xử lý.');
      rememberUrl();
      syncTabs();
      listStamp = '';
      detailStamp = '';
      await load();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message);
    }
  });

  function syncTabs() {
    tabs.forEach(btn => {
      const on = btn.dataset.ops === ops;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      const n = counts[btn.dataset.ops];
      const b = btn.querySelector('.count');
      b.textContent = n ? String(n) : '';
    });
    typeTabs.forEach(btn => {
      btn.setAttribute('aria-selected', (btn.dataset.type || '') === messageType ? 'true' : 'false');
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

  function formatDay(iso) {
    const parts = String(iso || '').split('-');
    if (parts.length !== 3) return iso || '';
    return parts[2] + '/' + parts[1] + '/' + parts[0];
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

  function switchChannel(id) {
    if (id === salesChannel) return;
    guardSwitch(() => { salesChannel = id; renderChannels(); });
  }

  function renderChannels() {
    channelEl.textContent = '';
    channels.forEach(c => {
      const btn = el('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': c.id === salesChannel ? 'true' : 'false',
        text: c.name,
      });
      btn.addEventListener('click', () => switchChannel(c.id));
      channelEl.appendChild(btn);
    });
  }

  function renderStats(data) {
    dayEl.textContent = '';
    tplEl.textContent = '';
    const days = (data && data.byDay) || [];
    const tpls = (data && data.byTemplate) || [];
    if (!days.length) {
      dayEl.appendChild(el('p', { class: 'empty', text: 'Chưa có tin gửi thành công trong 14 ngày.' }));
    } else {
      dayEl.appendChild(statTable(days.map(row => ({
        label: formatDay(row.date),
        count: row.count,
      }))));
    }
    if (!tpls.length) {
      tplEl.appendChild(el('p', { class: 'empty', text: 'Chưa có tin gửi thành công theo mẫu.' }));
    } else {
      tplEl.appendChild(statTable(tpls.map(row => ({
        label: row.template_name || 'Chưa đặt mẫu',
        count: row.count,
      }))));
    }
  }

  function statTable(rows) {
    const max = Math.max(...rows.map(row => row.count), 1);
    const table = el('table');
    rows.forEach(row => {
      const track = el('div', { class: 'bar' });
      track.appendChild(el('span', { style: 'width:' + Math.round((row.count / max) * 100) + '%' }));
      table.appendChild(el('tr', null, [
        el('td', { text: row.label }),
        el('td', { class: 'num', text: String(row.count) }),
        el('td', null, [track]),
      ]));
    });
    return table;
  }

  async function loadChannels() {
    const data = await api('/admin/api/channels');
    channels = data.channels || [];
    if (!channels.some(c => c.id === salesChannel)) salesChannel = 'farm';
    renderChannels();
  }

  async function load() {
    if (!loadedOnce) listEl.textContent = 'Đang tải…';
    const q = new URLSearchParams();
    q.set('ops', ops);
    q.set('kenh', salesChannel);
    if (messageType) q.set('type', messageType);
    try {
      const [data, stats] = await Promise.all([
        api('/admin/api/drafts?' + q.toString()),
        api('/admin/api/stats?kenh=' + encodeURIComponent(salesChannel)),
      ]);
      drafts = data.drafts || [];
      counts = data.counts || {};
      loadedOnce = true;
      syncTabs();
      renderStats(stats);
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
        text: 'Chưa có tin nào ở mục này. Tin mới vào Chờ xử lý, chỉ gửi sau khi duyệt.',
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
        class: 'tag ' + (d.ops_status || 'pending'),
        text: OPS_LABEL[d.ops_status] || OPS_LABEL.pending,
      }));
      meta.appendChild(el('span', {
        class: 'tag' + (d.channel === 'messenger' ? ' messenger' : ''),
        text: d.channel === 'messenger' ? 'FB / Messenger' : 'Zalo',
      }));
      if (d.message_type && TYPE_LABEL[d.message_type]) {
        meta.appendChild(el('span', { class: 'tag muted', text: TYPE_LABEL[d.message_type] }));
      }
      if (d.template_name) meta.appendChild(el('span', { class: 'tag muted', text: d.template_name }));
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

  function channelOptions() {
    return channels.map(c => ({ value: c.id, label: c.name }));
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
    form.appendChild(el('p', {
      class: 'sub',
      text: (OPS_LABEL[d.ops_status] || OPS_LABEL.pending) + ' · ' + when(d.created_at),
    }));
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
    grid.appendChild(field('sales_channel', 'Kênh bán', d.sales_channel || 'farm', {
      disabled: locked,
      options: channelOptions(),
    }));
    grid.appendChild(field('message_type', 'Loại tin', d.message_type || '', {
      disabled: locked,
      options: [
        { value: '', label: 'Chưa chọn' },
        { value: 'follower', label: 'Follower' },
        { value: 'zns', label: 'ZNS' },
        { value: 'broadcast', label: 'Broadcast' },
      ],
    }));
    grid.appendChild(field('template_name', 'Mẫu', d.template_name, { disabled: locked, wide: true }));
    grid.appendChild(field('customer_user_id', 'User id', d.customer_user_id, { disabled: locked, wide: true }));
    grid.appendChild(field('channel', 'Đường gửi', d.channel, {
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
      text: '@Farm gửi qua Zalo sau khi duyệt. Zalo Bot dùng bot_ rồi tới chat id. Messenger dùng fb_ rồi tới PSID và chỉ gửi khi bật MESSENGER_ENABLED rồi bấm Duyệt và gửi. Shopee, FB và kênh tự thêm chưa có đường gửi — duyệt xong tin nằm ở Chờ gửi.',
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
      extra.appendChild(el('img', { class: 'qr', alt: 'Mã QR', src: d.qr_image_url }));
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
        actions.appendChild(actionButton('Đưa về chờ xử lý', 'ghost', () => reopen()));
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
      sales_channel: data.sales_channel,
      message_type: data.message_type,
      template_name: data.template_name,
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
      else if (send && send.pendingAdapter) toast('Đã duyệt. Kênh chưa có đường gửi, tin nằm ở Chờ gửi.');
      else if (send && !send.sent) toast('Đã duyệt, chưa gửi được. Xem lý do phía trên.');
      else toast(okText);
      const next = res.draft;
      if (next) {
        if (next.sales_channel && next.sales_channel !== salesChannel) salesChannel = next.sales_channel;
        if (messageType && next.message_type !== messageType) messageType = '';
        if (next.ops_status && next.ops_status !== ops) ops = next.ops_status;
        selectedId = next.id;
        renderChannels();
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
    let msg = 'Gửi tin này cho khách?';
    if (data.sales_channel && data.sales_channel !== 'farm') {
      const ch = channels.find(c => c.id === data.sales_channel);
      msg = 'Kênh ' + (ch ? ch.name : data.sales_channel) + ' chưa có đường gửi. Tin sẽ được duyệt và nằm ở Chờ gửi. Tiếp tục?';
    } else if (data.channel === 'messenger') {
      msg = 'Gửi tin này cho khách trên Facebook Messenger?';
    }
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
  loadChannels().then(load).catch(e => {
    if (e.message !== 'unauthorized') {
      listEl.textContent = '';
      listEl.appendChild(el('p', { class: 'empty', text: e.message }));
    }
  });
})();
