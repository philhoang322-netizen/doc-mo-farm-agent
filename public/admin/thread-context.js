/**
 * How many earlier thread messages a review card shows.
 * The newest customer message stays outside this list.
 * Collapsed: the last 3 of up to 10. Expanded: all of those (max 10).
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

  return { prior, visible, needsToggle };
});
