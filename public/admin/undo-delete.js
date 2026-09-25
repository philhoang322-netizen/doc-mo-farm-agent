/**
 * Client-side 3 second undo for Xóa.
 *
 * The card is hidden immediately. The DELETE request is not sent until
 * UNDO_MS has passed. Undo cancels that timer and does not call the server.
 * Closing or refreshing the tab drops this in-memory timer, so the draft
 * stays on the server and the next full load shows the card again. That
 * avoids a half-deleted card: either the row is still complete, or the
 * DELETE has already finished and the row is gone.
 * Each id has its own timer. A list refresh must omit ids that are pending.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.undoDelete = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const UNDO_MS = 3000;

  function needsConfirm() {
    return false;
  }

  function omitPending(incoming, pendingIds) {
    const pending = new Set(pendingIds || []);
    return (incoming || []).filter(d => d && d.id && !pending.has(d.id));
  }

  function restoreInPlace(list, entry) {
    const draft = entry && entry.draft;
    if (!draft || !draft.id) return (list || []).slice();
    const next = (list || []).filter(d => d && d.id !== draft.id);
    const raw = entry.index == null ? next.length : entry.index;
    const idx = Math.max(0, Math.min(raw, next.length));
    next.splice(idx, 0, draft);
    return next;
  }

  function schedule(id, opts) {
    opts = opts || {};
    const ms = opts.ms == null ? UNDO_MS : opts.ms;
    const timers = opts.timers || {
      set: (fn, ms) => setTimeout(fn, ms),
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

  return { UNDO_MS, needsConfirm, omitPending, restoreInPlace, schedule };
});
