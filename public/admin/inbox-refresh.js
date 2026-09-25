(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.inboxRefresh = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const FOCUSABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  function editingHold(state) {
    if (!state) return false;
    if (state.dirty) return true;
    if (state.kiotOpen) return true;
    if (state.composerOpen) return true;
    if (state.channelFormOpen) return true;
    if (state.detailOpen) return true;
    const tag = String(state.focusedTag || '').toUpperCase();
    return FOCUSABLE.has(tag);
  }

  function unseenIds(renderedIds, incoming) {
    const have = new Set(renderedIds || []);
    const out = [];
    (incoming || []).forEach(d => {
      if (d && d.id && !have.has(d.id)) out.push(d.id);
    });
    return out;
  }

  function bannerLabel(n) {
    return 'Có ' + n + ' tin mới — bấm để hiện';
  }

  function anchorDelta(previousTop, nextTop) {
    return nextTop - previousTop;
  }

  // background + hold: leave the list alone.
  // background or apply: insert new cards only.
  // replace: explicit rebuild (first paint, folder change, after send).
  function listMutation(mode, hold) {
    if (mode === 'background' && hold) return 'freeze';
    if (mode === 'background' || mode === 'apply') return 'insert';
    return 'replace';
  }

  return { editingHold, unseenIds, bannerLabel, anchorDelta, listMutation };
});
