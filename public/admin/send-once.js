/**
 * Duyệt & Gửi sends on click. There is no confirm dialog.
 * A second click for the same draft is ignored until the first request finishes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sendOnce = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const EMPTY = 'Nhập câu trả lời trước khi gửi.';

  function needsConfirm() {
    return false;
  }

  function prepare(state) {
    const text = String((state && state.reply) || '').trim();
    if (!text) return { send: false, inline: EMPTY };
    return { send: true, text, learn: !(state && state.learn === false) };
  }

  function createGate() {
    const inflight = new Set();
    return {
      tryBegin(id) {
        if (!id || inflight.has(id)) return false;
        inflight.add(id);
        return true;
      },
      end(id) {
        inflight.delete(id);
      },
    };
  }

  return { EMPTY, needsConfirm, prepare, createGate, gate: createGate() };
});
