(function () {
  const brand = window.OMNI_SALE;
  if (brand && typeof brand === 'object') {
    const nameEl = document.getElementById('product-name');
    const verEl = document.getElementById('app-version');
    if (nameEl && brand.product) nameEl.textContent = brand.product;
    if (verEl && brand.label) verEl.textContent = brand.label;
    if (brand.product) document.title = 'Hàng chờ duyệt — ' + brand.product;
  }

  const OPS = ['success', 'failure', 'pending', 'sending', 'queued', 'rejected'];
  const OPS_LABEL = {
    success: 'Đã gửi',
    failure: 'Thất bại',
    pending: 'Chờ xử lý',
    sending: 'Đang gửi',
    queued: 'Chờ gửi',
    rejected: 'Từ chối',
  };
  const TYPE_LABEL = { follower: 'Follower', zns: 'ZNS', broadcast: 'Broadcast' };
  const TRIAGE_LABEL = { hot: 'Nóng', urgent: 'Khẩn', normal: 'Thường' };
  const GROUP_LABEL = { zalo: 'Zalo OA', 'fb-sale': 'FB-Sale', 'fb-dv': 'FB-DV' };
  const GROUP_COUNT = { zalo: 'zalo', 'fb-sale': 'fbSale', 'fb-dv': 'fbDv' };
  const TRIAGE_CLASS = { hot: 'tag-nong', urgent: 'tag-khan', normal: 'tag-thuong' };
  const SLOTS = [
    { value: 'all', label: 'Cả ngày' },
    { value: 'sang', label: 'Sáng (7h–12h)' },
    { value: 'chieu', label: 'Chiều (13h–18h)' },
    { value: 'toi', label: 'Tối (18h–21h)' },
  ];
  const VTP_PROVINCES = [
    { id: '1', name: 'Hà Nội' },
    { id: '2', name: 'TP. Hồ Chí Minh' },
    { id: '8', name: 'Đà Nẵng' },
  ];
  const VTP_DISTRICTS = {
    '2': [
      { id: '76', name: 'Quận Bình Thạnh' },
      { id: '73', name: 'Quận 1' },
      { id: '74', name: 'Quận 3' },
    ],
  };
  const VTP_WARDS = {
    '76': [
      { id: '9121', name: 'Phường 26' },
      { id: '9118', name: 'Phường 17' },
      { id: '9115', name: 'Phường 12' },
    ],
  };

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
  const triageTabs = [...document.querySelectorAll('[data-triage]')];
  const groupTabs = [...document.querySelectorAll('[data-nhom]')];
  const zlineTabs = [...document.querySelectorAll('[data-zline]')];
  const updatedEl = document.getElementById('updated-at');
  const newEl = document.getElementById('new-indicator');
  const syncResultEl = document.getElementById('sync-result');

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
  let triage = Object.prototype.hasOwnProperty.call(TRIAGE_LABEL, params.get('triage')) ? params.get('triage') : '';
  const FOLDER_LABEL = {
    pending: 'Chờ xử lý',
    sent: 'Đã gửi',
    bought: 'Đã mua',
    hesitant: 'Do dự',
    declined: 'Từ chối',
    deleted: 'Đã xóa',
  };
  const folderTabs = [...document.querySelectorAll('[data-folder]')];
  const nhomParam = params.get('nhom');
  const nhomInUrl = nhomParam != null && Object.prototype.hasOwnProperty.call(GROUP_LABEL, nhomParam);
  let nhom = nhomInUrl ? nhomParam : '';
  let chooseNhom = !nhomInUrl;
  let zline = params.get('zline') === 'sale' || params.get('zline') === 'dv' ? params.get('zline') : '';
  let folder = Object.prototype.hasOwnProperty.call(FOLDER_LABEL, params.get('hop')) ? params.get('hop') : 'pending';
  let folderCounts = { pending: 0, sent: 0, bought: 0, hesitant: 0, declined: 0, deleted: 0 };
  const cardState = new Map();
  let salesChannel = params.get('kenh') || 'farm';
  let channels = [];
  let drafts = [];
  let counts = {};
  let triageCounts = { hot: 0, urgent: 0, normal: 0 };
  let groupCounts = { zalo: 0, fbSale: 0, fbDv: 0 };
  let selectedId = location.hash ? location.hash.slice(1) : null;
  let dirty = false;
  let busy = false;
  let loadedOnce = false;
  let listStamp = '';
  let detailStamp = '';
  let loadSeq = 0;
  let queuedDrafts = null;
  let me = { role: 'manager', canSend: true, canDelete: true, canKiot: true, canManageUsers: true };

  function needsHumanTicket(d) {
    return String(d.ticket_status || '').indexOf('NEEDS_HUMAN') !== -1;
  }

  function formOf(d) {
    return (d && d.review_form) || {};
  }

  function isRefund(d) {
    if (!d) return false;
    if (formOf(d).refund_decision) return true;
    const blob = [d.customer_intent, d.customer_query, d.draft_reply, d.assigned_department, d.ticket_status].join('\n');
    return /hoàn tiền|hoan tien|đổi trả|doi tra|đổi hàng|doi hang|trả hàng|tra hang|refund/i.test(blob);
  }

  function showAddress(d) {
    const f = formOf(d);
    if (f.province_id || f.district_id || f.ward_id || f.address_detail || f.delivery_slot) return true;
    if (d.triage_level === 'hot') return true;
    if (/sales/i.test(d.assigned_department || '')) return true;
    return isRefund(d);
  }

  function snippet(d) {
    const raw = d.customer_query || d.customer_intent || d.draft_reply || '';
    return String(raw).replace(/^\[[^\]]+\]\s*/, '').trim();
  }

  function channelTag(d) {
    const text = d.channel === 'messenger' ? 'FB / Messenger' : 'Zalo';
    return { text, cls: text === 'FB / Messenger' ? 'tag-fb' : 'tag-zalo' };
  }

  function kindTag(d) {
    if (isRefund(d)) return { text: 'Cần người duyệt hoàn tiền', cls: 'tag-refund' };
    if (d.triage_level === 'hot' || /sales/i.test(d.assigned_department || '')) {
      return { text: 'Sales', cls: 'tag-sales' };
    }
    if (d.triage_level === 'normal' || String(d.assigned_department || '').toUpperCase() === 'FAQ') {
      return { text: 'FAQ', cls: 'tag-faq' };
    }
    if (d.assigned_department) return { text: d.assigned_department, cls: 'tag-faq' };
    return null;
  }

  function rememberUrl() {
    const q = new URLSearchParams();
    q.set('ops', ops);
    q.set('kenh', salesChannel);
    if (messageType) q.set('type', messageType);
    if (triage) q.set('triage', triage);
    if (nhom) q.set('nhom', nhom);
    if (nhom === 'zalo' && zline) q.set('zline', zline);
    if (folder) q.set('hop', folder);
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

  triageTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.triage || '';
      if (next === triage) return;
      guardSwitch(() => { triage = next; });
    });
  });

  groupTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.nhom || 'zalo';
      if (next === nhom) return;
      guardSwitch(() => { nhom = next; });
    });
  });

  zlineTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.zline || '';
      if (next === zline) return;
      guardSwitch(() => { zline = next; });
    });
  });

  folderTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.folder || 'pending';
      if (next === folder) return;
      guardSwitch(() => { folder = next; });
    });
  });

  document.getElementById('more-filters').addEventListener('click', () => {
    document.getElementById('extra-filters').classList.toggle('hidden');
  });

  document.getElementById('channel-settings-toggle').addEventListener('click', () => {
    document.getElementById('channel-panel').classList.toggle('hidden');
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
          customer_query: data.customer_query,
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
      triage = '';
      nhom = res.draft.channel === 'messenger'
        ? (res.draft.biz_line === 'dv' ? 'fb-dv' : 'fb-sale')
        : 'zalo';
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
      btn.classList.toggle('active', on);
      const n = counts[btn.dataset.ops];
      const b = btn.querySelector('.count');
      if (b) b.textContent = n ? String(n) : '';
    });
    typeTabs.forEach(btn => {
      const on = (btn.dataset.type || '') === messageType;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    });
    triageTabs.forEach(btn => {
      const on = (btn.dataset.triage || '') === triage;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      const level = btn.dataset.triage;
      const b = btn.querySelector('.count');
      if (b) {
        const n = level ? triageCounts[level] : 0;
        b.textContent = n ? String(n) : '';
      }
    });
    groupTabs.forEach(btn => {
      const on = (btn.dataset.nhom || '') === nhom;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      const b = btn.querySelector('.count');
      if (b) {
        const n = groupCounts[GROUP_COUNT[btn.dataset.nhom]] || 0;
        b.textContent = String(n);
      }
    });
    const zaloLine = document.getElementById('zalo-line');
    if (zaloLine) zaloLine.hidden = nhom !== 'zalo';
    zlineTabs.forEach(btn => {
      const on = (btn.dataset.zline || '') === zline;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    });
    folderTabs.forEach(btn => {
      const on = (btn.dataset.folder || '') === folder;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      const b = btn.querySelector('.count');
      if (b) b.textContent = String(folderCounts[btn.dataset.folder] || 0);
    });
  }

  function ictClock(date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  }

  function paintNew(n) {
    if (!newEl || !window.inboxRefresh) return;
    const count = Number(n) || 0;
    newEl.textContent = window.inboxRefresh.bannerLabel(count);
    newEl.hidden = count < 1;
  }

  function toast(text, action) {
    toastEl.hidden = false;
    toastEl.textContent = '';
    toastEl.appendChild(document.createTextNode(text));
    if (action) {
      const b = el('button', { type: 'button', class: 'linkish', text: action.label });
      b.addEventListener('click', () => {
        toastEl.hidden = true;
        action.run();
      });
      toastEl.appendChild(b);
    }
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.hidden = true; }, action ? 8000 : 3200);
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
    return el('label', { class: opts.wide ? 'span-2' : '' }, [
      document.createTextNode(label),
      input,
    ]);
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
      const on = c.id === salesChannel;
      const btn = el('button', {
        type: 'button',
        role: 'tab',
        class: 'pill' + (on ? ' active' : ''),
        'aria-selected': on ? 'true' : 'false',
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

  function editingHold() {
    const policy = window.inboxRefresh;
    if (!policy) return cardsDirty();
    const active = document.activeElement;
    const channelPanel = document.getElementById('channel-panel');
    return policy.editingHold({
      dirty: cardsDirty(),
      kiotOpen: !!document.querySelector('details.kiot-fold[open]'),
      composerOpen: !!document.querySelector('details.composer[open]'),
      channelFormOpen: !!(channelPanel && !channelPanel.classList.contains('hidden')),
      detailOpen: document.body.classList.contains('show-detail'),
      focusedTag: active && active !== document.body ? active.tagName : '',
    });
  }

  function renderedIds() {
    return [...listEl.querySelectorAll('.msg-card')].map(node => node.getAttribute('data-draft-id'));
  }

  function topCardAnchor() {
    const cards = listEl.querySelectorAll('.msg-card');
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= 1) continue;
      if (rect.top >= window.innerHeight) break;
      return { id: card.getAttribute('data-draft-id'), top: rect.top };
    }
    return null;
  }

  function restoreAnchor(anchor) {
    if (!anchor || !anchor.id || !window.inboxRefresh) return;
    const safe = window.CSS && CSS.escape ? CSS.escape(anchor.id) : anchor.id;
    const card = listEl.querySelector('.msg-card[data-draft-id="' + safe + '"]');
    if (!card) return;
    const delta = window.inboxRefresh.anchorDelta(anchor.top, card.getBoundingClientRect().top);
    if (Math.abs(delta) < 1) return;
    window.scrollBy(0, delta);
  }

  function findCard(id) {
    if (!id) return null;
    const safe = window.CSS && CSS.escape ? CSS.escape(id) : id;
    return listEl.querySelector('.msg-card[data-draft-id="' + safe + '"]');
  }

  function slotBefore(d) {
    const idx = drafts.findIndex(item => item && item.id === d.id);
    for (let i = idx + 1; i < drafts.length; i++) {
      const node = findCard(drafts[i] && drafts[i].id);
      if (node) return node;
    }
    return null;
  }

  function repositionChanged() {
    if (!window.inboxOrder) return;
    drafts.forEach(d => {
      const node = findCard(d.id);
      if (!node) return;
      const key = window.inboxOrder.stamp(d);
      if (node.dataset.sortKey === key) return;
      node.dataset.sortKey = key;
      const before = slotBefore(d);
      if (before && before !== node) listEl.insertBefore(node, before);
      else if (!before) listEl.appendChild(node);
    });
  }

  function insertMissing() {
    const have = new Set(renderedIds());
    const fresh = drafts.filter(d => d && d.id && !have.has(d.id));
    if (!fresh.length) return 0;
    const empty = listEl.querySelector('.empty-list');
    if (empty) empty.remove();
    fresh.forEach(d => {
      const card = buildCard(d);
      const idx = drafts.findIndex(item => item.id === d.id);
      let before = null;
      for (let i = idx + 1; i < drafts.length; i++) {
        const id = drafts[i] && drafts[i].id;
        if (!id) continue;
        const safe = window.CSS && CSS.escape ? CSS.escape(id) : id;
        const node = listEl.querySelector('.msg-card[data-draft-id="' + safe + '"]');
        if (node) { before = node; break; }
      }
      if (before) listEl.insertBefore(card, before);
      else listEl.appendChild(card);
    });
    return fresh.length;
  }

  async function load(opts) {
    opts = opts || {};
    const mode = opts.background ? 'background' : (opts.apply ? 'apply' : 'replace');
    const seq = ++loadSeq;
    if (!loadedOnce && mode === 'replace') listEl.textContent = 'Đang tải…';
    const q = new URLSearchParams();
    q.set('ops', ops);
    q.set('kenh', salesChannel);
    if (messageType) q.set('type', messageType);
    if (triage) q.set('triage', triage);
    if (nhom) q.set('nhom', nhom);
    if (nhom === 'zalo' && zline) q.set('zline', zline);
    if (folder) q.set('hop', folder);
    try {
      const [data, stats] = await Promise.all([
        api('/admin/api/drafts?' + q.toString()),
        api('/admin/api/stats?kenh=' + encodeURIComponent(salesChannel)),
      ]);
      if (seq !== loadSeq) return;
      const incoming = window.inboxOrder ? window.inboxOrder.sort(data.drafts || []) : (data.drafts || []);
      counts = data.counts || {};
      triageCounts = data.triageCounts || triageCounts;
      groupCounts = data.groupCounts || groupCounts;
      folderCounts = data.folderCounts || folderCounts;
      loadedOnce = true;
      if (chooseNhom) {
        chooseNhom = false;
        const hidden = {};
        groupTabs.forEach(btn => { if (btn.hidden) hidden[btn.dataset.nhom] = true; });
        nhom = window.inboxOrder
          ? window.inboxOrder.defaultGroup(groupCounts, hidden)
          : 'zalo';
        rememberUrl();
        syncTabs();
        return load(opts);
      }
      const hold = editingHold();
      const mutation = window.inboxRefresh
        ? window.inboxRefresh.listMutation(mode, hold)
        : (hold && mode !== 'replace' ? 'freeze' : 'replace');
      const anchor = topCardAnchor();
      syncTabs();
      if (updatedEl) updatedEl.textContent = 'Cập nhật lúc ' + ictClock(new Date());
      if (mutation === 'freeze') {
        queuedDrafts = incoming;
        const unseen = window.inboxRefresh
          ? window.inboxRefresh.unseenIds(renderedIds(), incoming).length
          : 0;
        paintNew(unseen);
        restoreAnchor(anchor);
        return;
      }
      drafts = incoming;
      queuedDrafts = null;
      if (mutation === 'insert') {
        renderStats(stats);
        repositionChanged();
        insertMissing();
        paintNew(0);
        restoreAnchor(anchor);
        return;
      }
      renderStats(stats);
      if (data.storage && data.storage !== 'postgres') {
        storageEl.hidden = false;
        storageEl.textContent = 'Bản nháp đang nằm trong bộ nhớ của server. Khởi động lại máy sẽ mất hàng đợi. Trên Railway hãy đặt DATABASE_URL để lưu vào Postgres.';
      } else {
        storageEl.hidden = true;
      }
      const keepY = window.scrollY;
      const keepList = listEl.scrollTop;
      listStamp = JSON.stringify(drafts);
      renderList();
      listEl.scrollTop = keepList;
      paintNew(0);
      const open = selectedId && drafts.find(d => d.id === selectedId);
      if (open) {
        const nextStamp = JSON.stringify(open);
        if (!dirty && nextStamp !== detailStamp) {
          detailStamp = nextStamp;
          renderDetail();
        }
      } else if (selectedId && !dirty) {
        selectedId = null;
        detailStamp = '';
        document.body.classList.remove('show-detail');
        showPlaceholder();
      }
      if (anchor && listEl.querySelector('.msg-card[data-draft-id="' + (window.CSS && CSS.escape ? CSS.escape(anchor.id) : anchor.id) + '"]')) {
        restoreAnchor(anchor);
      } else {
        window.scrollTo(window.scrollX, keepY);
      }
    } catch (e) {
      if (e.message === 'unauthorized') return;
      if (seq !== loadSeq) return;
      if (mode !== 'replace' || loadedOnce) {
        toast(e.message);
        return;
      }
      listEl.textContent = '';
      listEl.appendChild(el('p', { class: 'empty', text: e.message }));
    }
  }

  function showPlaceholder() {
    detailEl.replaceChildren(el('div', { class: 'detail-empty' }, [
      el('div', null, [
        el('strong', { text: 'Chọn một tin bên trái' }),
        el('p', { text: 'Đọc, sửa bản nháp, rồi bấm Duyệt và gửi. Hệ thống không tự gửi.' }),
      ]),
    ]));
  }

  function emptyCopy() {
    const name = GROUP_LABEL[nhom] || 'nhóm này';
    if (nhom) {
      return {
        title: 'Không có tin ' + name + '.',
        body: 'Không có tin ' + name + ' khớp bộ lọc. Chọn nhóm khác để xem Zalo OA, FB-Sale hoặc FB-DV.',
      };
    }
    if (ops !== 'pending' || triage) {
      return {
        title: 'Không có tin khớp bộ lọc.',
        body: 'Thử Chờ xử lý, hoặc bỏ bớt mức Nóng / Khẩn / Thường.',
      };
    }
    return {
      title: 'Không có tin chờ duyệt',
      body: 'Tin mới từ Zalo OA / Messenger sẽ hiện ở đây. Duyệt xong mới gửi cho khách.',
    };
  }

  function cardsDirty() {
    if (dirty) return true;
    for (const s of cardState.values()) if (s.dirty) return true;
    return false;
  }

  function ensureCard(d) {
    let s = cardState.get(d.id);
    if (!s) {
      s = { reply: d.draft_reply || d.ai_suggested_draft || '', learn: true, learnTouched: false, kiotOpen: wantsOrder(d), dirty: false };
      cardState.set(d.id, s);
    }
    return s;
  }

  function wantsOrder(d) {
    const raw = (d.customer_query || '') + ' ' + (d.customer_intent || '');
    const t = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
    return d.triage_level === 'hot' || /dat hang|dat mua|\bmua\b|\border\b|chot don/.test(t);
  }

  function renderList() {
    listEl.textContent = '';
    if (!drafts.length) {
      const copy = emptyCopy();
      const box = el('div', { class: 'empty-list' }, [
        el('strong', { text: copy.title }),
        el('p', { text: copy.body }),
      ]);
      if (ops !== 'pending') {
        const jump = el('button', { type: 'button', class: 'btn btn-sm', text: 'Xem tin chờ xử lý' });
        jump.addEventListener('click', () => guardSwitch(() => { ops = 'pending'; triage = ''; }));
        box.appendChild(jump);
      }
      listEl.appendChild(box);
      if (!selectedId) showPlaceholder();
      return;
    }
    drafts.forEach(d => listEl.appendChild(buildCard(d)));
    if (!selectedId) showPlaceholder();
  }

  const CUST_LABEL = { zalo: 'Zalo', messenger: 'Facebook', kiot: 'KiotViet' };

  function vnd(n) {
    return Number(n || 0).toLocaleString('vi-VN') + 'đ';
  }

  function customerPanel(d) {
    const box = el('div', { class: 'cust-panel' });
    box.addEventListener('click', (ev) => ev.stopPropagation());
    box.appendChild(renderCustomer(d, {
      profile: d.customer_profile || null,
      history: d.customer_history || { available: false, reason: 'no_phone' },
    }, () => reloadCustomer(d, box)));
    return box;
  }

  function reloadCustomer(d, box) {
    api('/admin/api/drafts/' + encodeURIComponent(d.id) + '/customer').then(data => {
      d.customer_profile = data.profile;
      d.customer_history = data.history;
      box.textContent = '';
      box.appendChild(renderCustomer(d, data, () => reloadCustomer(d, box)));
    }).catch(err => {
      box.appendChild(el('div', { class: 'cust-err', text: err.message || 'Chưa tải được hồ sơ khách' }));
    });
  }

  function renderCustomer(d, data, reload) {
    const profile = data && data.profile;
    const history = data && data.history;
    const wrap = el('div', { class: 'cust-body' });
    const name = (profile && profile.name) || d.customer_name || 'Khách chưa có tên';
    const phone = (profile && profile.phone) || d.customer_phone || '';
    wrap.appendChild(el('div', { class: 'cust-name', text: phone ? name + ' · ' + phone : name }));
    const channels = (profile && profile.channels) || [];
    const chips = el('div', { class: 'cust-channels' });
    if (!channels.length) chips.appendChild(el('span', { class: 'cust-muted', text: 'Chưa gắn kênh' }));
    channels.forEach(channel => {
      const chip = el('span', { class: 'cust-chip' });
      chip.appendChild(document.createTextNode(CUST_LABEL[channel] || channel));
      const drop = el('button', { type: 'button', class: 'cust-x', text: 'bỏ' });
      drop.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        api('/admin/api/customers/unlink', {
          method: 'POST',
          body: JSON.stringify({ phone: profile.phone, channel }),
        }).then(reload).catch(err => { statusNote(wrap, err.message); });
      });
      chip.appendChild(drop);
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    wrap.appendChild(historyLine(history));
    const form = el('form', { class: 'cust-link' });
    const input = el('input', {
      type: 'text',
      name: 'phone',
      placeholder: 'Gắn số điện thoại',
      maxlength: '20',
      value: phone,
    });
    input.value = phone;
    input.addEventListener('click', (ev) => ev.stopPropagation());
    const go = el('button', { type: 'submit', class: 'btn btn-sm', text: 'Gắn' });
    form.appendChild(input);
    form.appendChild(go);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      api('/admin/api/customers/link', {
        method: 'POST',
        body: JSON.stringify({ draft_id: d.id, phone: input.value, name: d.customer_name || '' }),
      }).then(reload).catch(err => { statusNote(wrap, err.message); });
    });
    wrap.appendChild(form);
    return wrap;
  }

  function statusNote(wrap, message) {
    const old = wrap.querySelector('.cust-err');
    if (old) old.remove();
    wrap.appendChild(el('div', { class: 'cust-err', text: message || 'Không lưu được' }));
  }

  function historyLine(history) {
    const box = el('div', { class: 'cust-history' });
    if (!history || history.available !== true) {
      const reason = history && history.reason;
      const text = reason === 'no_phone'
        ? 'Nhập số để xem lịch sử mua.'
        : (reason === 'unconfigured' ? 'Chưa nối KiotViet.' : 'Chưa lấy được lịch sử mua.');
      box.appendChild(el('span', { class: 'cust-muted', text }));
      return box;
    }
    if (!history.total_spent && !(history.orders || []).length) {
      box.appendChild(el('span', { class: 'cust-muted', text: 'Chưa có đơn trên KiotViet.' }));
      return box;
    }
    const bits = [
      'Tổng ' + vnd(history.total_spent),
      history.last_purchase ? 'lần cuối ' + history.last_purchase : '',
      (history.unpaid_count ? history.unpaid_count + ' hóa đơn chưa thanh toán' : 'không nợ hóa đơn'),
    ].filter(Boolean).join(' · ');
    box.appendChild(el('div', { text: bits }));
    (history.orders || []).forEach(order => {
      const line = [order.date, order.code, vnd(order.total), order.unpaid ? 'chưa thanh toán' : ''].filter(Boolean).join(' · ');
      box.appendChild(el('div', { class: 'cust-order', text: line }));
    });
    return box;
  }

  function buildCard(d) {
      const s = ensureCard(d);
      if (!s.dirty) s.reply = d.draft_reply || d.ai_suggested_draft || '';
      const btn = el('button', {
        type: 'button',
        class: 'msg' + (d.id === selectedId ? ' selected' : ''),
      });
      const triageCls = TRIAGE_CLASS[d.triage_level] || 'tag-thuong';
      const tags = el('div', { class: 'tags' });
      if (TRIAGE_LABEL[d.triage_level]) {
        tags.appendChild(el('span', {
          class: 'tag ' + triageCls,
          text: d.triage_label || TRIAGE_LABEL[d.triage_level],
        }));
      }
      const ch = channelTag(d);
      tags.appendChild(el('span', { class: 'tag ' + ch.cls, text: ch.text }));
      const lineTag = bizTag(d);
      if (lineTag) tags.appendChild(lineTag);
      const kind = kindTag(d);
      if (kind) tags.appendChild(el('span', { class: 'tag ' + kind.cls, text: kind.text }));
      if (d.inbox_prev_status && FOLDER_LABEL[d.inbox_prev_status]) {
        tags.appendChild(el('span', { class: 'tag tag-prev', text: 'trước: ' + FOLDER_LABEL[d.inbox_prev_status] }));
      }
      if (d.decline_hint && d.inbox_status !== 'declined') {
        tags.appendChild(el('span', { class: 'tag tag-refund', text: 'Gợi ý: Từ chối' }));
      }
      const top = el('div', { class: 'msg-top' });
      const nameBox = el('div', { class: 'msg-names' });
      channelNameNodes(d).forEach(node => nameBox.appendChild(node));
      top.appendChild(nameBox);
      top.appendChild(el('span', { class: 'msg-time', text: when(d.created_at) }));
      btn.appendChild(top);
      btn.appendChild(el('div', { class: 'msg-kicker', text: 'Khách nhắn' }));
      btn.appendChild(el('div', { class: 'msg-customer', text: snippet(d) || '—' }));
      btn.appendChild(tags);
      btn.addEventListener('click', () => openDraft(d.id));
      const card = el('div', {
        class: 'msg-card' + (d.id === selectedId ? ' selected' : ''),
        'data-draft-id': d.id,
      });
      if (window.inboxOrder) card.dataset.sortKey = window.inboxOrder.stamp(d);
      card.appendChild(btn);
      card.appendChild(customerPanel(d));

      const openReply = d.approval_status !== 'SENT' && d.approval_status !== 'REJECTED' && !d.deleted_at;
      const replyLabel = el('div', { class: 'draft-label' }, [
        el('label', { text: 'Gợi ý trả lời' }),
        el('span', { text: 'Sửa được. Chỉ gửi khi bấm Duyệt & Gửi.' }),
      ]);
      const reply = el('textarea', {
        class: 'card-reply',
        rows: '4',
        placeholder: 'Chưa có bản AI. Gõ câu trả lời cho khách.',
      });
      reply.value = s.reply || '';
      if (!openReply) reply.disabled = true;
      reply.addEventListener('input', () => {
        s.reply = reply.value;
        s.dirty = true;
        dirty = true;
      });
      reply.addEventListener('click', (ev) => ev.stopPropagation());
      card.appendChild(replyLabel);
      card.appendChild(reply);

      const actions = el('div', { class: 'card-actions' });
      if (openReply && me.canSend) {
        const sendBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Duyệt & Gửi' });
        sendBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          approveCard(d);
        });
        actions.appendChild(sendBtn);
      }
      actions.appendChild(lineActions(d));
      card.appendChild(actions);

      if (openReply) {
        const learn = el('label', { class: 'learn-toggle' });
        const box = el('input', { type: 'checkbox', class: 'learn-check' });
        box.checked = s.learnTouched ? s.learn : true;
        box.addEventListener('change', () => {
          s.learn = box.checked;
          s.learnTouched = true;
        });
        learn.appendChild(box);
        learn.appendChild(document.createTextNode(' Cho AI học từ câu trả lời này'));
        card.appendChild(learn);
      }

      if (!d.deleted_at) card.appendChild(statusActions(d));

      const fold = el('details', { class: 'kiot-fold' });
      if (s.kiotOpen || wantsOrder(d)) fold.open = true;
      fold.appendChild(el('summary', { text: 'Tạo đơn KiotViet' }));
      fold.addEventListener('toggle', () => {
        s.kiotOpen = fold.open;
        if (fold.open && !fold.querySelector('.kiot-panel')) fold.appendChild(kiotPanel(d, d.id));
      });
      if (fold.open) fold.appendChild(kiotPanel(d, d.id));
      if (me.canKiot) card.appendChild(fold);
      return card;
  }

  function triageBadge(d) {
    if (!d || !TRIAGE_LABEL[d.triage_level]) return null;
    return el('span', {
      class: 'tag triage ' + d.triage_level + ' ' + (TRIAGE_CLASS[d.triage_level] || ''),
      text: d.triage_label || TRIAGE_LABEL[d.triage_level],
    });
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

  function withCurrent(options, id, name) {
    const list = options.slice();
    if (id && !list.some(o => o.id === id)) {
      list.unshift({ id, name: name || id });
    }
    return list;
  }

  function fillPlaceSelect(select, options, selected, placeholder) {
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: placeholder }));
    options.forEach(opt => {
      const o = el('option', { value: opt.id, text: opt.name });
      if (opt.id === selected) o.selected = true;
      select.appendChild(o);
    });
    if (selected) select.value = selected;
  }

  function selectedName(select) {
    if (!select) return '';
    const opt = select.options[select.selectedIndex];
    if (!opt || !select.value) return '';
    return opt.textContent || '';
  }

  function renderDetail() {
    const d = currentDraft();
    detailEl.textContent = '';
    if (!d) return;
    const locked = d.approval_status === 'SENT';
    const refund = isRefund(d);
    const addrOn = showAddress(d);
    const f = formOf(d);
    const back = el('button', { type: 'button', class: 'btn btn-sm back', text: '← Danh sách' });
    back.addEventListener('click', () => {
      document.body.classList.remove('show-detail');
    });

    const form = el('form', { class: 'draft-form' });
    form.addEventListener('submit', e => e.preventDefault());
    form.appendChild(back);

    const body = el('div', { class: 'detail-body' });
    const code = d.customer_code || f.kiot_ref || '';
    const nameRow = el('div', { class: 'name-row' });
    const nameBox = el('div', { class: 'msg-names' });
    channelNameNodes(d).forEach(node => nameBox.appendChild(node));
    nameRow.appendChild(nameBox);
    const kiotShown = Array.isArray(d.channel_names) && d.channel_names.some(item => item && item.code);
    if (code && !kiotShown) {
      nameRow.appendChild(el('span', { class: 'cust-code', title: 'Mã khách hàng', text: code }));
    }
    const meta = el('div', { class: 'detail-meta' }, [nameRow]);
    const badge = triageBadge(d);
    if (badge) meta.appendChild(badge);
    const ch = channelTag(d);
    meta.appendChild(el('span', { class: 'tag ' + ch.cls, text: ch.text }));
    const lineTag = bizTag(d);
    if (lineTag) meta.appendChild(lineTag);
    const kind = kindTag(d);
    if (kind) meta.appendChild(el('span', { class: 'tag ' + kind.cls, text: kind.text }));
    body.appendChild(meta);
    body.appendChild(lineActions(d, 'detail-actions'));

    body.appendChild(el('div', { class: 'want-box' }, [
      el('span', { text: 'Khách đang muốn' }),
      el('div', { text: snippet(d) || '—' }),
    ]));
    body.appendChild(kiotPanel(d));

    if (needsHumanTicket(d) && !refund) {
      body.appendChild(el('p', {
        class: 'banner warn',
        text: 'Cần người xem trước khi gửi. Bản nháp này chưa được gửi.',
      }));
    }
    if (d.send_error) {
      body.appendChild(el('p', {
        class: 'banner ' + (d.approval_status === 'SENT' ? 'warn' : 'bad'),
        text: d.send_error,
      }));
    }
    if (d.pii_note) body.appendChild(el('p', { class: 'hint', text: d.pii_note }));

    const grid = el('div', { class: 'grid2' });
    grid.appendChild(blockField('customer_phone', 'Số điện thoại', d.customer_phone, { disabled: locked, placeholder: 'Nếu có' }));
    grid.appendChild(blockField('invoice_code', 'Mã hoá đơn', d.invoice_code, { disabled: locked, placeholder: 'Ví dụ: HD011637' }));
    body.appendChild(grid);

    if (refund) body.appendChild(refundPanel(d, f, locked));
    if (addrOn) body.appendChild(addressPanel(f, locked));

    const labelRow = el('div', { class: 'draft-label' }, [
      el('label', { for: 'draft-reply', text: 'Bản nháp trả lời' }),
      el('span', { text: 'Sửa trước khi duyệt' }),
    ]);
    body.appendChild(labelRow);
    const reply = el('textarea', { id: 'draft-reply', name: 'draft_reply', rows: '8' });
    reply.value = d.draft_reply || '';
    if (locked) reply.disabled = true;
    reply.addEventListener('input', () => {
      dirty = true;
      const s = ensureCard(d);
      s.reply = reply.value;
      s.dirty = true;
    });
    body.appendChild(el('div', { class: 'field-block' }, [reply]));
    if (!locked) {
      const learn = el('label', { class: 'learn-toggle' });
      const box = el('input', { type: 'checkbox', class: 'learn-check' });
      const s = ensureCard(d);
      box.checked = s.learnTouched ? s.learn : true;
      box.addEventListener('change', () => { s.learn = box.checked; s.learnTouched = true; });
      learn.appendChild(box);
      learn.appendChild(document.createTextNode(' Cho AI học từ câu trả lời này'));
      body.appendChild(learn);
    }

    const extra = el('details', { class: 'extra-detail' });
    extra.appendChild(el('summary', { text: 'Thêm chi tiết gửi' }));
    const extraGrid = el('div', { class: 'grid' });
    extraGrid.appendChild(field('customer_name', 'Tên khách', d.customer_name, { disabled: locked }));
    extraGrid.appendChild(field('customer_code', 'Mã khách hàng', d.customer_code, { disabled: locked }));
    extraGrid.appendChild(field('sales_channel', 'Kênh bán', d.sales_channel || 'farm', {
      disabled: locked,
      options: channelOptions(),
    }));
    extraGrid.appendChild(field('channel', 'Đường gửi', d.channel, {
      disabled: locked,
      options: [
        { value: 'zalo', label: 'Zalo' },
        { value: 'messenger', label: 'FB / Messenger' },
      ],
    }));
    extraGrid.appendChild(field('message_type', 'Loại tin', d.message_type || '', {
      disabled: locked,
      options: [
        { value: '', label: 'Chưa chọn' },
        { value: 'follower', label: 'Follower' },
        { value: 'zns', label: 'ZNS' },
        { value: 'broadcast', label: 'Broadcast' },
      ],
    }));
    extraGrid.appendChild(field('template_name', 'Mẫu', d.template_name, { disabled: locked }));
    extraGrid.appendChild(field('customer_user_id', 'User id', d.customer_user_id, { disabled: locked, wide: true }));
    extraGrid.appendChild(field('customer_intent', 'Khách đang muốn', d.customer_intent, { disabled: locked, wide: true }));
    extraGrid.appendChild(field('assigned_department', 'Bộ phận', d.assigned_department, { disabled: locked }));
    extraGrid.appendChild(field('ticket_status', 'Trạng thái ticket', d.ticket_status, { disabled: locked }));
    extraGrid.appendChild(field('kiot_summary', 'Tóm tắt Kiot', d.kiot_summary, { disabled: locked, wide: true, multiline: true, rows: '3' }));
    extraGrid.appendChild(field('qr_image_url', 'Link ảnh QR', d.qr_image_url, { disabled: locked, wide: true }));
    extra.appendChild(extraGrid);
    extra.appendChild(el('p', {
      class: 'hint',
      text: '@Farm gửi qua Zalo sau khi duyệt. Zalo Bot dùng bot_ rồi tới chat id. Messenger dùng fb_ rồi tới PSID và chỉ gửi khi bật MESSENGER_ENABLED rồi bấm Duyệt và gửi. Shopee, FB và kênh tự thêm chưa có đường gửi — duyệt xong tin nằm ở Chờ gửi.',
    }));
    if (d.qr_image_url && /^https?:\/\//i.test(d.qr_image_url)) {
      extra.appendChild(el('img', { class: 'qr', alt: 'Mã QR', src: d.qr_image_url }));
    }
    body.appendChild(extra);
    form.appendChild(body);

    const actions = el('div', { class: 'sticky-actions' });
    if (!locked) {
      const sendLabel = refund ? 'Duyệt và gửi phản hồi' : 'Duyệt và gửi';
      const sendBtn = actionButton(sendLabel, refund ? 'send refund-mode' : 'send', () => send());
      sendBtn.id = 'btn-approve';
      actions.appendChild(sendBtn);
      actions.appendChild(actionButton('Lưu', 'ghost', () => save()));
      if (d.approval_status !== 'REJECTED') {
        actions.appendChild(actionButton('Từ chối', 'danger', () => reject()));
      }
      if (d.approval_status !== 'PENDING_REVIEW') {
        actions.appendChild(actionButton('Đưa về chờ xử lý', 'ghost', () => reopen()));
      }
    }
    actions.appendChild(el('span', {
      class: 'sticky-note',
      text: refund
        ? 'Hoàn tiền cần người quyết. Tin chỉ đi khi bấm Duyệt và gửi — không tự hoàn.'
        : 'Không tự gửi. Chỉ đi khi bấm Duyệt và gửi.',
    }));
    form.appendChild(actions);
    detailEl.appendChild(form);
    document.body.classList.add('show-detail');
  }

  function blockField(name, label, value, opts) {
    opts = opts || {};
    const input = el('input', { name, type: 'text', placeholder: opts.placeholder || '' });
    input.value = value || '';
    if (opts.disabled) input.disabled = true;
    input.addEventListener('input', () => { dirty = true; });
    return el('div', { class: 'field-block' }, [
      el('label', { text: label }),
      input,
    ]);
  }

  function refundPanel(d, f, locked) {
    const panel = el('div', { class: 'refund-panel', id: 'd-refund' });
    panel.appendChild(el('h4', { text: 'Đổi trả / hoàn tiền — cần người duyệt' }));
    panel.appendChild(el('p', {
      class: 'refund-lead',
      text: 'Không tự hoàn. Không dùng chữ “đã duyệt hoàn”. Bạn chọn hướng xử lý, rồi mới Duyệt và gửi tin cho khách.',
    }));
    const decide = el('div', { class: 'decide' }, [
      el('span', { text: 'Quyết định của bạn' }),
    ]);
    const opts = el('div', { class: 'decide-opts', role: 'radiogroup', 'aria-label': 'Quyết định hoàn tiền' });
    const choice = f.refund_decision || 'hoi';
    [
      ['hoan', 'Đồng ý hoàn tiền'],
      ['doi', 'Đổi hàng'],
      ['hoi', 'Cần hỏi thêm'],
    ].forEach(([value, label]) => {
      const input = el('input', { type: 'radio', name: 'refund_decision', value });
      if (choice === value) input.checked = true;
      if (locked) input.disabled = true;
      input.addEventListener('change', () => { dirty = true; });
      opts.appendChild(el('label', null, [input, document.createTextNode(label)]));
    });
    decide.appendChild(opts);
    panel.appendChild(decide);

    const grid = el('div', { class: 'refund-grid' });
    grid.appendChild(blockField('refund_amount', 'Số tiền hoàn (nếu có)', f.refund_amount, {
      disabled: locked, placeholder: 'Ví dụ: 189.000đ',
    }));
    grid.appendChild(blockField('kiot_ref', 'Mã khách / Kiot', f.kiot_ref || d.customer_code, {
      disabled: locked, placeholder: 'Nếu tra được',
    }));
    panel.appendChild(grid);
    panel.appendChild(blockField('internal_note', 'Ghi chú nội bộ (không gửi khách)', f.internal_note, {
      disabled: locked, placeholder: 'Ví dụ: hàng rò — chờ xác nhận trước khi hoàn',
    }));
    panel.appendChild(el('p', {
      class: 'refund-note',
      text: 'Tin trả khách ở dưới vẫn chỉ đi khi bấm Duyệt và gửi.',
    }));
    return panel;
  }

  function addressPanel(f, locked) {
    const box = el('div', { class: 'addr-block', id: 'd-address' });
    box.appendChild(el('div', { class: 'addr-head' }, [
      el('h4', { text: 'Địa chỉ giao / hoàn (ViettelPost)' }),
      el('span', { class: 'addr-hint', text: '3 cấp + địa chỉ chi tiết' }),
    ]));
    const grid = el('div', { class: 'addr-grid3' });
    const province = el('select', { id: 'd-province', name: 'province_id', 'aria-label': 'Tỉnh Thành phố ViettelPost' });
    const district = el('select', { id: 'd-district', name: 'district_id', 'aria-label': 'Quận Huyện ViettelPost' });
    const ward = el('select', { id: 'd-ward', name: 'ward_id', 'aria-label': 'Phường Xã ViettelPost' });
    if (locked) {
      province.disabled = true;
      district.disabled = true;
      ward.disabled = true;
    }
    grid.appendChild(el('div', { class: 'field-block' }, [
      el('label', { for: 'd-province', text: 'Tỉnh / Thành phố' }),
      province,
    ]));
    grid.appendChild(el('div', { class: 'field-block' }, [
      el('label', { for: 'd-district', text: 'Quận / Huyện' }),
      district,
    ]));
    grid.appendChild(el('div', { class: 'field-block' }, [
      el('label', { for: 'd-ward', text: 'Phường / Xã' }),
      ward,
    ]));
    box.appendChild(grid);

    const street = el('input', {
      id: 'd-street',
      name: 'address_detail',
      type: 'text',
      placeholder: 'Ví dụ: 12 Nguyễn Xí, hẻm 3',
    });
    street.value = f.address_detail || '';
    if (locked) street.disabled = true;
    street.addEventListener('input', () => { dirty = true; });
    box.appendChild(el('div', { class: 'field-block' }, [
      el('label', { for: 'd-street', text: 'Địa chỉ chi tiết (số nhà, đường)' }),
      street,
    ]));

    const slot = el('select', { id: 'd-delivery-slot', name: 'delivery_slot', 'aria-label': 'Thời gian hẹn giao' });
    SLOTS.forEach(opt => {
      const o = el('option', { value: opt.value, text: opt.label });
      if ((f.delivery_slot || 'all') === opt.value) o.selected = true;
      slot.appendChild(o);
    });
    if (locked) slot.disabled = true;
    slot.addEventListener('change', () => { dirty = true; });
    box.appendChild(el('div', { class: 'field-block' }, [
      el('label', { for: 'd-delivery-slot', text: 'Thời gian hẹn giao' }),
      slot,
    ]));

    const ids = el('div', { class: 'addr-ids', 'aria-label': 'Mã ViettelPost' });
    const provinceCode = el('code', { id: 'd-province-id', text: '—' });
    const districtCode = el('code', { id: 'd-district-id', text: '—' });
    const wardCode = el('code', { id: 'd-ward-id', text: '—' });
    ids.appendChild(el('span', null, [document.createTextNode('PROVINCE_ID '), provinceCode]));
    ids.appendChild(el('span', null, [document.createTextNode('DISTRICT_ID '), districtCode]));
    ids.appendChild(el('span', null, [document.createTextNode('WARDS_ID '), wardCode]));
    box.appendChild(ids);

    function syncIds() {
      provinceCode.textContent = province.value || '—';
      districtCode.textContent = district.value || '—';
      wardCode.textContent = ward.value || '—';
    }
    const districtList = withCurrent([].concat(...Object.values(VTP_DISTRICTS)), f.district_id, f.district_name);
    const wardList = withCurrent([].concat(...Object.values(VTP_WARDS)), f.ward_id, f.ward_name);
    fillPlaceSelect(province, withCurrent(VTP_PROVINCES, f.province_id, f.province_name), f.province_id || '', 'Chọn tỉnh / thành');
    fillPlaceSelect(district, districtList, f.district_id || '', 'Chọn quận / huyện');
    fillPlaceSelect(ward, wardList, f.ward_id || '', 'Chọn phường / xã');
    syncIds();
    [province, district, ward].forEach(select => {
      select.addEventListener('change', () => { dirty = true; syncIds(); });
    });
    return box;
  }

  function actionButton(label, kind, onClick) {
    const cls = kind === 'send'
      ? 'btn btn-primary'
      : kind === 'send refund-mode'
        ? 'btn btn-primary refund-mode'
        : kind === 'danger'
          ? 'btn btn-danger'
          : 'btn';
    const btn = el('button', { type: 'button', class: cls, text: label });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function reviewFormPayload(data) {
    return {
      refund_decision: data.refund_decision || null,
      refund_amount: data.refund_amount || null,
      internal_note: data.internal_note || null,
      kiot_ref: data.kiot_ref || null,
      province_id: data.province_id || null,
      province_name: selectedName(detailEl.querySelector('#d-province')) || null,
      district_id: data.district_id || null,
      district_name: selectedName(detailEl.querySelector('#d-district')) || null,
      ward_id: data.ward_id || null,
      ward_name: selectedName(detailEl.querySelector('#d-ward')) || null,
      address_detail: data.address_detail || null,
      delivery_slot: data.delivery_slot || null,
      kiot_code: (formOf(currentDraft()).kiot_code) || null,
      kiot_total: (formOf(currentDraft()).kiot_total) || null,
      kiot_kind: (formOf(currentDraft()).kiot_kind) || null,
    };
  }

  function learnChecked() {
    const box = detailEl.querySelector('.learn-check');
    if (box) return box.checked;
    const s = selectedId && cardState.get(selectedId);
    if (s && s.learnTouched) return s.learn !== false;
    return true;
  }

  function payload(extra) {
    const data = readForm();
    const body = {
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
      review_form: reviewFormPayload(data),
      learn: learnChecked(),
    };
    return Object.assign(body, extra || {});
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
      const sendResult = res.send;
      if (sendResult && sendResult.sent) toast(learnNote(res, true));
      else if (sendResult && sendResult.pendingAdapter) toast(learnNote(res, false) + ' Kênh chưa có đường gửi.');
      else if (sendResult && !sendResult.sent) toast('Đã duyệt, chưa gửi được. Xem lý do phía trên.');
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
    const refund = !!detailEl.querySelector('#d-refund');
    let msg = refund
      ? 'Gửi phản hồi này cho khách? Hoàn tiền không tự chạy — chỉ tin nhắn được gửi.'
      : 'Gửi tin này cho khách?';
    if (data.sales_channel && data.sales_channel !== 'farm') {
      const ch = channels.find(c => c.id === data.sales_channel);
      msg = 'Kênh ' + (ch ? ch.name : data.sales_channel) + ' chưa có đường gửi. Tin sẽ được duyệt và nằm ở Chờ gửi. Tiếp tục?';
    } else if (data.channel === 'messenger') {
      msg = refund
        ? 'Gửi phản hồi này cho khách trên Facebook Messenger? Hoàn tiền không tự chạy.'
        : 'Gửi tin này cho khách trên Facebook Messenger?';
    }
    if (!confirm(msg)) return;
    return patch(payload({ approval_status: 'APPROVED', send: true }), 'Đã duyệt.');
  }

  function vnd(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    return Math.round(x).toLocaleString('vi-VN') + 'đ';
  }

  function kiotMark(d) {
    if (!d) return null;
    const f = formOf(d);
    if (f.kiot_code) return { code: f.kiot_code, total: f.kiot_total };
    const code = String(d.invoice_code || '').trim();
    if (/^(HD|DH)/i.test(code)) return { code, total: null };
    return null;
  }

  function openDraft(id, opts) {
    if (dirty && selectedId !== id && !confirm('Bạn đang sửa dở. Chuyển tin khác sẽ bỏ phần chưa lưu?')) return;
    dirty = false;
    selectedId = id;
    const row = drafts.find(item => item.id === id);
    detailStamp = row ? JSON.stringify(row) : '';
    rememberUrl();
    document.body.classList.add('show-detail');
    renderList();
    renderDetail();
    if (opts && opts.focusKiot) {
      const panel = detailEl.querySelector('.kiot-panel');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
    }
  }

  function addressText(d) {
    const f = formOf(d);
    return [f.address_detail, f.ward_name, f.district_name, f.province_name]
      .map(part => String(part || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  function stockText(stock) {
    if (!stock || stock.level == null || stock.level === 'unknown') return 'Chưa rõ tồn';
    if (stock.level === 'blocked') {
      if (Number(stock.available) === 0) return 'Hết hàng';
      return 'Không đủ (còn ' + stock.available + ')';
    }
    if (stock.level === 'low') return 'Sắp hết (còn ' + stock.available + ')';
    return 'Còn ' + stock.available;
  }

  function kiotPanel(d, prefix) {
    const pid = prefix ? String(prefix) : 'detail';
    const state = {
      document: 'invoice',
      lines: [blankKiotLine()],
      quote: null,
      submitting: false,
      touched: {},
      existing: kiotMark(d),
      acknowledge: false,
      kiotCustomer: null,
      lookupTimer: null,
    };
    const panel = el('section', { class: 'kiot-panel', id: 'kiot-panel-' + pid });
    panel.appendChild(el('h4', { text: 'Tạo đơn KiotViet' }));
    panel.appendChild(el('p', {
      class: 'kiot-lead',
      text: 'Điền nhanh hoặc chọn từng món. Chưa tạo trên KiotViet cho đến khi bạn bấm xác nhận. Tin khách không tự gửi.',
    }));

    const quick = el('textarea', {
      class: 'kiot-quick',
      rows: '2',
      placeholder: '1 xuc xich, 2 nước nghệ lên men',
      'aria-label': 'Nhập nhanh sản phẩm và số lượng',
    });
    quick.addEventListener('input', () => { state.touched.quick = true; dirty = true; state.quote = null; });
    const quickBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Điền vào đơn' });
    quickBtn.addEventListener('click', () => runQuick());
    panel.appendChild(el('div', { class: 'kiot-quick-row' }, [quick, quickBtn]));
    const quickMsg = el('p', { class: 'kiot-msg', hidden: 'hidden' });
    panel.appendChild(quickMsg);

    const exist = el('p', { class: 'banner warn', hidden: 'hidden' });
    const ackLabel = el('label', { class: 'kiot-ack', hidden: 'hidden' });
    const ack = el('input', { type: 'checkbox' });
    ack.addEventListener('change', () => { state.acknowledge = ack.checked; });
    ackLabel.appendChild(ack);
    ackLabel.appendChild(document.createTextNode(' Vẫn tạo thêm một chứng từ'));
    function showExisting(mark) {
      if (!mark) return;
      state.existing = mark;
      exist.hidden = false;
      exist.textContent = 'Nháp này đã có ' + mark.code + (mark.total != null && mark.total !== '' ? ' · ' + vnd(mark.total) : '') + '. Tạo thêm dễ bị trùng.';
      ackLabel.hidden = false;
    }
    if (state.existing) showExisting(state.existing);
    panel.appendChild(exist);
    panel.appendChild(ackLabel);

    const docRow = el('div', { class: 'kiot-docs', role: 'group', 'aria-label': 'Loại chứng từ' });
    const invoiceBtn = el('button', { type: 'button', class: 'chip active', text: 'Hoá đơn (HĐ)' });
    const orderBtn = el('button', { type: 'button', class: 'chip', text: 'Đặt hàng (ĐH)' });
    function setDoc(kind) {
      state.document = kind;
      state.quote = null;
      invoiceBtn.classList.toggle('active', kind === 'invoice');
      orderBtn.classList.toggle('active', kind === 'order');
      paintSummary();
    }
    invoiceBtn.addEventListener('click', () => setDoc('invoice'));
    orderBtn.addEventListener('click', () => setDoc('order'));
    docRow.appendChild(invoiceBtn);
    docRow.appendChild(orderBtn);
    panel.appendChild(docRow);

    const grid = el('div', { class: 'kiot-grid' });
    const seeded = seededKiotName(d);
    const nameInput = kiotInput('Tên khách', seeded.name, 'kiot-name-' + pid);
    const nameHint = el('p', { class: 'kiot-name-hint', text: seeded.hint });
    nameHint.hidden = !seeded.hint;
    nameInput.wrap.appendChild(nameHint);
    const phoneInput = kiotInput('Số điện thoại', d.customer_phone || '', 'kiot-phone-' + pid);
    const addrInput = kiotInput('Địa chỉ giao', addressText(d), 'kiot-address-' + pid);
    nameInput.input.addEventListener('input', () => {
      state.touched.name = true;
      dirty = true;
      nameHint.textContent = '';
      nameHint.hidden = true;
    });
    phoneInput.input.addEventListener('input', () => {
      state.touched.phone = true;
      dirty = true;
      state.quote = null;
      scheduleKiotLookup();
    });
    addrInput.input.addEventListener('input', () => { state.touched.address = true; dirty = true; });
    grid.appendChild(nameInput.wrap);
    grid.appendChild(phoneInput.wrap);
    grid.appendChild(addrInput.wrap);
    panel.appendChild(grid);

    const linesEl = el('div', { class: 'kiot-lines' });
    panel.appendChild(linesEl);
    const addBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Thêm dòng' });
    addBtn.addEventListener('click', () => {
      state.lines.push(blankKiotLine());
      state.quote = null;
      paintLines();
    });
    panel.appendChild(addBtn);

    const moneyRow = el('div', { class: 'kiot-money' });
    const discountInput = kiotInput('Giảm giá (đ)', '0', 'kiot-discount-' + pid);
    const shipInput = kiotInput('Phí ship (đ)', '0', 'kiot-ship-' + pid);
    const noteInput = kiotInput('Ghi chú', '', 'kiot-note-' + pid);
    discountInput.input.addEventListener('input', () => { state.quote = null; paintTotals(); });
    shipInput.input.addEventListener('input', () => { state.touched.ship = true; state.quote = null; paintTotals(); });
    noteInput.input.addEventListener('input', () => { dirty = true; });
    moneyRow.appendChild(discountInput.wrap);
    moneyRow.appendChild(shipInput.wrap);
    panel.appendChild(moneyRow);
    panel.appendChild(noteInput.wrap);

    const totals = el('p', { class: 'kiot-total', text: '' });
    panel.appendChild(totals);
    const summary = el('div', { class: 'kiot-summary hidden' });
    panel.appendChild(summary);
    const err = el('p', { class: 'banner bad hidden' });
    panel.appendChild(err);

    const actions = el('div', { class: 'kiot-actions' });
    const quoteBtn = el('button', { type: 'button', class: 'btn', text: 'Kiểm kho và xem lại' });
    const confirmBtn = el('button', { type: 'button', class: 'btn btn-primary', text: 'Xác nhận tạo hoá đơn' });
    confirmBtn.disabled = true;
    quoteBtn.addEventListener('click', () => runQuote(false));
    confirmBtn.addEventListener('click', () => runQuote(true));
    actions.appendChild(quoteBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);

    function showError(text) {
      if (!text) {
        err.classList.add('hidden');
        err.textContent = '';
        return;
      }
      err.classList.remove('hidden');
      err.textContent = text;
    }

    function payloadLines() {
      return state.lines.filter(line => line.sku || line.name || line.phrase).map(line => ({
        sku: line.sku || '',
        product_name: line.name || line.phrase || '',
        quantity: Number(line.quantity) || 0,
      }));
    }

    function moneyVal(input) {
      const raw = String(input.value || '').trim();
      if (!raw) return 0;
      const n = Number(raw.replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : 0;
    }

    function localTotal() {
      const sub = state.lines.reduce((sum, line) => {
        const price = Number(line.price);
        const qty = Number(line.quantity);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) return sum;
        return sum + price * qty;
      }, 0);
      return Math.max(0, sub - moneyVal(discountInput.input) + moneyVal(shipInput.input));
    }

    function paintTotals() {
      const ready = state.lines.some(line => line.sku && line.price != null);
      totals.textContent = ready ? 'Tổng tạm tính: ' + vnd(localTotal()) : 'Chọn sản phẩm để thấy giá KiotViet.';
    }

    function paintSummary() {
      const q = state.quote;
      confirmBtn.textContent = state.document === 'order' ? 'Xác nhận tạo đơn đặt hàng' : 'Xác nhận tạo hoá đơn';
      if (!q || q.created) {
        summary.classList.add('hidden');
        confirmBtn.disabled = true;
        return;
      }
      summary.classList.remove('hidden');
      summary.textContent = '';
      const title = state.document === 'order' ? 'Xem lại đơn đặt hàng' : 'Xem lại hoá đơn';
      summary.appendChild(el('strong', { text: title }));
      const who = [nameInput.input.value.trim() || 'Khách', phoneInput.input.value.trim()].filter(Boolean).join(' · ');
      summary.appendChild(el('p', { text: who }));
      if (addrInput.input.value.trim()) summary.appendChild(el('p', { text: 'Giao: ' + addrInput.input.value.trim() }));
      (q.lines || []).forEach(line => {
        const stock = line.stock ? ' — ' + stockText(line.stock) : '';
        summary.appendChild(el('p', {
          text: (line.name || line.sku) + ' × ' + line.quantity + ' · ' + vnd(line.line_total) + stock,
        }));
      });
      summary.appendChild(el('p', { text: 'Giảm ' + vnd(q.discount) + ' · Ship ' + vnd(q.shipping_fee) }));
      summary.appendChild(el('p', { class: 'kiot-grand', text: 'Tổng ' + vnd(q.total) }));
      if (q.stock && q.stock.decision === 'low') {
        summary.appendChild(el('p', { class: 'kiot-warn', text: q.stock.summary || 'Sắp hết hàng.' }));
      }
      const blocked = q.stock && (q.stock.decision === 'blocked' || q.stock.decision === 'skipped');
      const missing = (q.lines || []).some(line => line.missing || !line.sku);
      confirmBtn.disabled = state.submitting || blocked || missing || !q.can_confirm;
    }

    function paintLines() {
      linesEl.textContent = '';
      state.lines.forEach((line, index) => linesEl.appendChild(lineRow(line, index)));
      paintTotals();
      paintSummary();
    }

    function lineRow(line, index) {
      const row = el('div', { class: 'kiot-line' + (line.status === 'unmatched' ? ' unmatched' : line.status === 'ambiguous' ? ' ambiguous' : '') });
      const head = el('div', { class: 'kiot-line-head' });
      if (line.sku) {
        head.appendChild(el('strong', { text: line.name || line.sku }));
        head.appendChild(el('span', { class: 'kiot-code', text: line.sku + (line.unit ? ' · ' + line.unit : '') }));
      } else if (line.status === 'unmatched') {
        head.appendChild(el('strong', { text: 'Chưa khớp: ' + (line.phrase || 'dòng này') }));
      } else if (line.status === 'ambiguous') {
        head.appendChild(el('strong', { text: 'Chọn giúp: ' + (line.phrase || 'dòng này') }));
      } else {
        head.appendChild(el('strong', { text: 'Sản phẩm' }));
      }
      const remove = el('button', { type: 'button', class: 'kiot-remove', text: 'Xoá' });
      remove.addEventListener('click', () => {
        state.lines.splice(index, 1);
        if (!state.lines.length) state.lines.push(blankKiotLine());
        state.quote = null;
        dirty = true;
        paintLines();
      });
      head.appendChild(remove);
      row.appendChild(head);

      if (!line.sku) {
        if (line.status === 'ambiguous' && line.candidates && line.candidates.length) {
          const pick = el('select', { 'aria-label': 'Chọn sản phẩm cho ' + (line.phrase || 'dòng') });
          pick.appendChild(el('option', { value: '', text: 'Có vài món khớp — chọn một' }));
          line.candidates.forEach((cand, i) => {
            const label = (cand.sku ? cand.sku + ' · ' : '') + (cand.name || '') + (cand.price != null ? ' · ' + vnd(cand.price) : '');
            pick.appendChild(el('option', { value: String(i), text: label }));
          });
          pick.addEventListener('change', () => {
            const cand = line.candidates[Number(pick.value)];
            if (!cand) return;
            applyProduct(line, cand);
            state.quote = null;
            dirty = true;
            paintLines();
          });
          row.appendChild(pick);
        }
        const search = el('input', { type: 'search', placeholder: 'Tìm tên hoặc mã KiotViet', 'aria-label': 'Tìm sản phẩm', autocomplete: 'off' });
        search.value = line.query || '';
        const results = el('div', { class: 'kiot-results' });
        paintSearch(results, line);
        search.addEventListener('input', () => {
          line.query = search.value;
          dirty = true;
          clearTimeout(line._timer);
          const query = search.value;
          if (String(query || '').trim().length < 2) {
            line.searchPhase = 'idle';
            line.hits = [];
            paintSearch(results, line);
            return;
          }
          line.searchPhase = 'loading';
          paintSearch(results, line);
          line._timer = setTimeout(() => fillSearch(query, results, line), 250);
        });
        row.appendChild(search);
        row.appendChild(results);
      }

      const qtyWrap = el('label', { class: 'kiot-qty' });
      qtyWrap.appendChild(document.createTextNode('SL / KL'));
      const qty = el('input', {
        type: 'number',
        min: '0',
        step: '1',
        inputmode: 'decimal',
        'aria-label': 'Số lượng hoặc khối lượng',
      });
      qty.value = window.kiotPicker ? window.kiotPicker.qtyText(line.quantity == null ? 1 : line.quantity) : '1';
      const keepQty = () => {
        const shown = window.kiotPicker ? window.kiotPicker.qtyText(qty.value) : String(qty.value || '1');
        if (qty.value !== shown) qty.value = shown;
        line.quantity = window.kiotPicker ? window.kiotPicker.normalizeQty(shown) : (Number(shown) || 1);
        state.quote = null;
        dirty = true;
        paintTotals();
        const totalEl = row.querySelector('.kiot-line-total');
        if (totalEl) totalEl.textContent = line.price != null && Number.isFinite(line.quantity) ? vnd(line.price * line.quantity) : '—';
        confirmBtn.disabled = true;
      };
      qty.addEventListener('input', keepQty);
      qty.addEventListener('change', keepQty);
      qtyWrap.appendChild(qty);
      row.appendChild(qtyWrap);

      const meta = el('div', { class: 'kiot-meta' });
      meta.appendChild(el('span', { text: line.price != null ? vnd(line.price) : 'Giá —' }));
      meta.appendChild(el('span', {
        class: 'kiot-line-total',
        text: line.price != null && Number.isFinite(Number(line.quantity)) ? vnd(line.price * line.quantity) : '—',
      }));
      const stockCls = line.stock && line.stock.level === 'blocked' ? 'bad' : line.stock && line.stock.level === 'low' ? 'warn' : '';
      meta.appendChild(el('span', { class: 'kiot-stock ' + stockCls, text: line.sku ? stockText(line.stock) : '' }));
      row.appendChild(meta);
      if (line.warning) row.appendChild(el('p', { class: 'kiot-warn', text: line.warning }));
      return row;
    }

    function applyProduct(line, product) {
      line.sku = product.sku || product.code || '';
      line.name = product.name || '';
      line.unit = product.unit || '';
      line.price = product.price != null ? Number(product.price) : null;
      line.status = 'matched';
      line.candidates = [];
      line.stock = product.available != null ? { level: null, available: product.available } : line.stock;
      if (product.stock) line.stock = product.stock;
    }

    function hitText(product) {
      const bits = [];
      if (product.name) bits.push(product.name);
      if (product.code) bits.push(product.code);
      if (product.price != null) bits.push(vnd(product.price));
      if (product.available != null) bits.push('Tồn ' + product.available);
      return bits.join(' · ') || 'Sản phẩm';
    }

    function paintSearch(box, line) {
      box.textContent = '';
      const note = window.kiotPicker ? window.kiotPicker.searchNote(line.searchPhase) : '';
      if (note) box.appendChild(el('p', { class: 'kiot-search-note', text: note }));
      (line.hits || []).slice(0, 8).forEach(product => {
        const btn = el('button', { type: 'button', class: 'kiot-hit', text: hitText(product) });
        btn.addEventListener('click', () => {
          applyProduct(line, product);
          line.hits = [];
          line.searchPhase = 'idle';
          state.quote = null;
          dirty = true;
          paintLines();
        });
        box.appendChild(btn);
      });
    }

    async function fillSearch(q, box, line) {
      const query = String(q || '').trim();
      if (query.length < 2) {
        line.searchPhase = 'idle';
        line.hits = [];
        paintSearch(box, line);
        return;
      }
      if (String(line.query || '').trim() !== query) return;
      try {
        const data = await api('/admin/api/kiotviet/products?q=' + encodeURIComponent(query));
        if (String(line.query || '').trim() !== query) return;
        const products = (data.products || []).slice(0, 8);
        line.hits = products;
        line.searchPhase = products.length ? 'ok' : 'empty';
        paintSearch(box, line);
      } catch (e) {
        if (String(line.query || '').trim() !== query) return;
        line.hits = [];
        line.searchPhase = 'error';
        paintSearch(box, line);
      }
    }

    async function runQuick() {
      showError('');
      quickMsg.hidden = true;
      quickBtn.disabled = true;
      try {
        const data = await api('/admin/api/kiotviet/quick-entry', {
          method: 'POST',
          body: JSON.stringify({ text: quick.value }),
        });
        const rows = data.lines || [];
        state.lines = rows.length ? rows.map(row => ({
          sku: row.sku || '',
          name: row.name || '',
          unit: row.unit || '',
          price: row.price,
          quantity: row.quantity || 1,
          phrase: row.phrase || '',
          status: row.status || 'unmatched',
          warning: row.warning || '',
          stock: row.stock || null,
          candidates: row.candidates || [],
          query: row.status === 'unmatched' ? (row.phrase || '') : '',
        })) : [blankKiotLine()];
        state.quote = null;
        dirty = true;
        const ambiguous = state.lines.filter(line => line.status === 'ambiguous').length;
        const missed = state.lines.filter(line => line.status === 'unmatched').length;
        const notes = [];
        if (ambiguous) notes.push(ambiguous + ' dòng cần chọn trong danh sách');
        if (missed) notes.push(missed + ' dòng chưa khớp');
        if (notes.length) {
          quickMsg.hidden = false;
          quickMsg.textContent = notes.join('. ') + '.';
        }
        paintLines();
      } catch (e) {
        if (e.message !== 'unauthorized') showError(e.message);
      } finally {
        quickBtn.disabled = false;
      }
    }

    async function runQuote(confirm) {
      showError('');
      if (state.submitting) return;
      const lines = payloadLines();
      if (!lines.length) {
        showError('Cần ít nhất một dòng hàng.');
        return;
      }
      if (confirm && lines.some(line => !line.sku)) {
        showError('Còn dòng chưa chọn mã KiotViet.');
        return;
      }
      if (confirm && state.existing && !state.acknowledge) {
        showError('Nháp đã có chứng từ. Chỉ tạo thêm khi bạn tick xác nhận.');
        return;
      }
      state.submitting = true;
      quoteBtn.disabled = true;
      confirmBtn.disabled = true;
      const body = {
        confirm: confirm === true,
        document: state.document,
        customer_name: nameInput.input.value.trim(),
        phone: phoneInput.input.value.trim(),
        address: addrInput.input.value.trim(),
        note: noteInput.input.value.trim(),
        discount: moneyVal(discountInput.input),
        shipping_fee: moneyVal(shipInput.input),
        lines,
        actor_name: actorName(),
        acknowledge_existing: state.acknowledge === true,
      };
      if (confirm && state.quote && state.quote.total != null) body.expected_total = state.quote.total;
      const matched = state.kiotCustomer;
      if (matched && matched.id && phoneKey(matched.phone) === phoneKey(body.phone)) {
        body.kiot_customer_id = matched.id;
        if (matched.code) body.kiot_customer_code = matched.code;
      }
      try {
        const data = await api('/admin/api/drafts/' + d.id + '/kiotviet', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!confirm) {
          state.quote = data;
          (data.lines || []).forEach((row, i) => {
            const line = state.lines[i];
            if (!line) return;
            if (row.price != null) line.price = row.price;
            if (row.sku) line.sku = row.sku;
            if (row.name) line.name = row.name;
            if (row.unit) line.unit = row.unit;
            if (row.stock) line.stock = row.stock;
            if (row.missing) line.status = 'unmatched';
          });
          paintLines();
          if (data.error) showError(data.error);
          return;
        }
        const code = data.code;
        const reply = detailEl.querySelector('#draft-reply');
        if (reply && data.draft && data.draft.draft_reply && d.approval_status !== 'SENT') {
          reply.value = data.draft.draft_reply;
        }
        if (data.draft) {
          const idx = drafts.findIndex(item => item.id === d.id);
          if (idx >= 0) drafts[idx] = data.draft;
        }
        showExisting({ code, total: data.total });
        toast(data.saved === false
          ? (data.error || ('Đã tạo ' + code + ' nhưng chưa ghi vào nháp.'))
          : ('Đã tạo ' + code + ' · ' + vnd(data.total) + '. Tin vẫn chờ duyệt, chưa gửi.'));
        dirty = false;
        detailStamp = '';
        listStamp = '';
        await load();
      } catch (e) {
        if (e.message !== 'unauthorized') showError(e.message);
        state.submitting = false;
        quoteBtn.disabled = false;
        paintSummary();
      }
    }

    const savedNames = Array.isArray(d.channel_names) ? d.channel_names.map(item => ({ ...item })) : [];

    function applyKiotMatch(data, phone) {
      if (data && (data.name || data.code)) {
        state.kiotCustomer = {
          id: data.id || null,
          code: data.code || '',
          name: data.name || '',
          phone: phone,
        };
        if (!state.touched.name && data.name) {
          nameInput.input.value = data.name;
          nameHint.textContent = '';
          nameHint.hidden = true;
        }
      } else {
        state.kiotCustomer = null;
      }
      if (data && Array.isArray(data.channel_names)) {
        d.channel_names = data.channel_names;
        paintDraftNames(d);
      }
    }

    function scheduleKiotLookup() {
      clearTimeout(state.lookupTimer);
      const phone = phoneInput.input.value.trim();
      state.lookupTimer = setTimeout(async () => {
        if (phoneKey(phone).length < 9) {
          state.kiotCustomer = null;
          d.channel_names = savedNames.map(item => ({ ...item }));
          paintDraftNames(d);
          return;
        }
        try {
          const data = await api('/admin/api/kiotviet/customer?phone=' + encodeURIComponent(phone) + '&draft_id=' + encodeURIComponent(d.id));
          if (!panel.isConnected || phoneInput.input.value.trim() !== phone) return;
          applyKiotMatch(data, phone);
        } catch (_) { /* a missed lookup leaves the header as it was */ }
      }, 400);
    }

    paintLines();
    api('/admin/api/drafts/' + d.id + '/kiotviet').then(data => {
      if (!panel.isConnected) return;
      if (!state.touched.name && data.customer_name) {
        nameInput.input.value = data.customer_name;
        nameHint.textContent = data.name_hint || '';
        nameHint.hidden = !data.name_hint;
      }
      if (!state.touched.phone && data.phone) phoneInput.input.value = data.phone;
      if (data.kiot_customer_id || data.kiot_customer_code) {
        state.kiotCustomer = {
          id: data.kiot_customer_id || null,
          code: data.kiot_customer_code || '',
          name: data.customer_name || '',
          phone: data.phone || phoneInput.input.value.trim(),
        };
      }
      if (!state.touched.address && data.address) addrInput.input.value = data.address;
      if (!state.touched.quick && data.quick_text) quick.value = data.quick_text;
      if (!state.touched.ship && data.shipping_fee != null) shipInput.input.value = String(data.shipping_fee);
      if (data.existing) showExisting(data.existing);
    }).catch(() => {});
    return panel;
  }

  function phoneKey(value) {
    let p = String(value || '').replace(/[^\d+]/g, '');
    if (p.startsWith('+84')) p = '0' + p.slice(3);
    else if (p.startsWith('84') && p.length >= 10) p = '0' + p.slice(2);
    if (p && !p.startsWith('0')) p = '0' + p;
    return p;
  }

  function paintDraftNames(d) {
    const id = String(d && d.id || '');
    if (!/^[A-Za-z0-9-]+$/.test(id)) return;
    const fill = (box) => {
      box.textContent = '';
      channelNameNodes(d).forEach(node => box.appendChild(node));
    };
    document.querySelectorAll('[data-draft-id="' + id + '"] .msg-names').forEach(fill);
    if (selectedId === d.id && detailEl) detailEl.querySelectorAll('.msg-names').forEach(fill);
  }

  function blankKiotLine() {
    return {
      sku: '',
      name: '',
      unit: '',
      price: null,
      quantity: 1,
      phrase: '',
      status: 'empty',
      warning: '',
      stock: null,
      candidates: [],
      query: '',
      hits: [],
      searchPhase: 'idle',
    };
  }

  function channelNameNodes(d) {
    const names = Array.isArray(d.channel_names)
      ? d.channel_names.filter(item => item && (item.text || item.name))
      : [];
    if (!names.length) {
      const phone = String(d.customer_phone || '').trim();
      const id = String(d.customer_user_id || '').trim();
      return [el('span', { class: 'msg-name', text: phone || id || d.customer_name || 'Khách chưa có tên' })];
    }
    return names.map(item => {
      const bit = el('span', {
        class: 'msg-channel-name' + (item.source === 'kiot' ? ' msg-kiot-name' : ''),
      });
      if (item.avatar && /^https:\/\//.test(item.avatar)) {
        bit.appendChild(el('img', { class: 'msg-avatar', alt: '', src: item.avatar }));
      }
      bit.appendChild(el('span', { text: item.text || ((item.label || 'Tên') + ': ' + item.name) }));
      return bit;
    });
  }

  function seededKiotName(d) {
    const names = Array.isArray(d.channel_names) ? d.channel_names : [];
    const kiot = names.find(item => item && item.source === 'kiot' && item.name);
    if (kiot) return { name: kiot.name, hint: '' };
    const own = names.find(item => item && item.own && item.name)
      || names.find(item => item && (item.source === 'zalo' || item.source === 'fb') && item.name);
    if (!own) return { name: d.customer_name || '', hint: '' };
    return {
      name: own.name,
      hint: own.source === 'fb' ? 'lấy từ Tên FB' : 'lấy từ Tên Zalo',
    };
  }

  function kiotInput(label, value, id) {
    const input = el('input', { type: 'text', id: id });
    input.value = value || '';
    const wrap = el('div', { class: 'field-block' }, [
      el('label', { for: id, text: label }),
      input,
    ]);
    return { wrap, input };
  }

  function bizTag(d) {
    if (d.biz_line !== 'sale' && d.biz_line !== 'dv') return null;
    return el('span', { class: 'tag tag-line', text: d.biz_line === 'dv' ? 'DV' : 'Sale' });
  }

  function moveBtn(d, line, label) {
    const btn = el('button', { type: 'button', class: 'card-act', text: label });
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      moveLine(d.id, line);
    });
    return btn;
  }

  function statusActions(d) {
    const row = el('div', { class: 'status-actions' });
    const boughtLabel = d.biz_line === 'dv' || d.channel === 'messenger' && d.biz_line === 'dv' ? 'Đã chốt' : (d.biz_line === 'dv' ? 'Đã chốt' : 'Đã mua');
    const dv = d.biz_line === 'dv';
    row.appendChild(folderBtn(d, 'hesitant', 'Do dự'));
    row.appendChild(folderBtn(d, 'declined', 'Từ chối'));
    row.appendChild(folderBtn(d, 'bought', dv ? 'Đã chốt' : boughtLabel));
    row.appendChild(folderBtn(d, 'pending', 'Trả về Chờ xử lý'));
    return row;
  }

  function folderBtn(d, to, label) {
    const btn = el('button', { type: 'button', class: 'card-act', text: label });
    if (d.inbox_status === to) btn.disabled = true;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      moveFolder(d.id, to);
    });
    return btn;
  }

  async function moveFolder(id, to) {
    try {
      await api('/admin/api/drafts/' + id + '/folder', {
        method: 'POST',
        body: JSON.stringify({ inbox_status: to, actor_name: actorName() }),
      });
      toast('Đã chuyển thư mục.');
      const s = cardState.get(id);
      if (s) s.dirty = false;
      listStamp = '';
      detailStamp = '';
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
    }
  }

  function learnNote(res, sent) {
    const off = res && res.learn === false;
    const learned = res && res.learned === true;
    const tail = off || !learned ? 'không học' : 'AI đã học';
    if (sent) return 'Đã gửi · ' + tail;
    return 'Đã duyệt · ' + tail;
  }

  async function approveCard(d) {
    const s = ensureCard(d);
    const text = String(s.reply || '').trim();
    if (!text) {
      toast('Nhập câu trả lời trước khi gửi.');
      return;
    }
    const where = d.channel === 'messenger' ? ' trên Facebook Messenger' : '';
    if (!confirm('Gửi tin này cho khách' + where + '?')) return;
    if (busy) return;
    busy = true;
    try {
      const res = await api('/admin/api/drafts/' + d.id, {
        method: 'PATCH',
        body: JSON.stringify({
          draft_reply: text,
          send: true,
          learn: s.learn !== false,
          actor_name: actorName(),
          approval_status: 'APPROVED',
        }),
      });
      s.dirty = false;
      s.reply = text;
      dirty = cardsDirty();
      const sent = res.send && res.send.sent;
      toast(sent ? learnNote(res, true) : (res.send && res.send.pendingAdapter ? learnNote(res, false) : (res.send ? 'Đã duyệt, chưa gửi được.' : 'Đã lưu.')));
      listStamp = '';
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
    } finally {
      busy = false;
    }
  }

  function lineActions(d, className) {
    const row = el('div', { class: 'msg-actions' + (className ? ' ' + className : '') });
    const current = d.biz_line === 'sale' || d.biz_line === 'dv' ? d.biz_line : '';
    if (!current) {
      row.appendChild(moveBtn(d, 'sale', d.channel === 'zalo' ? 'Gắn Sale' : 'Chuyển qua Sale'));
      row.appendChild(moveBtn(d, 'dv', d.channel === 'zalo' ? 'Gắn DV' : 'Chuyển qua DV'));
    } else if (current === 'dv') {
      row.appendChild(moveBtn(d, 'sale', 'Chuyển qua Sale'));
    } else {
      row.appendChild(moveBtn(d, 'dv', 'Chuyển qua DV'));
    }
    const del = el('button', { type: 'button', class: 'card-act card-del', text: 'Xóa' });
    del.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeDraft(d.id);
    });
    if (me.canDelete) row.appendChild(del);
    return row;
  }

  async function moveLine(id, line) {
    try {
      await api('/admin/api/drafts/' + id + '/biz-line', {
        method: 'POST',
        body: JSON.stringify({ biz_line: line, actor_name: actorName() }),
      });
      toast(line === 'dv' ? 'Đã chuyển qua DV.' : 'Đã chuyển qua Sale.');
      if (!dirty) detailStamp = '';
      listStamp = '';
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
    }
  }

  async function removeDraft(id) {
    if (!confirm('Xoá tin này khỏi hộp thư? Tin trên Facebook và Zalo không bị xoá, và không gửi gì cho khách.')) return;
    try {
      await api('/admin/api/drafts/' + id + '/delete', {
        method: 'POST',
        body: JSON.stringify({ actor_name: actorName() }),
      });
      if (selectedId === id && !dirty) {
        selectedId = null;
        detailStamp = '';
        document.body.classList.remove('show-detail');
      }
      listStamp = '';
      toast('Đã xoá khỏi hộp thư.', {
        label: 'Hoàn tác',
        run: () => restoreDraft(id),
      });
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
    }
  }

  async function restoreDraft(id) {
    try {
      await api('/admin/api/drafts/' + id + '/restore', {
        method: 'POST',
        body: JSON.stringify({ actor_name: actorName() }),
      });
      listStamp = '';
      toast('Đã hoàn tác.');
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
    }
  }

  function showSync(text, bad) {
    if (!syncResultEl) return;
    syncResultEl.textContent = text || '';
    syncResultEl.classList.toggle('bad', !!bad);
  }

  async function refreshNow() {
    if (busy) return;
    if (editingHold()) await load({ apply: true });
    else await load();
  }

  async function syncMissed() {
    if (busy) return;
    const btn = document.getElementById('sync-missed');
    busy = true;
    if (btn) btn.disabled = true;
    showSync('Đang đồng bộ…', false);
    try {
      const data = await api('/admin/api/inbox/sync', { method: 'POST', body: '{}' });
      if (data && data.error) {
        showSync(data.error, true);
        toast(data.error);
      } else {
        const n = data && data.added ? data.added : 0;
        const m = data && data.skipped ? data.skipped : 0;
        let text = 'Đã thêm ' + n + ' tin, bỏ qua ' + m + ' tin đã có';
        if (data && data.zalo && data.zalo.synced === false) {
          text += '. Zalo OA: không kéo hội thoại cũ (chưa có API liệt kê).';
        }
        showSync(text, false);
        toast(text);
      }
      listStamp = '';
      if (editingHold()) await load({ apply: true });
      else await load();
    } catch (e) {
      if (e.message !== 'unauthorized') {
        showSync(e.message, true);
        toast(e.message);
      }
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  const refreshBtn = document.getElementById('refresh-now');
  if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshNow(); });
  const syncBtn = document.getElementById('sync-missed');
  if (syncBtn) syncBtn.addEventListener('click', () => { syncMissed(); });
  if (newEl) {
    newEl.addEventListener('click', () => {
      load({ apply: true });
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!loadedOnce || busy) return;
    if (document.visibilityState === 'visible') load({ background: true });
  });

  function ictStamp(iso) {
    if (!iso) return 'chưa có';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'chưa có';
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  }

  async function paintHealth() {
    const el = document.getElementById('health-banner');
    if (!el) return;
    try {
      const res = await fetch('/admin/api/health', {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const alerts = data.alerts || [];
      const rows = data.integrations || [];
      el.hidden = false;
      el.classList.toggle('bad', alerts.length > 0);
      el.textContent = '';
      alerts.forEach(a => el.appendChild(elFn('p', { class: 'health-alert', text: a.text })));
      const line = rows.map(r => r.label + ' ' + ictStamp(r.lastSuccessAt)).join(' · ');
      el.appendChild(elFn('p', { class: 'health-times', text: line || 'Chưa có mốc thành công.' }));
    } catch (_) { /* a health miss must not touch the inbox */ }
  }

  function elFn(tag, attrs, children) { return el(tag, attrs, children); }

  function startPolling() {
    const pollMs = Number(new URLSearchParams(location.search).get('pollms'));
    const interval = Number.isFinite(pollMs) && pollMs >= 200 && pollMs <= 60000 ? pollMs : 20000;
    setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) load({ background: true });
    }, interval);
    paintHealth();
    setInterval(() => { if (document.visibilityState === 'visible') paintHealth(); }, 60000);
  }

  async function loadMe() {
    try {
      const res = await fetch('/admin/api/session', { credentials: 'same-origin' });
      if (!res.ok) return;
      me = await res.json();
      if (me.role === 'sale') {
        const tab = document.querySelector('[data-nhom="fb-dv"]');
        if (tab) tab.hidden = true;
      }
      if (me.role === 'dv') {
        const tab = document.querySelector('[data-nhom="fb-sale"]');
        if (tab) tab.hidden = true;
      }
      const users = document.getElementById('users-link');
      if (users) users.hidden = !me.canManageUsers;
    } catch (_) { /* server still enforces the role */ }
  }

  syncTabs();
  loadChannels().then(loadMe).then(load).then(startPolling).catch(e => {
    if (e.message !== 'unauthorized') {
      listEl.textContent = '';
      listEl.appendChild(el('p', { class: 'empty', text: e.message }));
    }
  });
})();
