/**
 * Client-side 3 second undo for Chưa TT / Đã TT.
 *
 * The chip flips immediately. The POST is not sent until UNDO_MS has
 * passed. Undo cancels that timer and does not call the server.
 * Closing or refreshing the tab drops this in-memory timer, so the
 * stored status stays as it was. One tap, no confirm dialog.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.payToggle = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const UNDO_MS = 3000;

  function needsConfirm() {
    return false;
  }

  function chipLabel(status, method, due) {
    if (status === 'mot_phan') {
      const n = Math.max(0, Math.round(Number(due) || 0));
      return 'Còn nợ ' + n.toLocaleString('vi-VN') + 'đ';
    }
    if (status !== 'da_tt') return 'Chưa TT';
    if (method === 'cash') return 'Đã TT · Tiền mặt';
    if (method === 'card') return 'Đã TT · Thẻ';
  if (method === 'mixed') return 'Đã TT · Nhiều cách';
  if (method === 'transfer') return 'Đã TT · CK';
  return 'Đã TT';
}

  function choices(status) {
    if (status === 'da_tt') return [];
    return [
      { status: 'da_tt', method: 'cash', label: 'Tiền mặt' },
      { status: 'da_tt', method: 'transfer', label: 'CK' },
    ];
  }

  function toastText(status, method) {
    if (status !== 'da_tt') return 'Đã chuyển sang Chưa TT. ';
    return method === 'cash' ? 'Đã chuyển sang Đã TT · Tiền mặt. ' : 'Đã chuyển sang Đã TT · CK. ';
  }

  function schedule(id, opts) {
    opts = opts || {};
    const ms = opts.ms == null ? UNDO_MS : opts.ms;
    const timers = opts.timers || {
      set: (fn, delay) => setTimeout(fn, delay),
      clear: (handle) => clearTimeout(handle),
    };
    let settled = false;
    const handle = timers.set(() => {
      if (settled) return;
      settled = true;
      if (typeof opts.onFinalize === 'function') opts.onFinalize(id);
    }, ms);
    return {
      id,
      ms,
      undo() {
        if (settled) return false;
        settled = true;
        timers.clear(handle);
        return true;
      },
    };
  }

  return { UNDO_MS, needsConfirm, chipLabel, choices, toastText, schedule };
});
