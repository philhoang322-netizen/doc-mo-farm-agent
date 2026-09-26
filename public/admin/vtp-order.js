/**
 * Viettel Post order handoff.
 * There is no live Viettel Post connection in this build. A tap copies the
 * order. createOrder is the only plug-in point for a later API call, and it
 * stays unwired unless VIETTELPOST_ENABLED and VIETTELPOST_TOKEN are both set.
 * Nothing here sends HTTP.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.vtpOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ADDRESS_KEYS = ['province', 'district', 'ward', 'street'];

  function on(value) {
    const flag = String(value || '').trim().toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
  }

  function enabled(env) {
    const src = env || {};
    const token = String(src.VIETTELPOST_TOKEN || src.token || '').trim();
    return on(src.VIETTELPOST_ENABLED) && token.length > 0;
  }

  function partId(src, key) {
    if (!src) return '';
    if (src[key + 'Id']) return String(src[key + 'Id']);
    if (src[key] && src[key].id) return String(src[key].id);
    return '';
  }

  function addressLine(address) {
    const src = address || {};
    const ready = String(src.line || '').trim();
    if (ready) return ready;
    const ward = src.wardName || src.wardText || (src.ward && src.ward.label) || '';
    const district = src.districtName || src.districtText || (src.district && src.district.label) || '';
    const province = src.provinceName || src.provinceText || (src.province && src.province.label) || '';
    return [src.detail, ward, district, province]
      .map(part => String(part || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  function itemsOf(order) {
    return (order && order.items || []).filter(item => {
      const name = String((item && (item.name || item.sku)) || '').trim();
      const qty = Number(item && item.quantity);
      return name && Number.isFinite(qty) && qty > 0;
    }).map(item => ({
      name: String(item.name || item.sku).trim(),
      sku: String(item.sku || '').trim(),
      quantity: Number(item.quantity),
    }));
  }

  function paymentStatus(order) {
    const raw = String((order && (order.paymentStatus || order.payment_status)) || 'chua_tt')
      .trim()
      .toLowerCase();
    if (raw === 'da_tt' || raw === 'đã tt' || raw === 'da tt') return 'da_tt';
    if (raw === 'mot_phan' || raw === 'một phần') return 'mot_phan';
    return 'chua_tt';
  }

  function codAmount(order) {
    if (paymentStatus(order) !== 'chua_tt') return 0;
    const total = Number(order && order.total);
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.round(total);
  }

  function phoneOk(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 15;
  }

  function missingParts(order) {
    const src = order || {};
    const address = src.address || {};
    const missing = [];
    ADDRESS_KEYS.forEach(key => {
      if (key === 'street') {
        if (!String(address.detail || '').trim()) missing.push('street');
        return;
      }
      if (!partId(address, key)) missing.push(key);
    });
    if (!String(src.receiver || src.name || '').trim()) missing.push('name');
    if (!phoneOk(src.phone)) missing.push('phone');
    if (!itemsOf(src).length) missing.push('items');
    return missing;
  }

  function clipboardText(order) {
    const src = order || {};
    const lines = [
      'Người nhận: ' + String(src.receiver || src.name || '').trim(),
      'SĐT: ' + String(src.phone || '').trim(),
      'Địa chỉ: ' + addressLine(src.address),
    ];
    itemsOf(src).forEach(item => {
      lines.push('Hàng: ' + item.name + ' × ' + item.quantity);
    });
    lines.push('COD: ' + codAmount(src));
    lines.push('Ghi chú: ' + String(src.note || '').trim());
    return lines.join('\n');
  }

  function apiPayload(order) {
    const src = order || {};
    const address = src.address || {};
    return {
      receiverName: String(src.receiver || src.name || '').trim(),
      receiverPhone: String(src.phone || '').trim(),
      address: addressLine(address),
      provinceId: partId(address, 'province'),
      districtId: partId(address, 'district'),
      wardId: partId(address, 'ward'),
      items: itemsOf(src),
      cod: codAmount(src),
      note: String(src.note || '').trim(),
    };
  }

  function plan(order, env) {
    const missing = missingParts(order);
    if (missing.length) {
      return { ok: false, mode: 'blocked', missing, focus: missing[0], text: '' };
    }
    const text = clipboardText(order);
    if (!enabled(env)) return { ok: true, mode: 'clipboard', missing: [], focus: '', text };
    return { ok: true, mode: 'api', missing: [], focus: '', text, payload: apiPayload(order) };
  }

  /**
   * Live createOrder plug-in. Call only after the VTP button is pressed.
   * Without the env flag this returns the clipboard text and does not call transport.
   * With the flag, transport must be supplied by the future client. This function
   * does not call fetch.
   */
  async function createOrder(order, env, transport) {
    const decided = plan(order, env);
    if (!decided.ok) {
      const err = new Error('Thiếu thông tin đơn VTP');
      err.code = 'VTP_INCOMPLETE';
      err.missing = decided.missing;
      throw err;
    }
    if (decided.mode !== 'api') return { mode: 'clipboard', text: decided.text };
    if (typeof transport !== 'function') {
      const err = new Error('Viettel Post chưa nối API');
      err.code = 'VTP_NOT_WIRED';
      throw err;
    }
    const result = await transport(decided.payload);
    return { mode: 'api', result };
  }

  return {
    enabled,
    missingParts,
    codAmount,
    paymentStatus,
    clipboardText,
    apiPayload,
    plan,
    createOrder,
  };
});
