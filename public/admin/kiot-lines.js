/**
 * Line items for the inbox KiotViet form.
 * Choosing a product fills that empty line. Choosing a different product
 * on a line that already has one adds a line. It does not replace it.
 * Nothing here talks to KiotViet.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.kiotLines = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function blankLine() {
    return {
      sku: '',
      name: '',
      unit: '',
      price: null,
      quantity: 1,
      phrase: '',
      status: 'empty',
      warning: '',
      stock: null,
      candidates: [],
      query: '',
      hits: [],
      searchPhase: 'idle',
    };
  }

  function cloneLines(lines) {
    return (Array.isArray(lines) ? lines : []).map(line => {
      const copy = Object.assign(blankLine(), line || {});
      copy.hits = [];
      copy.searchPhase = 'idle';
      if (copy._timer) delete copy._timer;
      return copy;
    });
  }

  function skuOf(product) {
    return String((product && (product.sku || product.code)) || '').trim();
  }

  function stockFor(available, quantity) {
    if (available == null || !Number.isFinite(Number(available))) {
      return { level: 'unknown', available: null };
    }
    const avail = Number(available);
    const qty = Number(quantity);
    const need = Number.isFinite(qty) && qty > 0 ? qty : 1;
    let level = 'ok';
    if (avail <= 0 || avail < need) level = 'blocked';
    else if (avail <= 5) level = 'low';
    return { level, available: avail };
  }

  function restock(line) {
    if (!line || !line.stock || line.stock.available == null) return line;
    const available = line.stock.available;
    line.stock = stockFor(available, line.quantity);
    return line;
  }

  function fillProduct(line, product, quantity) {
    const sku = skuOf(product);
    line.sku = sku;
    line.name = (product && product.name) || '';
    line.unit = (product && product.unit) || '';
    line.price = product && product.price != null ? Number(product.price) : null;
    line.quantity = quantity == null ? 1 : quantity;
    line.status = 'matched';
    line.candidates = [];
    line.hits = [];
    line.searchPhase = 'idle';
    line.query = '';
    line.phrase = line.phrase || '';
    if (product && product.stock) line.stock = product.stock;
    else if (product && product.available != null) line.stock = stockFor(product.available, line.quantity);
    restock(line);
    return line;
  }

  function addLine(lines) {
    return cloneLines(lines).concat([blankLine()]);
  }

  /** Put the picked product on the first empty line, or append it. Quantity stays 1. */
  function addProduct(lines, product) {
    const next = cloneLines(lines);
    let idx = next.findIndex(line => !line.sku && !String(line.name || '').trim());
    if (idx < 0) {
      next.push(blankLine());
      idx = next.length - 1;
    }
    fillProduct(next[idx], product, 1);
    return next;
  }

  function removeLine(lines, index) {
    const next = cloneLines(lines).filter((_, i) => i !== index);
    return next.length ? next : [blankLine()];
  }

  /**
   * Fill the empty line at index. If that line already has a different
   * product, insert the new one after it and leave the old one in place.
   */
  function chooseProduct(lines, index, product) {
    const next = cloneLines(lines);
    const line = next[index];
    if (!line || !product) return next;
    const sku = skuOf(product);
    const qty = line.quantity == null ? 1 : line.quantity;
    if (line.sku && sku && line.sku !== sku) {
      const extra = blankLine();
      fillProduct(extra, product, 1);
      next.splice(index + 1, 0, extra);
      return next;
    }
    fillProduct(line, product, qty || 1);
    return next;
  }

  function fromQuickRow(row) {
    const line = Object.assign(blankLine(), {
      sku: (row && row.sku) || '',
      name: (row && (row.name || row.product_name)) || '',
      unit: (row && row.unit) || '',
      price: row && row.price != null ? row.price : null,
      quantity: row && row.quantity != null ? row.quantity : 1,
      phrase: (row && row.phrase) || '',
      status: (row && row.status) || ((row && row.sku) ? 'matched' : 'unmatched'),
      warning: (row && row.warning) || '',
      stock: (row && row.stock) || null,
      candidates: (row && row.candidates) || [],
      query: row && row.status === 'unmatched' ? (row.phrase || '') : '',
    });
    return line;
  }

  /**
   * Turn quick-entry rows into lines. Existing chosen products stay.
   * A blank form is replaced by every parsed row, not just the first.
   */
  function applyQuick(lines, rows) {
    const incoming = (Array.isArray(rows) ? rows : []).map(fromQuickRow);
    const kept = cloneLines(lines).filter(line => line.sku);
    if (!kept.length) return incoming.length ? incoming : [blankLine()];
    const seen = new Set(kept.map(line => line.sku));
    const extra = [];
    incoming.forEach(row => {
      if (row.sku && seen.has(row.sku)) return;
      if (row.sku) seen.add(row.sku);
      extra.push(row);
    });
    return extra.length ? kept.concat(extra) : kept;
  }

  function lineAmount(line) {
    const price = Number(line && line.price);
    const qty = Number(line && line.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return null;
    return price * qty;
  }

  function orderTotal(lines, discount, shipping) {
    const sub = (lines || []).reduce((sum, line) => sum + (lineAmount(line) || 0), 0);
    const off = Number(discount);
    const ship = Number(shipping);
    return Math.max(0, sub - (Number.isFinite(off) ? off : 0) + (Number.isFinite(ship) ? ship : 0));
  }

  function payloadLines(lines) {
    return (lines || []).filter(line => line && (line.sku || line.name || line.phrase)).map(line => ({
      sku: line.sku || '',
      product_name: line.name || line.phrase || '',
      quantity: Number(line.quantity) || 0,
      price: line.price,
    }));
  }

  function mergeQuote(lines, quoted) {
    const next = cloneLines(lines);
    const used = new Set();
    (quoted || []).forEach(row => {
      if (!row) return;
      let idx = next.findIndex((line, i) => !used.has(i) && line.sku && row.sku && line.sku === row.sku);
      if (idx < 0) {
        idx = next.findIndex((line, i) => !used.has(i) && !line.sku && row.product_name
          && (line.phrase === row.product_name || line.name === row.name || line.name === row.product_name));
      }
      if (idx < 0) return;
      used.add(idx);
      const line = next[idx];
      if (row.price != null) line.price = row.price;
      if (row.sku) line.sku = row.sku;
      if (row.name) line.name = row.name;
      if (row.unit) line.unit = row.unit;
      if (row.stock) line.stock = row.stock;
      if (row.quantity != null && line.quantity == null) line.quantity = row.quantity;
      if (row.missing) line.status = 'unmatched';
      restock(line);
    });
    return next;
  }

  function snapshot(form) {
    const src = form || {};
    return {
      document: src.document === 'order' ? 'order' : 'invoice',
      lines: cloneLines(src.lines && src.lines.length ? src.lines : [blankLine()]),
      quick: src.quick || '',
      name: src.name || '',
      phone: src.phone || '',
      address: src.address || '',
      discount: src.discount == null ? '0' : String(src.discount),
      ship: src.ship == null ? '0' : String(src.ship),
      note: src.note || '',
      touched: Object.assign({}, src.touched || {}),
    };
  }

  function restore(saved) {
    if (!saved || typeof saved !== 'object') return null;
    const snap = snapshot(saved);
    if (!snap.lines.length) snap.lines = [blankLine()];
    return snap;
  }

  return {
    blankLine,
    cloneLines,
    addLine,
    addProduct,
    removeLine,
    chooseProduct,
    applyQuick,
    lineAmount,
    orderTotal,
    payloadLines,
    mergeQuote,
    stockFor,
    restock,
    snapshot,
    restore,
  };
});
