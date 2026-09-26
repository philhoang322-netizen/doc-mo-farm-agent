/**
 * Inbox time sections. The customer's latest message time
 * (source_received_at, else created_at — the same fields as inboxOrder)
 * falls into one civil bucket in Asia/Ho_Chi_Minh:
 * today, this Monday-start week excluding today, this calendar month
 * excluding those, then older. Empty buckets are omitted. Input order
 * is kept, so a newest-first list stays newest-first inside each section.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.inboxSections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ZONE = 'Asia/Ho_Chi_Minh';
  const STORAGE_KEY = 'inbox-sections';
  const ORDER = ['today', 'week', 'month', 'older'];
  const TITLES = {
    today: 'Hôm nay',
    week: 'Trong tuần',
    month: 'Trong tháng',
    older: 'Cũ hơn',
  };

  function timeOf(d) {
    if (!d) return '';
    return String(d.source_received_at || d.created_at || '');
  }

  function civil(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const bag = {};
    fmt.formatToParts(d).forEach(part => { bag[part.type] = part.value; });
    const year = Number(bag.year);
    const month = Number(bag.month);
    const day = Number(bag.day);
    if (!year || !month || !day) return null;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, weekday };
  }

  function dateKey(parts) {
    return parts.year * 10000 + parts.month * 100 + parts.day;
  }

  /** Monday of the civil week that contains parts. weekday 0 is Sunday. */
  function mondayOf(parts) {
    const offset = (parts.weekday + 6) % 7;
    const mon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset * 86400000);
    return {
      year: mon.getUTCFullYear(),
      month: mon.getUTCMonth() + 1,
      day: mon.getUTCDate(),
    };
  }

  function bucket(iso, nowIso) {
    const when = civil(iso);
    if (!when) return 'older';
    const now = civil(nowIso || new Date().toISOString());
    if (!now) return 'older';
    if (dateKey(when) >= dateKey(now)) return 'today';
    if (dateKey(when) >= dateKey(mondayOf(now))) return 'week';
    if (when.year === now.year && when.month === now.month) return 'month';
    return 'older';
  }

  function bucketOf(draft, nowIso) {
    return bucket(timeOf(draft), nowIso);
  }

  function group(list, nowIso) {
    const buckets = { today: [], week: [], month: [], older: [] };
    (Array.isArray(list) ? list : []).forEach(item => {
      buckets[bucketOf(item, nowIso)].push(item);
    });
    return ORDER.filter(id => buckets[id].length).map(id => ({
      id,
      title: TITLES[id],
      items: buckets[id],
    }));
  }

  function title(id) {
    return TITLES[id] || '';
  }

  function memoryStorage(seed) {
    const bag = Object.assign({}, seed || {});
    return {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : null;
      },
      setItem(key, value) {
        bag[key] = String(value);
      },
    };
  }

  function browserStore() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return memoryStorage();
      const probe = STORAGE_KEY + ':probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    } catch (_) {
      return memoryStorage();
    }
  }

  function read(storage) {
    const store = storage || browserStore();
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function write(all, storage) {
    const store = storage || browserStore();
    store.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function isOpen(tab, id, storage) {
    const row = read(storage)[String(tab || '')] || {};
    if (id === 'today') return row.today !== false;
    return row[id] === true;
  }

  function setOpen(tab, id, open, storage) {
    const all = read(storage);
    const key = String(tab || '');
    const row = Object.assign({}, all[key] || {});
    row[id] = !!open;
    all[key] = row;
    write(all, storage);
  }

  return {
    ZONE,
    ORDER,
    TITLES,
    timeOf,
    bucket,
    bucketOf,
    group,
    title,
    isOpen,
    setOpen,
    memoryStorage,
  };
});
