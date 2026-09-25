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
  const pendingDeletes = new Map();
  const settledDeletes = new Set();
  let me = { role: 'manager', canSend: true, canDelete: true, canKiot: true, canManageUsers: true };
  let listScrollY = 0;
  let detailPushed = false;
  let advanceTo = null;
  let scrollDetailToTop = false;
  const REPLY_KEY = 'dmf_reply_drafts';

  function isDesktop() {
    return window.matchMedia('(min-width: 1024px)').matches;
  }

  function savedReplyMap() {
    try {
      const raw = sessionStorage.getItem(REPLY_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
      return {};
    }
  }

  function persistReplies() {
    const obj = {};
    cardState.forEach((s, id) => {
      if (!s || !s.dirty) return;
      obj[id] = {
        reply: s.reply || '',
        learn: s.learn !== false,
        learnTouched: !!s.learnTouched,
      };
    });
    try { sessionStorage.setItem(REPLY_KEY, JSON.stringify(obj)); } catch (_) {}
  }

  function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function richFragment(text) {
    const safe = escHtml(text).replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>');
    const wrap = document.createElement('span');
    wrap.innerHTML = safe;
    return wrap;
  }

  function opaqueId(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^fb_\d{6,}$/.test(t)) return true;
    if (/^\d{8,}$/.test(t)) return true;
    return false;
  }

  function paintLoading() {
    listEl.textContent = '';
    listEl.setAttribute('aria-busy', 'true');
    const sk = el('div', { class: 'list-skeleton', role: 'status' });
    sk.appendChild(el('p', { class: 'sr-only', text: 'Đang tải…' }));
    for (let i = 0; i < 4; i += 1) sk.appendChild(el('div', { class: 'skel-row' }));
    listEl.appendChild(sk);
  }

  function showListError(message) {
    listEl.textContent = '';
    listEl.removeAttribute('aria-busy');
    const box = el('div', { class: 'empty-list list-error' });
    box.appendChild(el('strong', { text: 'Không tải được hộp thư.' }));
    box.appendChild(el('p', { text: message || 'Thử lại sau.' }));
    const retry = el('button', { type: 'button', class: 'btn btn-primary', text: 'Thử lại' });
    retry.addEventListener('click', () => {
      paintLoading();
      load();
    });
    box.appendChild(retry);
    listEl.appendChild(box);
  }

  function neighborId(id) {
    const idx = drafts.findIndex(d => d.id === id);
    if (idx < 0) return null;
    if (drafts[idx + 1]) return drafts[idx + 1].id;
    if (idx > 0) return drafts[idx - 1].id;
    return null;
  }

  function queueAdvance(fromId) {
    const inDetail = document.body.classList.contains('show-detail');
    if (!inDetail && !isDesktop()) return;
    advanceTo = neighborId(fromId);
    scrollDetailToTop = true;
  }

  function syncBarHeight() {
    const bar = document.getElementById('app-bar');
    if (bar) document.body.style.setProperty('--app-bar-h', bar.offsetHeight + 'px');
    let chrome = 0;
    if (!isDesktop() && document.body.classList.contains('show-detail')) {
      const sticky = document.querySelector('#detail .sticky-actions');
      chrome = sticky ? sticky.offsetHeight : 0;
    }
    document.body.style.setProperty('--bottom-chrome', chrome + 'px');
  }

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

  function inboxQuery() {
    const q = new URLSearchParams();
    q.set('ops', ops);
    q.set('kenh', salesChannel);
    if (messageType) q.set('type', messageType);
    if (triage) q.set('triage', triage);
    if (nhom) q.set('nhom', nhom);
    if (nhom === 'zalo' && zline) q.set('zline', zline);
    if (folder) q.set('hop', folder);
    return q;
  }

  function inboxUrl() {
    const hash = selectedId ? '#' + selectedId : '';
    return location.pathname + '?' + inboxQuery().toString() + hash;
  }

  function rememberUrl() {
    history.replaceState({ inbox: true, detail: selectedId || '', scrollY: listScrollY }, '', inboxUrl());
  }

  function guardSwitch(next) {
    if (dirty && !confirm('Bạn đang sửa dở. Đổi mục sẽ bỏ phần chưa lưu?')) return false;
    dirty = false;
    selectedId = null;
    detailStamp = '';
    detailPushed = false;
    document.body.classList.remove('show-detail');
    next();
    rememberUrl();
    syncTabs();
    paintLoading();
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
      let next = btn.dataset.triage || '';
      if (btn.id === 'hot-chip' && triage === 'hot') next = '';
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

  const hotListBtn = document.getElementById('hot-list');
  if (hotListBtn) {
    hotListBtn.addEventListener('click', () => {
      guardSwitch(() => { triage = triage === 'hot' ? '' : 'hot'; });
    });
  }

  const filterPanel = document.getElementById('filter-panel');
  const filterToggle = document.getElementById('filter-toggle');
  if (filterToggle && filterPanel) {
    filterToggle.addEventListener('click', () => {
      const open = filterPanel.hidden;
      filterPanel.hidden = !open;
      filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (filterPanel.hidden) return;
      if (e.target.closest('#filter-panel') || e.target.closest('#filter-toggle')) return;
      filterPanel.hidden = true;
      filterToggle.setAttribute('aria-expanded', 'false');
    });
  }

  function clearFilter(key) {
    guardSwitch(() => {
      if (key === 'triage' || key === 'all') triage = '';
      if (key === 'type' || key === 'all') messageType = '';
      if (key === 'zline' || key === 'all') zline = '';
      if (key === 'ops' || key === 'all') ops = 'pending';
      if (key === 'kenh' || key === 'all') {
        salesChannel = 'farm';
        renderChannels();
      }
      if (key === 'search' || key === 'all') {
        const input = document.getElementById('inbox-search');
        if (input) input.value = '';
        document.body.classList.remove('search-open');
        const toggle = document.getElementById('search-toggle');
        if (toggle) {
          toggle.classList.remove('is-active');
          toggle.setAttribute('aria-expanded', 'false');
        }
      }
    });
  }

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
    const hotChip = document.getElementById('hot-chip');
    if (hotChip) hotChip.hidden = false;
    const hotList = document.getElementById('hot-list');
    if (hotList) {
      const n = triageCounts.hot || 0;
      hotList.hidden = n < 1;
      const count = hotList.querySelector('.count');
      if (count) count.textContent = String(n);
      hotList.setAttribute('aria-label', 'Nóng ' + n);
      hotList.classList.toggle('active', triage === 'hot');
      hotList.setAttribute('aria-pressed', triage === 'hot' ? 'true' : 'false');
    }
    const typeRow = document.getElementById('types');
    if (typeRow) typeRow.hidden = nhom !== 'zalo';
    const zaloLine = document.getElementById('zalo-line');
    if (zaloLine) zaloLine.hidden = nhom !== 'zalo';
    paintActiveFilters();
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

  function paintActiveFilters() {
    const box = document.getElementById('active-filters');
    if (!box) return;
    box.textContent = '';
    const items = [];
    if (TRIAGE_LABEL[triage]) items.push({ key: 'triage', label: TRIAGE_LABEL[triage] });
    if (TYPE_LABEL[messageType]) items.push({ key: 'type', label: TYPE_LABEL[messageType] });
    if (nhom === 'zalo' && (zline === 'sale' || zline === 'dv')) {
      items.push({ key: 'zline', label: zline === 'dv' ? 'DV' : 'Sale' });
    }
    if (ops && ops !== 'pending' && OPS_LABEL[ops]) items.push({ key: 'ops', label: OPS_LABEL[ops] });
    if (salesChannel && salesChannel !== 'farm') {
      const ch = channels.find(c => c.id === salesChannel);
      items.push({ key: 'kenh', label: ch ? ch.name : salesChannel });
    }
    const searchEl = document.getElementById('inbox-search');
    const searchQuery = searchEl ? searchEl.value.trim() : '';
    if (searchQuery) items.push({ key: 'search', label: 'Tìm: ' + searchQuery });
    const searchToggle = document.getElementById('search-toggle');
    if (searchToggle) searchToggle.classList.toggle('is-active', !!searchQuery);
    if (filterToggle) filterToggle.classList.toggle('has-filters', items.length > 0);
    if (!items.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    items.forEach(item => {
      const btn = el('button', { type: 'button', class: 'active-chip', text: item.label + ' ×' });
      btn.addEventListener('click', () => clearFilter(item.key));
      box.appendChild(btn);
    });
    const clear = el('button', { type: 'button', class: 'clear-filters', text: 'Xóa lọc' });
    clear.addEventListener('click', () => clearFilter('all'));
    box.appendChild(clear);
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
      persistReplies();
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
    channels.filter(c => !window.inboxOrder || window.inboxOrder.showChannelChip(c)).forEach(c => {
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
    if (!loadedOnce && mode === 'replace') paintLoading();
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
      const rawIncoming = window.inboxOrder ? window.inboxOrder.sort(data.drafts || []) : (data.drafts || []);
      const hiddenIds = [...pendingDeletes.keys(), ...settledDeletes];
      const incoming = (window.undoDelete ? window.undoDelete.omitPending(rawIncoming, hiddenIds) : rawIncoming)
        .filter(row => row && !hiddenIds.includes(row.id));
      counts = data.counts || {};
      triageCounts = data.triageCounts || triageCounts;
      groupCounts = data.pendingGroupCounts || data.groupCounts || groupCounts;
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
      if (storageEl) {
        // Postgres never shows this. Memory mode (local, or a production
        // process with no DATABASE_URL) is a muted line in the overflow menu.
        storageEl.hidden = !(data.storage && data.storage !== 'postgres');
      }
      const keepY = window.scrollY;
      const keepList = listEl.scrollTop;
      listStamp = JSON.stringify(drafts);
      if (advanceTo) {
        const nextId = advanceTo;
        advanceTo = null;
        if (drafts.some(d => d.id === nextId)) {
          selectedId = nextId;
          dirty = false;
          detailStamp = '';
          scrollDetailToTop = true;
        } else {
          selectedId = null;
          detailStamp = '';
        }
      }
      renderList();
      listEl.removeAttribute('aria-busy');
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
      if (scrollDetailToTop && !isDesktop()) window.scrollTo(0, 0);
      else if (anchor && listEl.querySelector('.msg-card[data-draft-id="' + (window.CSS && CSS.escape ? CSS.escape(anchor.id) : anchor.id) + '"]')) {
        restoreAnchor(anchor);
      } else if (!scrollDetailToTop) {
        window.scrollTo(window.scrollX, keepY);
      }
      scrollDetailToTop = false;
      rememberUrl();
    } catch (e) {
      if (e.message === 'unauthorized') return;
      if (seq !== loadSeq) return;
      if (mode !== 'replace' || loadedOnce) {
        toast(e.message);
        return;
      }
      showListError(e.message);
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
    const hop = FOLDER_LABEL[folder];
    if (folder && folder !== 'pending' && hop) {
      return {
        title: 'Không có tin trong ' + hop + '.',
        body: 'Thư mục ' + hop + ' của ' + name + ' đang trống. Tin mới nằm ở Chờ xử lý.',
      };
    }
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
      const saved = savedReplyMap()[d.id];
      if (saved && typeof saved.reply === 'string' && saved.reply !== (d.draft_reply || '')) {
        s.reply = saved.reply;
        s.learn = saved.learn !== false;
        s.learnTouched = !!saved.learnTouched;
        s.dirty = true;
      }
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
    const visible = drafts.filter(matchesSearch);
    visible.forEach(d => listEl.appendChild(buildCard(d)));
    if (!visible.length) {
      listEl.appendChild(el('div', { class: 'empty-list search-empty' }, [
        el('strong', { text: 'Không thấy tin khớp.' }),
        el('p', { text: 'Thử từ khác trong tên khách hoặc nội dung tin.' }),
      ]));
    }
    if (!selectedId) showPlaceholder();
    requestAnimationFrame(fitClamps);
  }

  function matchesSearch(d) {
    const input = document.getElementById('inbox-search');
    const q = input ? input.value.trim().toLowerCase() : '';
    if (!q) return true;
    const names = (Array.isArray(d.channel_names) ? d.channel_names : [])
      .map(item => (item && (item.text || item.name)) || '')
      .join(' ');
    const blob = [d.customer_name, d.customer_phone, snippet(d), names].join(' ').toLowerCase();
    return blob.indexOf(q) !== -1;
  }

  function fitClamps() {
    listEl.querySelectorAll('.msg-customer.is-clamped').forEach(node => {
      const card = node.closest('.msg-card');
      const more = card && card.querySelector('.more-toggle');
      if (!more) return;
      more.hidden = node.scrollHeight <= node.clientHeight + 2;
    });
  }

  const CUST_LABEL = { zalo: 'Zalo', messenger: 'Facebook', kiot: 'KiotViet' };

  function vnd(n) {
    return Number(n || 0).toLocaleString('vi-VN') + 'đ';
  }

  function customerPanel(d) {
    const fold = el('details', { class: 'cust-fold' });
    fold.appendChild(el('summary', { text: 'Hồ sơ khách' }));
    const box = el('div', { class: 'cust-panel' });
    box.addEventListener('click', (ev) => ev.stopPropagation());
    box.appendChild(renderCustomer(d, {
      profile: d.customer_profile || null,
      history: d.customer_history || { available: false, reason: 'no_phone' },
    }, () => reloadCustomer(d, box)));
    fold.appendChild(box);
    reloadCustomer(d, box);
    return fold;
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
    const form = el('div', { class: 'cust-link' });
    const input = el('input', {
      type: 'tel',
      inputmode: 'tel',
      name: 'link_phone',
      placeholder: 'Gắn số điện thoại',
      maxlength: '20',
      autocomplete: 'tel',
      'aria-label': 'Số điện thoại để gắn khách',
      value: phone,
    });
    input.value = phone;
    input.addEventListener('click', (ev) => ev.stopPropagation());
    const go = el('button', { type: 'button', class: 'btn btn-sm', text: 'Gắn' });
    const linkPhone = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      api('/admin/api/customers/link', {
        method: 'POST',
        body: JSON.stringify({ draft_id: d.id, phone: input.value, name: d.customer_name || '' }),
      }).then(reload).catch(err => { statusNote(wrap, err.message); });
    };
    go.addEventListener('click', linkPhone);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') linkPhone(ev);
    });
    form.appendChild(input);
    form.appendChild(go);
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
      btn.appendChild(top);
      const customer = el('div', { class: 'msg-customer is-clamped' });
      customer.appendChild(richFragment(snippet(d) || '—'));
      btn.appendChild(customer);
      const foot = el('div', { class: 'msg-foot' });
      const received = receivedStamp(d);
      foot.appendChild(el('span', { class: 'msg-time', text: received.text, title: received.title }));
      foot.appendChild(tags);
      const sentStamp = sentStampOf(d);
      const sent = el('span', { class: 'msg-sent', text: sentStamp });
      if (!sentStamp) sent.hidden = true;
      foot.appendChild(sent);
      btn.appendChild(foot);
      btn.addEventListener('click', () => openDraft(d.id));
      const card = el('div', {
        class: 'msg-card' + (d.id === selectedId ? ' selected' : ''),
        'data-draft-id': d.id,
      });
      if (window.inboxOrder) card.dataset.sortKey = window.inboxOrder.stamp(d);
      card.appendChild(btn);

      const openReply = d.approval_status !== 'SENT' && d.approval_status !== 'REJECTED' && !d.deleted_at;
      const replyId = 'card-reply-' + d.id;
      const reply = el('textarea', {
        id: replyId,
        class: 'card-reply',
        rows: '2',
        tabindex: '-1',
        'aria-hidden': 'true',
      });
      reply.value = s.reply || '';
      if (!openReply) reply.disabled = true;
      reply.addEventListener('input', () => {
        s.reply = reply.value;
        s.dirty = true;
        dirty = true;
        persistReplies();
      });
      const replyError = el('p', { class: 'reply-error', hidden: 'hidden' });
      card.appendChild(reply);
      card.appendChild(replyError);

      const actions = el('div', { class: 'card-actions' });
      if (openReply && me.canSend) {
        actions.appendChild(el('button', {
          type: 'button',
          class: 'btn btn-primary',
          text: 'Duyệt & Gửi',
          tabindex: '-1',
          'aria-hidden': 'true',
        }));
      }
      card.appendChild(actions);
      if (!d.deleted_at) card.appendChild(deleteButtons(d));
      return card;
  }

  function receivedStamp(d) {
    const api = window.cardTime;
    const label = api ? api.receivedLabel(d) : null;
    if (label && label.text) return { text: label.text, title: label.title || '' };
    return { text: when(d.created_at), title: '' };
  }

  function sentStampOf(d) {
    const api = window.cardTime;
    const label = api ? api.sentLabel(d) : null;
    if (label && label.text) return label.who ? (label.text + ' · ' + label.who) : label.text;
    return d.sent_at ? ('Đã gửi ' + when(d.sent_at)) : '';
  }

  function learnToggle(s) {
    const learn = el('label', { class: 'learn-toggle' });
    const box = el('input', { type: 'checkbox', class: 'learn-check' });
    box.checked = s.learnTouched ? !!s.learn : true;
    box.addEventListener('change', () => {
      s.learn = box.checked;
      s.learnTouched = true;
      persistReplies();
    });
    learn.appendChild(box);
    learn.appendChild(el('span', { class: 'switch', 'aria-hidden': 'true' }));
    learn.appendChild(el('span', { text: 'Cho AI học từ câu trả lời này' }));
    return learn;
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

  function moreMenu(d, locked) {
    const wrap = el('div', { class: 'more-menu' });
    const toggle = el('button', {
      type: 'button',
      class: 'icon-btn more-btn',
      'aria-label': 'Thao tác khác',
      'aria-expanded': 'false',
      'aria-haspopup': 'menu',
    });
    toggle.textContent = '⋯';
    const panel = el('div', { class: 'more-panel', role: 'menu', hidden: 'hidden' });
    function addItem(node) {
      if (!node || node.disabled) return;
      node.setAttribute('role', 'menuitem');
      panel.appendChild(node);
    }
    if (!locked) addItem(actionButton('Lưu', 'ghost', () => save()));
    if (!d.deleted_at) {
      lineActions(d, 'detail-actions').querySelectorAll('button').forEach(addItem);
      statusActions(d).querySelectorAll('button').forEach(addItem);
    }
    if (!locked && d.approval_status !== 'REJECTED') {
      addItem(actionButton('Từ chối bản nháp', 'ghost', () => reject()));
    }
    if (!locked && d.approval_status !== 'PENDING_REVIEW') {
      addItem(actionButton('Đưa về chờ xử lý', 'ghost', () => reopen()));
    }
    toggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    return wrap;
  }

  function renderDetail() {
    const d = currentDraft();
    detailEl.textContent = '';
    if (!d) return;
    const locked = d.approval_status === 'SENT';
    const refund = isRefund(d);
    const addrOn = showAddress(d);
    const f = formOf(d);

    const form = el('form', { class: 'draft-form' });
    form.addEventListener('submit', e => e.preventDefault());

    const body = el('div', { class: 'detail-body' });
    const code = d.customer_code || f.kiot_ref || '';
    const nameRow = el('div', { class: 'name-row' });
    const nameBox = el('div', { class: 'msg-names' });
    const nameNodes = channelNameNodes(d, { when: receivedStamp(d).text });
    nameNodes.forEach(node => nameBox.appendChild(node));
    nameRow.appendChild(nameBox);
    const kiotShown = nameNodes.some(node => node.querySelector && node.querySelector('.id-code'));
    if (code && !kiotShown) {
      nameRow.appendChild(el('span', { class: 'cust-code', title: 'Mã khách hàng', text: code }));
    }
    if (!nameNodes.some(node => node.querySelector && node.querySelector('.id-when'))) {
      nameRow.appendChild(el('span', { class: 'msg-time', text: when(d.created_at) }));
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
    const split = el('div', { class: 'detail-split' });
    const main = el('div', { class: 'detail-main' });
    const side = el('div', { class: 'detail-side' });
    const s = ensureCard(d);
    body.appendChild(meta);
    side.appendChild(customerPanel(d));
    const want = el('div', { class: 'want-box' });
    want.appendChild(el('span', { text: 'Khách đang muốn' }));
    const wantText = el('div', { class: 'msg-customer' });
    wantText.appendChild(richFragment(snippet(d) || '—'));
    want.appendChild(wantText);
    main.appendChild(want);
    if (!d.deleted_at || !locked) {
      const quick = el('div', { class: 'detail-quick' });
      if (!d.deleted_at) {
        quick.appendChild(lineActions(d, 'detail-actions'));
        quick.appendChild(statusActions(d));
      }
      const draftActs = [];
      if (!locked) draftActs.push(actionButton('Lưu', 'ghost', () => save()));
      if (!locked && d.approval_status !== 'REJECTED') {
        draftActs.push(actionButton('Từ chối bản nháp', 'ghost', () => reject()));
      }
      if (!locked && d.approval_status !== 'PENDING_REVIEW') {
        draftActs.push(actionButton('Đưa về chờ xử lý', 'ghost', () => reopen()));
      }
      if (draftActs.length && quick.childNodes.length) quick.appendChild(el('span', { class: 'quick-sep', 'aria-hidden': 'true' }));
      draftActs.forEach(btn => quick.appendChild(btn));
      if (quick.childNodes.length) main.appendChild(quick);
    }

    if (needsHumanTicket(d) && !refund) {
      main.appendChild(el('p', {
        class: 'banner warn',
        text: 'Cần người xem trước khi gửi. Bản nháp này chưa được gửi.',
      }));
    }
    if (d.send_error) {
      main.appendChild(el('p', {
        class: 'banner ' + (d.approval_status === 'SENT' ? 'warn' : 'bad'),
        text: d.send_error,
      }));
    }
    if (d.pii_note) main.appendChild(el('p', { class: 'hint', text: d.pii_note }));

    main.appendChild(el('div', { class: 'draft-label' }, [
      el('label', { for: 'draft-reply', text: 'Bản nháp trả lời' }),
    ]));
    const reply = el('textarea', { id: 'draft-reply', name: 'draft_reply', rows: '4' });
    reply.value = s.dirty ? (s.reply || '') : (d.draft_reply || '');
    if (locked) reply.disabled = true;
    reply.addEventListener('input', () => {
      dirty = true;
      s.reply = reply.value;
      s.dirty = true;
      persistReplies();
    });
    autoGrow(reply, 4);
    main.appendChild(el('div', { class: 'field-block' }, [reply]));
    main.appendChild(el('p', { id: 'reply-error', class: 'reply-error', hidden: 'hidden' }));
    if (!locked) main.appendChild(learnToggle(s));

    const phoneField = blockField('customer_phone', 'SĐT lưu vào tin', d.customer_phone, {
      disabled: locked, placeholder: 'Nếu có', type: 'tel', inputmode: 'tel', autocomplete: 'tel',
    });
    const invoiceField = blockField('invoice_code', 'Mã hoá đơn', d.invoice_code, { disabled: locked, placeholder: 'Ví dụ: HD011637' });
    let fold = null;
    if (me.canKiot) {
      fold = el('details', { class: 'kiot-fold' });
      if (s.kiotOpen || wantsOrder(d)) fold.open = true;
      const kiotExisting = kiotMark(d);
      const summary = el('summary', { text: 'Tạo đơn KiotViet' });
      if (kiotExisting) summary.textContent = 'KiotViet · ' + kiotExisting.code;
      fold.appendChild(summary);
      fold.appendChild(phoneField);
      fold.appendChild(invoiceField);
      fold.addEventListener('toggle', () => {
        s.kiotOpen = fold.open;
        if (fold.open && !fold.querySelector('.kiot-panel')) fold.appendChild(kiotPanel(d));
      });
      side.appendChild(fold);
    } else {
      const grid = el('div', { class: 'grid2' });
      grid.appendChild(phoneField);
      grid.appendChild(invoiceField);
      side.appendChild(grid);
    }
    if (refund) side.appendChild(refundPanel(d, f, locked));
    if (addrOn) side.appendChild(addressPanel(f, locked));

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
    side.appendChild(extra);
    split.appendChild(main);
    split.appendChild(side);
    body.appendChild(split);
    form.appendChild(body);

    const actions = el('div', { class: 'sticky-actions' });
    actions.appendChild(moreMenu(d, locked));
    if (!d.deleted_at) actions.appendChild(deleteButtons(d));
    if (!locked && me.canSend) {
      const sendBtn = actionButton('Duyệt & Gửi', refund ? 'send refund-mode' : 'send', () => send());
      sendBtn.id = 'btn-approve';
      actions.appendChild(sendBtn);
    }
    actions.appendChild(el('span', {
      class: 'sticky-note',
      text: refund
        ? 'Tin chỉ gửi khi bấm Duyệt & Gửi. Không tự hoàn.'
        : 'Tin chỉ gửi khi bấm Duyệt & Gửi.',
    }));
    form.appendChild(actions);
    detailEl.appendChild(form);
    if (fold && fold.open && !fold.querySelector('.kiot-panel')) fold.appendChild(kiotPanel(d));
    document.body.classList.add('show-detail');
    if (scrollDetailToTop) {
      scrollDetailToTop = false;
      if (isDesktop()) detailEl.scrollTop = 0;
      else window.scrollTo(0, 0);
    }
    syncBarHeight();
    requestAnimationFrame(syncBarHeight);
  }

  function blockField(name, label, value, opts) {
    opts = opts || {};
    const id = 'field-' + name;
    const attrs = { name, id, type: opts.type || 'text', placeholder: opts.placeholder || '' };
    if (opts.inputmode) attrs.inputmode = opts.inputmode;
    if (opts.autocomplete) attrs.autocomplete = opts.autocomplete;
    const input = el('input', attrs);
    input.value = value || '';
    if (opts.disabled) input.disabled = true;
    input.addEventListener('input', () => { dirty = true; });
    return el('div', { class: 'field-block' }, [
      el('label', { for: id, text: label }),
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
      disabled: locked, placeholder: 'Ví dụ: 189.000đ', inputmode: 'decimal',
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
    const fromId = selectedId;
    busy = true;
    const approve = document.getElementById('btn-approve');
    if (approve && body && body.send) approve.textContent = 'Đang gửi…';
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
      const card = cardState.get(fromId);
      if (card) card.dirty = false;
      persistReplies();
      if (body && body.send) queueAdvance(fromId);
      rememberUrl();
      await load();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
      detailEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (approve && body && body.send) approve.textContent = 'Duyệt & Gửi';
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
    const policy = window.sendOnce;
    const data = readForm();
    const card = ensureCard({ id: selectedId });
    const plan = policy
      ? policy.prepare({ reply: data.draft_reply, learn: card.learn })
      : { send: !!String(data.draft_reply || '').trim(), inline: 'Nhập câu trả lời trước khi gửi.' };
    const err = document.getElementById('reply-error');
    if (!plan.send) {
      if (err) {
        err.hidden = false;
        err.textContent = plan.inline;
      }
      return;
    }
    if (err) err.hidden = true;
    if (policy && !policy.gate.tryBegin(selectedId)) return;
    const id = selectedId;
    const btn = document.getElementById('btn-approve');
    if (btn) btn.disabled = true;
    return Promise.resolve(patch(payload({ approval_status: 'APPROVED', send: true }), 'Đã gửi.'))
      .finally(() => { if (policy) policy.gate.end(id); });
  }

  function vnd(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '—';
    return Math.round(x).toLocaleString('vi-VN') + 'đ';
  }

  function kiotMark(d) {
    if (!d) return null;
    const f = formOf(d);
    const code = String(f.kiot_code || d.invoice_code || '').trim();
    if (!/^(HD|DH)/i.test(code)) return null;
    const kind = f.kiot_kind || (/^DH/i.test(code) ? 'order' : 'invoice');
    const kiot = (Array.isArray(d.channel_names) ? d.channel_names : []).find(item => item && item.source === 'kiot');
    return {
      code,
      total: f.kiot_total,
      kind,
      image: d.qr_image_url || '',
      customerCode: d.customer_code || (kiot && kiot.code) || '',
      customerName: (kiot && kiot.name) || d.customer_name || 'Khách',
    };
  }

  function openDraft(id, opts) {
    opts = opts || {};
    if (!opts.fromPop && dirty && selectedId !== id && !confirm('Bạn đang sửa dở. Chuyển tin khác sẽ bỏ phần chưa lưu?')) return;
    dirty = false;
    const opening = !document.body.classList.contains('show-detail');
    if (opening && !opts.fromPop) listScrollY = window.scrollY;
    selectedId = id;
    const row = drafts.find(item => item.id === id);
    detailStamp = row ? JSON.stringify(row) : '';
    if (opts.fromPop) {
      history.replaceState({ inbox: true, detail: id, scrollY: listScrollY }, '', inboxUrl());
    } else if (opening) {
      history.pushState({ inbox: true, detail: id, scrollY: listScrollY }, '', inboxUrl());
      detailPushed = true;
    } else {
      history.replaceState({ inbox: true, detail: id, scrollY: listScrollY }, '', inboxUrl());
    }
    document.body.classList.add('show-detail');
    if (opening) scrollDetailToTop = true;
    renderList();
    renderDetail();
    if (opts.focusKiot) {
      const fold = detailEl.querySelector('details.kiot-fold');
      if (fold) fold.open = true;
      const panel = detailEl.querySelector('.kiot-panel');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeDetail(fromPop) {
    const y = listScrollY;
    selectedId = null;
    detailStamp = '';
    dirty = false;
    document.body.classList.remove('show-detail');
    renderList();
    if (!fromPop && detailPushed) {
      detailPushed = false;
      syncBarHeight();
      history.back();
      return;
    }
    detailPushed = false;
    rememberUrl();
    if (!isDesktop()) window.scrollTo(0, y);
    syncBarHeight();
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
    autoGrow(quick, 2);
    const quickBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Điền vào đơn' });
    quickBtn.addEventListener('click', () => runQuick());
    panel.appendChild(quick);
    const quickMsg = el('p', { class: 'kiot-msg', hidden: 'hidden' });
    panel.appendChild(quickMsg);

    const exist = el('p', { class: 'banner warn', hidden: 'hidden' });
    const ackLabel = el('label', { class: 'kiot-ack', hidden: 'hidden' });
    const ack = el('input', { type: 'checkbox' });
    ack.addEventListener('change', () => { state.acknowledge = ack.checked; });
    ackLabel.appendChild(ack);
    ackLabel.appendChild(el('span', { class: 'switch', 'aria-hidden': 'true' }));
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
    if (state.existing) panel.appendChild(createdCard(state.existing));

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
    panel.appendChild(el('div', { class: 'kiot-doc-head' }, [quickBtn, docRow]));

    const grid = el('div', { class: 'kiot-grid' });
    const seeded = seededKiotName(d);
    const nameInput = kiotInput('Tên khách', seeded.name, 'kiot-name-' + pid);
    const nameHint = el('span', { class: 'kiot-name-hint', text: hintSuffix(seeded.hint) });
    nameHint.hidden = !seeded.hint;
    const nameLabel = nameInput.wrap.querySelector('label');
    if (nameLabel) nameLabel.appendChild(nameHint);
    const phoneInput = kiotInput('SĐT tra KiotViet', d.customer_phone || '', 'kiot-phone-' + pid, { type: 'tel', inputmode: 'tel' });
    const invoiceInput = adoptDraftField('invoice_code');
    const addrInput = kiotInput('Địa chỉ giao', addressText(d), 'kiot-address-' + pid);
    addrInput.wrap.classList.add('field-wide');
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
    if (invoiceInput) grid.appendChild(invoiceInput.wrap);
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
    const discountInput = kiotInput('Giảm giá (đ)', '0', 'kiot-discount-' + pid, { inputmode: 'decimal' });
    const shipInput = kiotInput('Phí ship (đ)', '0', 'kiot-ship-' + pid, { inputmode: 'decimal' });
    const noteInput = kiotInput('Ghi chú', '', 'kiot-note-' + pid);
    discountInput.input.addEventListener('input', () => { state.quote = null; paintTotals(); });
    shipInput.input.addEventListener('input', () => { state.touched.ship = true; state.quote = null; paintTotals(); });
    noteInput.input.addEventListener('input', () => { dirty = true; });
    noteInput.wrap.classList.add('field-wide');
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

    function createdCard(mark) {
      const box = el('div', { class: 'kiot-created' });
      const invoice = mark.kind !== 'order';
      const row = el('div', { class: 'id-row' });
      row.appendChild(el('span', { class: 'id-name', text: mark.customerName || 'Khách' }));
      if (mark.customerCode) row.appendChild(el('span', { class: 'id-code', title: 'Mã KH', text: mark.customerCode }));
      row.appendChild(el('span', { class: 'id-code', title: 'Mã HĐ', text: mark.code }));
      box.appendChild(row);
      const bits = [];
      if (mark.total != null && mark.total !== '') bits.push('Tổng ' + vnd(mark.total));
      bits.push(invoice ? 'Hoá đơn đã tạo' : 'Đơn đặt hàng đã tạo');
      box.appendChild(el('p', { class: 'kiot-created-note', text: bits.join(' · ') }));
      if (invoice && mark.image) {
        box.appendChild(el('img', { class: 'kiot-invoice-img', src: mark.image, alt: 'Hoá đơn ' + mark.code }));
        box.appendChild(el('p', {
          class: 'kiot-created-note',
          text: 'Ảnh và nội dung CK đang chờ. Bấm Duyệt & Gửi ở thanh dưới để gửi khách.',
        }));
      }
      if (!invoice) {
        const issue = el('button', { type: 'button', class: 'btn btn-primary', text: 'Xuất hóa đơn' });
        issue.addEventListener('click', () => issueInvoice(issue));
        box.appendChild(issue);
        box.appendChild(el('p', {
          class: 'kiot-created-note',
          text: 'Xuất hoá đơn để có mã QR. Chưa gửi cho khách cho đến khi bấm Duyệt & Gửi.',
        }));
      }
      return box;
    }

    async function issueInvoice(button) {
      showError('');
      button.disabled = true;
      try {
        const data = await api('/admin/api/drafts/' + d.id + '/kiotviet/invoice', {
          method: 'POST',
          body: JSON.stringify({ actor_name: actorName() }),
        });
        const reply = detailEl.querySelector('#draft-reply');
        if (reply && data.draft && data.draft.draft_reply && d.approval_status !== 'SENT') {
          reply.value = data.draft.draft_reply;
        }
        toast(data.saved === false
          ? (data.error || ('Đã xuất ' + data.code))
          : ('Đã xuất ' + data.code + '. Tin vẫn chờ duyệt, chưa gửi.'));
        dirty = false;
        detailStamp = '';
        listStamp = '';
        await load();
      } catch (e) {
        if (e.message !== 'unauthorized') showError(e.message);
        button.disabled = false;
      }
    }

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

      let tools = null;
      if (!line.sku) {
        tools = el('div', { class: 'kiot-line-tools' });
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
        tools.appendChild(search);
        row.appendChild(tools);
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
      if (!tools) {
        const bare = el('div', { class: 'kiot-line-tools' });
        bare.appendChild(qtyWrap);
        row.appendChild(bare);
      } else {
        tools.appendChild(qtyWrap);
      }

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
        nameHint.textContent = hintSuffix(data.name_hint || '');
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
      const inDetail = !!(box.closest && box.closest('.name-row'));
      channelNameNodes(d, { when: inDetail ? when(d.created_at) : '' }).forEach(node => box.appendChild(node));
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

  function stripChannelPrefix(text) {
    return String(text || '').replace(/^Tên (?:Zalo|FB):\s*/, '');
  }

  function displayChannelName(item) {
    if (item.source === 'zalo' || item.source === 'fb') {
      const name = String(item.name || '').trim();
      if (name) return name;
      return stripChannelPrefix(item.text);
    }
    return item.text || item.name || '';
  }

  function adoptDraftField(name, id) {
    const input = detailEl.querySelector('input[name="' + name + '"]');
    if (!input) return null;
    if (id) {
      input.id = id;
      const label = input.parentElement && input.parentElement.querySelector('label');
      if (label) label.htmlFor = id;
    }
    return { wrap: input.closest('.field-block'), input };
  }

  function nameFallback(raw) {
    const nodes = [el('span', { class: 'msg-name', text: 'Khách chưa có tên' })];
    if (raw) nodes.push(el('span', { class: 'msg-id', text: raw }));
    return nodes;
  }

  function saleCode(d) {
    const f = formOf(d);
    const code = String((f && f.kiot_code) || (d && d.invoice_code) || '').trim();
    return /^(HD|DH)/i.test(code) ? code : '';
  }

  function identityRow(d, opts) {
    opts = opts || {};
    const names = Array.isArray(d.channel_names) ? d.channel_names : [];
    const kiot = names.find(item => item && item.source === 'kiot') || null;
    const kh = String((kiot && kiot.code) || (d && d.customer_code) || formOf(d).kiot_ref || '').trim();
    const hd = saleCode(d);
    const kiotName = kiot && kiot.name && !opaqueId(kiot.name) ? String(kiot.name).trim() : '';
    const stored = String((d && d.customer_name) || '').trim();
    const name = kiotName || (stored && !opaqueId(stored) ? stripChannelPrefix(stored) : 'Khách');
    const row = el('span', { class: 'id-row' });
    row.appendChild(el('span', { class: 'id-name', text: name }));
    if (kh && !opaqueId(kh)) row.appendChild(el('span', { class: 'id-code', title: 'Mã KH', text: kh }));
    if (hd) row.appendChild(el('span', { class: 'id-code', title: 'Mã HĐ', text: hd }));
    if (opts.when) row.appendChild(el('span', { class: 'id-when', text: opts.when }));
    return row;
  }

  function channelNameNodes(d, opts) {
    opts = opts || {};
    const names = Array.isArray(d.channel_names)
      ? d.channel_names.filter(item => item && (item.text || item.name || item.code))
      : [];
    const kiot = names.find(item => item && item.source === 'kiot') || null;
    const kh = String((kiot && kiot.code) || (d && d.customer_code) || '').trim();
    const hd = saleCode(d);
    const showIdentity = !!((kiot && (kiot.name || kiot.code)) || kh || hd);
    if (!showIdentity) {
      if (!names.length) {
        const phone = String(d.customer_phone || '').trim();
        const id = String(d.customer_user_id || '').trim();
        const stored = String(d.customer_name || '').trim();
        if (phone && !opaqueId(phone)) return [el('span', { class: 'msg-name', text: phone })];
        if (stored && !opaqueId(stored)) return [el('span', { class: 'msg-name', text: stripChannelPrefix(stored) })];
        return nameFallback(id || stored || phone);
      }
      const onlyOpaque = names.length === 1 && (names[0].source === 'id' || opaqueId(names[0].text || names[0].name));
      if (onlyOpaque) return nameFallback(names[0].text || names[0].name || '');
    }
    const nodes = showIdentity ? [identityRow(d, opts)] : [];
    const identityName = showIdentity ? nodes[0].querySelector('.id-name').textContent : '';
    names.filter(item => item.source !== 'kiot').forEach(item => {
      if (item.source === 'id' || opaqueId(item.text || item.name)) return;
      if (identityName && item.name && item.name === identityName) return;
      const bit = el('span', { class: 'msg-channel-name' });
      if (item.avatar && /^https:\/\//.test(item.avatar)) {
        bit.appendChild(el('img', { class: 'msg-avatar', alt: '', src: item.avatar }));
      }
      bit.appendChild(el('span', { text: displayChannelName(item) }));
      nodes.push(bit);
    });
    return nodes.length ? nodes : nameFallback('');
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

  function autoGrow(area, minLines) {
    if (!area) return;
    const fit = () => {
      area.style.height = 'auto';
      const style = getComputedStyle(area);
      const line = parseFloat(style.lineHeight) || 22;
      const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const min = Math.ceil(line * minLines + pad + border);
      area.style.height = Math.max(min, area.scrollHeight) + 'px';
    };
    area.addEventListener('input', fit);
    requestAnimationFrame(fit);
  }

  function hintSuffix(hint) {
    const text = String(hint || '').trim();
    if (!text) return '';
    if (/zalo/i.test(text)) return '· từ Zalo';
    if (/fb/i.test(text)) return '· từ FB';
    return '· ' + text.replace(/^lấy từ\s+/i, '');
  }

  function kiotInput(label, value, id, opts) {
    opts = opts || {};
    const attrs = { type: opts.type || 'text', id: id };
    if (opts.inputmode) attrs.inputmode = opts.inputmode;
    const input = el('input', attrs);
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
      queueAdvance(id);
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
    return row;
  }

  function deleteButtons(d) {
    const row = el('div', { class: 'card-delete' });
    if (!me.canDelete) {
      row.hidden = true;
      return row;
    }
    row.appendChild(deleteAction(d, 'item', 'Xóa tin này'));
    row.appendChild(deleteAction(d, 'thread', 'Xóa cả cuộc chat'));
    return row;
  }

  function deleteAction(d, scope, label) {
    const btn = el('button', { type: 'button', class: 'card-act card-del', text: 'Xóa' });
    btn.textContent = label || (scope === 'thread' ? 'Xóa cả cuộc chat' : 'Xóa tin này');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeDrafts(d, scope);
    });
    return btn;
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

  function threadMates(d) {
    const user = String((d && d.customer_user_id) || '').trim();
    if (!user) return [d];
    const mates = drafts.filter(item => item
      && item.channel === d.channel
      && item.customer_user_id === user
      && !pendingDeletes.has(item.id));
    return mates.length ? mates : [d];
  }

  function pushUndoToast(id, scope) {
    const host = document.getElementById('undo-toasts');
    const node = el('div', { class: 'toast', role: 'status' });
    const action = { label: 'Hoàn tác' };
    node.appendChild(document.createTextNode(scope === 'thread' ? 'Đã xoá cả cuộc chat. ' : 'Đã xoá tin này. '));
    const b = el('button', { type: 'button', class: 'linkish', text: action.label });
    b.addEventListener('click', () => { undoPending(id); });
    node.appendChild(b);
    if (host) host.appendChild(node);
    return node;
  }

  // Xóa hides the cards now. DELETE runs only after 3s if Hoàn tác was not clicked.
  // A refresh during that window omits the pending ids, so the cards stay gone.
  function removeDrafts(d, scope) {
    const policy = window.undoDelete;
    if (!policy || policy.needsConfirm() || !d || !me.canDelete) return;
    const targets = scope === 'thread' ? threadMates(d) : [d];
    const fresh = targets.filter(item => item && item.id && !pendingDeletes.has(item.id));
    if (!fresh.length) return;
    const entries = fresh.map(item => {
      const index = drafts.findIndex(row => row && row.id === item.id);
      const card = findCard(item.id);
      const next = card ? card.nextSibling : null;
      if (card) card.remove();
      return {
        id: item.id,
        draft: index >= 0 ? drafts[index] : item,
        index: index < 0 ? 0 : index,
        card,
        next,
      };
    });
    const idSet = new Set(entries.map(entry => entry.id));
    drafts = drafts.filter(row => row && !idSet.has(row.id));
    if (idSet.has(selectedId)) {
      selectedId = null;
      detailStamp = '';
      dirty = false;
      document.body.classList.remove('show-detail');
    }
    const anchor = entries[0];
    const toastNode = pushUndoToast(anchor.id, scope);
    const job = policy.schedule(anchor.id, {
      ms: policy.UNDO_MS,
      onFinalize: () => finalizeDelete(entries.map(entry => entry.id), scope, anchor.draft),
    });
    entries.forEach(entry => {
      pendingDeletes.set(entry.id, { ...entry, job, toastNode, scope, anchor: anchor.draft });
    });
  }

  function undoPending(id) {
    const entry = pendingDeletes.get(id);
    const policy = window.undoDelete;
    if (!entry || !policy || !entry.job.undo()) return;
    const group = [...pendingDeletes.entries()].filter(([, item]) => item.job === entry.job);
    group.forEach(([gid]) => pendingDeletes.delete(gid));
    if (entry.toastNode) entry.toastNode.remove();
    group.sort((a, b) => a[1].index - b[1].index);
    group.forEach(([, item]) => {
      if (item.draft) drafts = policy.restoreInPlace(drafts, item);
    });
    renderList();
    toast('Đã hoàn tác.');
  }

  async function finalizeDelete(ids, scope, anchor) {
    const sample = pendingDeletes.get(ids[0]);
    if (!sample) return;
    const toastNode = sample.toastNode;
    try {
      const data = await api('/admin/api/drafts/' + encodeURIComponent(anchor.id) + '/delete', {
        method: 'POST',
        body: JSON.stringify({
          actor_name: actorName(),
          scope: scope === 'thread' ? 'thread' : 'item',
          channel: anchor.channel,
          customer_user_id: anchor.customer_user_id,
        }),
      });
      const gone = data && Array.isArray(data.deleted) ? data.deleted.map(row => row && row.id) : ids;
      ids.concat(gone).forEach(id => {
        if (!id) return;
        pendingDeletes.delete(id);
        settledDeletes.add(id);
      });
      if (toastNode) toastNode.remove();
      listStamp = '';
      await load();
    } catch (e) {
      const policy = window.undoDelete;
      ids.forEach(id => {
        const item = pendingDeletes.get(id);
        pendingDeletes.delete(id);
        if (item && policy && item.draft) drafts = policy.restoreInPlace(drafts, item);
      });
      renderList();
      if (toastNode) toastNode.remove();
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

  function healthWhen(iso) {
    if (!iso) return 'chưa ghi nhận';
    return ictStamp(iso);
  }

  async function paintHealth() {
    const banner = document.getElementById('health-banner');
    const toggle = document.getElementById('health-toggle');
    if (!banner) return;
    try {
      const res = await fetch('/admin/api/health', {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const alerts = data.alerts || [];
      const rows = data.integrations || [];
      const bad = alerts.length > 0;
      banner.classList.toggle('bad', bad);
      banner.textContent = '';
      alerts.forEach(a => banner.appendChild(elFn('p', { class: 'health-alert', text: a.text })));
      const line = rows.map(r => r.label + ' ' + healthWhen(r.lastSuccessAt)).join(' · ');
      banner.appendChild(elFn('p', { class: 'health-times', text: line || 'Chưa ghi nhận mốc thành công.' }));
      if (toggle) {
        toggle.classList.toggle('bad', bad);
        const label = toggle.querySelector('.health-label');
        if (label) label.textContent = bad ? 'Cần xem' : '';
        toggle.setAttribute('aria-label', bad ? 'Kênh cần xem' : 'Kênh ổn');
      }
      syncBarHeight();
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

  const detailBack = document.getElementById('detail-back');
  if (detailBack) detailBack.addEventListener('click', () => closeDetail(false));

  const menuToggle = document.getElementById('menu-toggle');
  const appMenu = document.getElementById('app-menu');
  function setMenu(open) {
    if (!appMenu || !menuToggle) return;
    appMenu.hidden = !open;
    menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (menuToggle) {
    menuToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setMenu(appMenu.hidden);
    });
  }
  document.addEventListener('click', (ev) => {
    document.querySelectorAll('.more-panel').forEach(panel => {
      if (panel.hidden) return;
      if (ev.target.closest('.more-menu')) return;
      panel.hidden = true;
      const moreBtn = panel.parentElement && panel.parentElement.querySelector('.more-btn');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
    });
    if (!appMenu || appMenu.hidden) return;
    if (ev.target.closest('#app-menu') || ev.target.closest('#menu-toggle')) return;
    setMenu(false);
  });

  const healthToggle = document.getElementById('health-toggle');
  const healthBanner = document.getElementById('health-banner');
  if (healthToggle && healthBanner) {
    healthToggle.addEventListener('click', () => {
      const open = healthBanner.hidden;
      healthBanner.hidden = !open;
      healthToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      syncBarHeight();
    });
  }

  const searchToggle = document.getElementById('search-toggle');
  const searchInput = document.getElementById('inbox-search');
  function setSearch(open) {
    document.body.classList.toggle('search-open', open);
    if (searchToggle) searchToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && searchInput) searchInput.focus();
  }
  if (searchToggle) {
    searchToggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setSearch(!document.body.classList.contains('search-open'));
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderList();
      paintActiveFilters();
    });
  }

  let lastScrollY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (y > lastScrollY + 8 && y > 48) document.body.classList.add('bar-collapsed');
    if (y < 8 || y < lastScrollY - 8) document.body.classList.remove('bar-collapsed');
    lastScrollY = y;
    syncBarHeight();
  }, { passive: true });
  window.addEventListener('resize', syncBarHeight);
  syncBarHeight();

  function moveSelection(delta) {
    if (!drafts.length) return;
    const ids = drafts.map(item => item.id);
    let idx = ids.indexOf(selectedId);
    if (idx < 0) idx = delta > 0 ? -1 : ids.length;
    const next = ids[idx + delta];
    if (!next) return;
    if (isDesktop() || document.body.classList.contains('show-detail')) {
      openDraft(next);
      return;
    }
    selectedId = next;
    listEl.querySelectorAll('.msg-card').forEach(node => {
      node.classList.toggle('selected', node.getAttribute('data-draft-id') === next);
    });
    const card = findCard(next);
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const tag = document.activeElement ? document.activeElement.tagName : '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (document.activeElement && document.activeElement.isContentEditable);
    if (ev.key === 'Escape' && document.body.classList.contains('search-open')) {
      setSearch(false);
      if (searchInput) searchInput.blur();
      return;
    }
    if (typing) return;
    if (ev.key === 'Escape') {
      const morePanel = document.querySelector('.more-panel:not([hidden])');
      if (morePanel) {
        morePanel.hidden = true;
        const moreBtn = morePanel.parentElement && morePanel.parentElement.querySelector('.more-btn');
        if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      if (appMenu && !appMenu.hidden) { setMenu(false); return; }
      if (filterPanel && !filterPanel.hidden) {
        filterPanel.hidden = true;
        if (filterToggle) filterToggle.setAttribute('aria-expanded', 'false');
        return;
      }
      if (healthBanner && !healthBanner.hidden) {
        healthBanner.hidden = true;
        if (healthToggle) healthToggle.setAttribute('aria-expanded', 'false');
        return;
      }
      if (document.body.classList.contains('show-detail')) closeDetail(false);
      return;
    }
    if (ev.key === 'j' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveSelection(1);
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveSelection(-1);
    }
  });

  window.addEventListener('popstate', (ev) => {
    const state = ev.state || {};
    if (typeof state.scrollY === 'number') listScrollY = state.scrollY;
    const hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
    if (hashId && drafts.some(item => item.id === hashId)) {
      if (selectedId !== hashId || !document.body.classList.contains('show-detail')) {
        openDraft(hashId, { fromPop: true });
      }
      return;
    }
    if (document.body.classList.contains('show-detail')) closeDetail(true);
  });

  syncTabs();
  loadChannels().then(loadMe).then(load).then(startPolling).catch(e => {
    if (e.message !== 'unauthorized') showListError(e.message);
  });
})();
