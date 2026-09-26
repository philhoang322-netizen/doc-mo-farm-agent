/**
 * Earlier messages on a review card, above the newest customer line.
 * Collapsed: the last 3 of up to 10. Expanded: those 10.
 * Customer bubbles sit on the left (grey). Shop bubbles sit on the right (green).
 * Facebook system notices are not Shop lines: a post reply is a short link,
 * and the automatic-greeting notice is left out.
 */
(function (root, factory) {
  const notices = (typeof module === 'object' && module.exports)
    ? require('./fb-notices')
    : (root && root.fbNotices) || {
      describe() { return null; },
      labelFor() { return null; },
      linkParts(text) { return [{ type: 'text', text: String(text || '') }]; },
    };
  const api = factory(notices);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.threadContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (notices) {
  function rowText(row) {
    if (!row || typeof row !== 'object') return '';
    return row.text || row.message_text || '';
  }

  function noticeOf(row) {
    if (!row || typeof row !== 'object') return null;
    const described = notices.describe(rowText(row));
    const given = row.notice && typeof row.notice === 'object' ? row.notice : null;
    const meta = row.sender_meta || {};
    const fromMeta = meta.system_notice ? {
      kind: meta.system_notice,
      hide: meta.system_notice === 'greeting',
      label: notices.labelFor(meta.system_notice),
      url: meta.story_url || null,
      storyId: meta.story_id || null,
    } : null;
    const notice = described || given || fromMeta;
    if (!notice || !notice.kind) return null;
    const url = notice.url || (described && described.url) || null;
    return {
      kind: notice.kind,
      hide: notice.hide === true || notice.kind === 'greeting',
      label: notice.label || notices.labelFor(notice.kind),
      url,
      storyId: notice.storyId || (described && described.storyId) || null,
    };
  }

  function isHidden(row) {
    if (!row || typeof row !== 'object') return false;
    const notice = noticeOf(row);
    return !!(notice && (notice.hide || !notice.url));
  }

  function prior(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.filter((row) => !isHidden(row)).slice(-10);
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

  function present(row) {
    if (row == null || typeof row !== 'object') {
      return {
        type: 'bubble',
        direction: 'in',
        who: 'Khách',
        parts: [{ type: 'text', text: row == null ? '' : String(row) }],
      };
    }
    const notice = noticeOf(row);
    if (notice) {
      if (notice.hide || !notice.url) return null;
      return {
        type: 'chip',
        label: notice.label || 'Xem bài viết',
        url: notice.url,
        storyId: notice.storyId || null,
      };
    }
    const side = row.direction === 'out' ? 'out' : 'in';
    const who = side === 'out' ? (row.sender_label || 'Shop') : 'Khách';
    return {
      type: 'bubble',
      direction: side,
      who,
      parts: notices.linkParts(rowText(row)),
    };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function safeHttp(url) {
    return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
  }

  function bindLink(node, url, nested) {
    const href = safeHttp(url);
    if (!nested && node.tagName === 'A') {
      node.href = href || '#';
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    } else {
      node.setAttribute('role', 'link');
      node.tabIndex = 0;
    }
    node.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (nested && href) {
        ev.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    });
    node.addEventListener('keydown', (ev) => {
      if (!nested || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    });
  }

  function chipRow(view, nested) {
    const row = el('div', 'thread-row notice');
    const node = el(nested ? 'span' : 'a', 'thread-chip', view.label);
    bindLink(node, view.url, nested);
    row.appendChild(node);
    return row;
  }

  function bubbleRow(row, view, nested) {
    const whenText = row && row.created_time ? formatWhen(row.created_time) : '';
    const wrap = el('div', 'thread-row ' + view.direction);
    const item = el('div', 'thread-bubble');
    item.appendChild(el('div', 'thread-meta', whenText ? (view.who + ' · ' + whenText) : view.who));
    const text = el('div', 'thread-text');
    for (const part of view.parts || []) {
      if (part.type === 'link') {
        const node = el(nested ? 'span' : 'a', 'thread-link', part.label);
        bindLink(node, part.url, nested);
        text.appendChild(node);
      } else if (part.text) {
        text.appendChild(document.createTextNode(part.text));
      }
    }
    item.appendChild(text);
    wrap.appendChild(item);
    return wrap;
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

    function paint() {
      const view = visible(all, expanded);
      list.textContent = '';
      view.forEach((row) => {
        const shown = present(row);
        if (!shown) return;
        list.appendChild(shown.type === 'chip' ? chipRow(shown, nested) : bubbleRow(row, shown, nested));
      });
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

  return { prior, visible, needsToggle, mount, formatWhen, present };
});
