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
  const PLATFORM_LABEL = { zalo: 'Zalo OA', messenger: 'Messenger' };
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
  const platformTabs = [...document.querySelectorAll('[data-platform]')];

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
  let platform = Object.prototype.hasOwnProperty.call(PLATFORM_LABEL, params.get('platform')) ? params.get('platform') : '';
  let salesChannel = params.get('kenh') || 'farm';
  let channels = [];
  let drafts = [];
  let counts = {};
  let triageCounts = { hot: 0, urgent: 0, normal: 0 };
  let platformCounts = { zalo: 0, messenger: 0 };
  let selectedId = location.hash ? location.hash.slice(1) : null;
  let dirty = false;
  let busy = false;
  let loadedOnce = false;
  let listStamp = '';
  let detailStamp = '';

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
    if (platform) q.set('platform', platform);
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

  platformTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.platform || '';
      if (next === platform) return;
      guardSwitch(() => { platform = next; });
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
      platform = '';
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
    platformTabs.forEach(btn => {
      const on = (btn.dataset.platform || '') === platform;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      const key = btn.dataset.platform;
      const b = btn.querySelector('.count');
      if (b) {
        const n = key ? platformCounts[key] : 0;
        b.textContent = n ? String(n) : '';
      }
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

  async function load() {
    if (!loadedOnce) listEl.textContent = 'Đang tải…';
    const q = new URLSearchParams();
    q.set('ops', ops);
    q.set('kenh', salesChannel);
    if (messageType) q.set('type', messageType);
    if (triage) q.set('triage', triage);
    if (platform) q.set('platform', platform);
    try {
      const [data, stats] = await Promise.all([
        api('/admin/api/drafts?' + q.toString()),
        api('/admin/api/stats?kenh=' + encodeURIComponent(salesChannel)),
      ]);
      drafts = data.drafts || [];
      counts = data.counts || {};
      triageCounts = data.triageCounts || triageCounts;
      platformCounts = data.platformCounts || platformCounts;
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
    detailEl.replaceChildren(el('div', { class: 'detail-empty' }, [
      el('div', null, [
        el('strong', { text: 'Chọn một tin bên trái' }),
        el('p', { text: 'Đọc, sửa bản nháp, rồi bấm Duyệt và gửi. Hệ thống không tự gửi.' }),
      ]),
    ]));
  }

  function emptyCopy() {
    if (platform) {
      const name = PLATFORM_LABEL[platform];
      return {
        title: 'Không có tin ' + name + '.',
        body: 'Không có tin ' + name + ' khớp bộ lọc. Chọn Tất cả để xem cả Zalo OA và Messenger.',
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
    drafts.forEach(d => {
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
      const kind = kindTag(d);
      if (kind) tags.appendChild(el('span', { class: 'tag ' + kind.cls, text: kind.text }));
      btn.appendChild(el('div', { class: 'msg-top' }, [
        el('span', { class: 'msg-name', text: d.customer_name || 'Khách chưa có tên' }),
        el('span', { class: 'msg-time', text: when(d.created_at) }),
      ]));
      btn.appendChild(el('div', { class: 'msg-preview', text: snippet(d) }));
      btn.appendChild(tags);
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
    const nameRow = el('div', { class: 'name-row' }, [
      el('h3', { text: d.customer_name || 'Khách chưa có tên' }),
    ]);
    if (code) {
      nameRow.appendChild(el('span', { class: 'cust-code', title: 'Mã khách hàng', text: code }));
    }
    const meta = el('div', { class: 'detail-meta' }, [nameRow]);
    const badge = triageBadge(d);
    if (badge) meta.appendChild(badge);
    const ch = channelTag(d);
    meta.appendChild(el('span', { class: 'tag ' + ch.cls, text: ch.text }));
    const kind = kindTag(d);
    if (kind) meta.appendChild(el('span', { class: 'tag ' + kind.cls, text: kind.text }));
    body.appendChild(meta);

    body.appendChild(el('div', { class: 'want-box' }, [
      el('span', { text: 'Khách đang muốn' }),
      el('div', { text: snippet(d) || '—' }),
    ]));

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
    reply.addEventListener('input', () => { dirty = true; });
    body.appendChild(el('div', { class: 'field-block' }, [reply]));

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
    };
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
      if (sendResult && sendResult.sent) toast('Đã gửi cho khách.');
      else if (sendResult && sendResult.pendingAdapter) toast('Đã duyệt. Kênh chưa có đường gửi, tin nằm ở Chờ gửi.');
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
