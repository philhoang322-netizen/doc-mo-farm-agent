/**
 * One inbox order for the server and the page: newest customer message
 * first. source_received_at when the draft has one, otherwise created_at,
 * then id. Equal keys compare equal so a refresh does not shuffle ties.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.inboxOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COUNT_KEY = { zalo: 'zalo', 'fb-sale': 'fbSale', 'fb-dv': 'fbDv' };

  function timeOf(d) {
    if (!d) return '';
    return String(d.source_received_at || d.created_at || '');
  }

  function stamp(d) {
    return timeOf(d) + '\n' + String(d && d.id || '');
  }

  function compare(a, b) {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    const ia = String(a && a.id || '');
    const ib = String(b && b.id || '');
    if (ia === ib) return 0;
    return ia < ib ? 1 : -1;
  }

  function sort(list) {
    return (Array.isArray(list) ? list : []).slice().sort(compare);
  }

  /** A sales channel named zalo is the Zalo OA tab, not another chip. */
  function showChannelChip(channel) {
    const id = String(channel && channel.id != null ? channel.id : channel || '').trim().toLowerCase();
    const name = String(channel && channel.name || '').trim().toLowerCase();
    return id !== 'zalo' && name !== 'zalo';
  }

  /** First group in tab order that has messages. Hidden tabs are skipped. */
  function defaultGroup(counts, hidden) {
    const order = ['zalo', 'fb-sale', 'fb-dv'].filter(id => !(hidden && hidden[id]));
    const found = order.find(id => Number(counts && counts[COUNT_KEY[id]]) > 0);
    return found || order[0] || 'zalo';
  }

  return { timeOf, stamp, compare, sort, defaultGroup, showChannelChip };
});
