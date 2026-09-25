/**
 * Inbox times. source_received_at is the customer's message time at
 * Messenger or Zalo. created_at is only a fallback, marked with '~'.
 * Sent times use the successful send response, in Asia/Ho_Chi_Minh.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.cardTime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ZONE = 'Asia/Ho_Chi_Minh';
  const MIN_MS = Date.UTC(2010, 0, 1);
  const MAX_MS = Date.UTC(2100, 0, 1);

  function fromEpoch(n) {
    if (!Number.isFinite(n)) return null;
    const ms = n < 1e11 ? n * 1000 : n;
    if (ms < MIN_MS || ms > MAX_MS) return null;
    return new Date(ms).toISOString();
  }

  function parse(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return fromEpoch(value);
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d{10}$/.test(text) || /^\d{13}$/.test(text)) return fromEpoch(Number(text));
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) return null;
    if (ms < MIN_MS || ms > MAX_MS) return null;
    return new Date(ms).toISOString();
  }

  /** Messenger ids built as fb_|pb_|att_ + psid + '_' + webhook ms. No network. */
  function fromSyntheticMsgId(id) {
    const text = String(id || '');
    const match = text.match(/^(?:fb|pb|att)_.+_(\d{13})$/);
    if (!match) return null;
    return fromEpoch(Number(match[1]));
  }

  function parts(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hourCycle: 'h23',
    });
    const bag = {};
    fmt.formatToParts(d).forEach(part => { bag[part.type] = part.value; });
    if (!bag.hour || !bag.minute || !bag.day || !bag.month || !bag.year) return null;
    if (bag.hour === '24') bag.hour = '00';
    return bag;
  }

  function absolute(iso) {
    const bag = parts(iso);
    if (!bag) return '';
    return bag.hour + ':' + bag.minute + ' ' + bag.day + '/' + bag.month + '/' + bag.year;
  }

  function relative(iso, now) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = ((now == null ? Date.now() : now) - t) / 1000;
    if (diff < 0) return absolute(iso);
    if (diff < 60) return 'vừa xong';
    if (diff < 3600) return Math.floor(diff / 60) + ' phút trước';
    if (diff < 86400) return Math.floor(diff / 3600) + ' giờ trước';
    return absolute(iso);
  }

  function senderLabel(sentBy) {
    const raw = String(sentBy || '').trim();
    const idx = raw.lastIndexOf(':');
    const name = idx >= 0 ? raw.slice(idx + 1).trim() : '';
    if (!name || name === 'bootstrap' || raw === 'manager' || raw === 'staff') return 'Quản lý';
    return name;
  }

  function receivedLabel(draft, now) {
    const source = draft && parse(draft.source_received_at);
    const created = draft && parse(draft.created_at);
    const iso = source || created;
    if (!iso) return { text: '', approx: !source, title: '' };
    const clock = absolute(iso);
    if (!clock) return { text: '', approx: !source, title: '' };
    const rel = relative(iso, now);
    const title = source
      ? rel
      : (rel ? rel + ' · giờ tạo bản nháp, kênh không gửi giờ nhận' : 'Giờ tạo bản nháp, kênh không gửi giờ nhận');
    return {
      text: source ? 'Nhận: ' + clock : 'Nhận: ~' + clock,
      approx: !source,
      title,
    };
  }

  function sentLabel(draft) {
    const iso = draft && parse(draft.sent_at);
    if (!iso) return null;
    const clock = absolute(iso);
    if (!clock) return null;
    return {
      text: 'Gửi: ' + clock,
      who: senderLabel(draft.sent_by),
    };
  }

  function platformMessageId(result) {
    if (!result || typeof result !== 'object') return null;
    const nested = result.data && typeof result.data === 'object' ? result.data : null;
    const inner = result.result && typeof result.result === 'object' ? result.result : null;
    const raw = result.message_id || result.messageId || result.msg_id
      || (nested && (nested.message_id || nested.msg_id))
      || (inner && (inner.message_id || inner.msg_id))
      || null;
    if (raw == null) return null;
    const text = String(raw).trim();
    return text ? text.slice(0, 200) : null;
  }

  const BACKFILL_SQL = `
    UPDATE outbound_drafts
    SET source_received_at = to_timestamp(
      substring(source_msg_id from '_([0-9]{13})$')::double precision / 1000.0
    )
    WHERE source_received_at IS NULL
      AND source_msg_id ~ '^(fb|pb|att)_.+_[0-9]{13}$'
  `;

  return {
    parse,
    absolute,
    relative,
    receivedLabel,
    sentLabel,
    senderLabel,
    fromSyntheticMsgId,
    platformMessageId,
    BACKFILL_SQL,
  };
});
