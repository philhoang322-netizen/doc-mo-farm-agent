/**
 * Earlier messages on a review card, above the newest customer line.
 * Collapsed: the last 3 of up to 10. Expanded: those 10.
 * Customer bubbles sit on the left (grey). Shop bubbles sit on the right (green).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.threadContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function prior(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.slice(-10);
  }

  function visible(rows, expanded) {
    const all = prior(rows);
    if (expanded || all.length <= 3) return all;
    return all.slice(-3);
  }

  function needsToggle(rows) {
    return prior(rows).length > 3;
  }

  function formatWhen(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (Number.isNaN(diff)) return '';
    if (diff < 60) return 'vừa xong';
    if (diff < 3600) return Math.floor(diff / 60) + ' phút trước';
    if (diff < 86400) return Math.floor(diff / 3600) + ' giờ trước';
    return new Date(iso).toLocaleString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * @param {Array} rows
   * @param {{nested?: boolean}} [opts] nested=true when the card itself is a button
   * @returns {HTMLElement|null}
   */
  function mount(rows, opts) {
    if (typeof document === 'undefined') return null;
    const all = prior(rows);
    if (!all.length) return null;
    const nested = !!(opts && opts.nested);
    let expanded = false;
    const box = el('div', 'thread-context');
    const list = el('div', 'thread-list');
    const toggle = el(nested ? 'span' : 'button', 'thread-more', 'Xem thêm');
    if (!nested) toggle.type = 'button';
    else toggle.setAttribute('role', 'button');

    function bubble(m) {
      const side = m && m.direction === 'out' ? 'out' : 'in';
      const who = side === 'out' ? ((m && m.sender_label) || 'Shop') : 'Khách';
      const whenText = m && m.created_time ? formatWhen(m.created_time) : '';
      const row = el('div', 'thread-row ' + side);
      const item = el('div', 'thread-bubble');
      item.appendChild(el('div', 'thread-meta', whenText ? (who + ' · ' + whenText) : who));
      item.appendChild(el('div', 'thread-text', (m && m.text) || ''));
      row.appendChild(item);
      return row;
    }

    function paint() {
      const view = visible(all, expanded);
      list.textContent = '';
      view.forEach((m) => list.appendChild(bubble(m)));
      const show = needsToggle(all);
      toggle.hidden = !show;
      toggle.textContent = expanded ? 'Thu gọn' : 'Xem thêm';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      box.dataset.shown = String(view.length);
    }

    toggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      expanded = !expanded;
      paint();
    });
    box.appendChild(list);
    box.appendChild(toggle);
    paint();
    return box;
  }

  return { prior, visible, needsToggle, mount, formatWhen };
});
