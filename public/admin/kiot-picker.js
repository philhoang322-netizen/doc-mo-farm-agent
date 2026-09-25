/**
 * KiotViet product line helpers for the inbox order form.
 * The stepper uses whole units. A typed 0.5 or 1.2 stays.
 * 1.001 (the old 0.001 step) is shown as 1.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.kiotPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const OFFLINE = 'Chưa kết nối KiotViet: không tra được sản phẩm/giá';
  const EMPTY = 'Không tìm thấy sản phẩm gần giống';
  const LOADING = 'Đang tìm…';

  function normalizeQty(value) {
    const raw = String(value == null ? '' : value).trim().replace(',', '.');
    if (!raw || raw === '.' || raw === '-') return 1;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1;
    const nearest = Math.round(n);
    if (Math.abs(n - nearest) <= 0.002) return nearest > 0 ? nearest : 1;
    return Math.round(n * 1000) / 1000;
  }

  function qtyText(value) {
    const raw = String(value == null ? '' : value).trim();
    if (/^[0-9]*[.,]$/.test(raw)) return raw;
    const n = normalizeQty(value);
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return String(n);
  }

  function searchNote(phase) {
    if (phase === 'loading') return LOADING;
    if (phase === 'error') return OFFLINE;
    if (phase === 'empty') return EMPTY;
    return '';
  }

  return { normalizeQty, qtyText, searchNote, OFFLINE, EMPTY, LOADING };
});
