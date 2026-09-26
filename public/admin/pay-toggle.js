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

  return { UNDO_MS, needsConfirm, schedule };
});
