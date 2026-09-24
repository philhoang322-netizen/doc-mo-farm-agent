/**
 * Live stock gate for chốt đơn.
 *
 * Before create_order confirms, compare KiotViet sellable qty
 * (onHand − reserved, see kiotviet.getOnHand) with the requested qty and
 * STOCK_LOW_THRESHOLD (default 5 when unset, blank, or not a number ≥ 0).
 *
 *   available >= threshold and >= requested  → ok, order path continues
 *   0 < available < threshold, enough for qty → low: “sắp hết”, do not confirm
 *   available <= 0 or available < requested   → blocked: do not create the order
 *   lookup failed / SKU missing               → blocked: do not invent availability
 *
 * KiotViet off (no client id / secret / retailer) skips the check. A failed
 * lookup while it is on does not confirm.
 *
 * KIOTVIET_RETAILER is the shop code (this farm: nongsansachdn). It is read
 * from the environment by services/kiotviet.js — do not hardcode it here.
 */
const kiotviet = require('./kiotviet');

const DEFAULT_THRESHOLD = 5;

function threshold() {
  const raw = process.env.STOCK_LOW_THRESHOLD;
  if (raw == null || String(raw).trim() === '') return DEFAULT_THRESHOLD;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD;
  return n;
}

/**
 * @returns {'ok'|'low'|'blocked'|'unknown'}
 */
function classifyLine({ available, requested, threshold: limit }) {
  const need = Number(requested);
  if (!Number.isFinite(need) || need <= 0) return 'blocked';
  if (!Number.isFinite(available)) return 'unknown';
  if (available <= 0 || available < need) return 'blocked';
  if (available < limit) return 'low';
  return 'ok';
}

function combine(levels) {
  if (levels.some(level => level === 'blocked' || level === 'unknown' || level === 'error')) {
    return 'blocked';
  }
  if (levels.some(level => level === 'low')) return 'low';
  if (levels.length && levels.every(level => level === 'ok')) return 'ok';
  return 'blocked';
}

function formatQty(n) {
  if (!Number.isFinite(Number(n))) return null;
  const value = Number(n);
  if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value));
  return String(Math.round(value * 1000) / 1000);
}

function lineLabel(line) {
  return line.name || line.product_name || line.sku || 'sản phẩm';
}

/**
 * Customer-facing warning. Polite shop tone. Never claims the goods are ready
 * and never invents a quantity we did not read from KiotViet.
 */
function draftFor(assessment) {
  const lines = assessment?.lines || [];
  if (assessment?.decision === 'low') {
    const bits = lines.filter(line => line.level === 'low').map(line => {
      const have = formatQty(line.available);
      const need = formatQty(line.requested);
      if (have != null) {
        return `${lineLabel(line)} (kho còn ${have}${need ? `, mình đặt ${need}` : ''})`;
      }
      return lineLabel(line);
    });
    const what = bits.join('; ') || 'món mình chọn';
    return (
      `Dạ em vừa kiểm tồn kho, ${what} đang sắp hết hàng ạ. ` +
      `Em chưa chốt đơn giúp mình — nhân viên farm sẽ đối soát kho gấp và nhắn lại ngay khi xác nhận được số lượng 🌿\n\n` +
      `Mình muốn giữ số này hay chỉnh lại, cứ nhắn em nha.`
    );
  }

  if (assessment?.decision === 'blocked') {
    if (!lines.length) {
      return 'Dạ em chưa nhận đủ món và số lượng để chốt đơn ạ. Mình cho em xin lại tên sản phẩm và số lượng nha 🌿';
    }
    const gone = lines.filter(line => line.level === 'blocked');
    const unknown = lines.filter(line => line.level === 'unknown' || line.level === 'error');
    if (!gone.length) {
      const names = (unknown.length ? unknown : lines).map(lineLabel).join(', ');
      return (
        `Dạ em chưa đối được tồn kho thực tế của ${names} lúc này ạ. ` +
        `Em chưa chốt đơn và chưa giữ hàng — nhân viên farm sẽ kiểm kho gấp rồi xác nhận lại với mình ngay 🌿\n\n` +
        `Mình cho em xin giữ yêu cầu này để farm ưu tiên kiểm giúp nha.`
      );
    }
    const bits = gone.map(line => {
      const have = formatQty(line.available);
      const need = formatQty(line.requested);
      if (line.available === 0) return `${lineLabel(line)} hiện đang hết hàng`;
      if (have != null && need != null) {
        return `${lineLabel(line)} hiện còn ${have}, chưa đủ ${need} mình đặt`;
      }
      return `${lineLabel(line)} hiện chưa đủ số lượng mình đặt`;
    });
    const extra = unknown.length
      ? ` Em cũng chưa đối được tồn của ${unknown.map(lineLabel).join(', ')}.`
      : '';
    return (
      `Dạ em kiểm kho thì ${bits.join('; ')} ạ.${extra} ` +
      `Em chưa tạo đơn và chưa xác nhận giữ hàng — nhân viên farm sẽ đối soát tồn kho gấp rồi báo lại mình 🌿\n\n` +
      `Mình muốn chỉnh số lượng, hay chờ farm xác nhận giúp ạ?`
    );
  }
  return null;
}

function summaryFor(assessment) {
  const limit = assessment?.threshold ?? threshold();
  const rows = (assessment?.lines || []).map(line => {
    const have = line.available == null ? 'không rõ' : formatQty(line.available);
    return `${line.sku || lineLabel(line)}: tồn ${have}, đặt ${formatQty(line.requested) || '?'} (${line.level})`;
  });
  const title = assessment?.decision === 'low'
    ? `Sắp hết hàng (ngưỡng ${limit}) — chưa chốt đơn`
    : `Không đủ tồn — đã chặn tạo đơn`;
  return rows.length ? `${title}. ${rows.join('; ')}` : title;
}

/**
 * @param {Array<{sku?:string, product_name?:string, quantity?:number}>} items
 * @returns {Promise<{decision:'ok'|'low'|'blocked'|'skipped', threshold:number,
 *   lines:object[], draftReply:string|null, summary:string|null}>}
 */
async function assessItems(items) {
  const limit = threshold();
  const linesIn = Array.isArray(items) ? items : [];
  if (!linesIn.length) {
    const assessment = {
      decision: 'blocked',
      threshold: limit,
      lines: [],
      draftReply: null,
      summary: 'Đơn không có dòng hàng — chưa tạo đơn.',
    };
    assessment.draftReply = draftFor(assessment);
    return assessment;
  }
  if (!kiotviet.enabled()) {
    return { decision: 'skipped', threshold: limit, lines: [], draftReply: null, summary: null };
  }

  const lines = [];
  for (const item of linesIn) {
    const requested = Number(item.quantity);
    let lookup;
    try {
      lookup = await kiotviet.getOnHand({ sku: item.sku, name: item.product_name });
    } catch (e) {
      lookup = { ok: false, reason: 'lookup_failed', error: e.message };
    }
    const known = !!(lookup && lookup.ok && Number.isFinite(Number(lookup.available)));
    const available = known ? Number(lookup.available) : null;
    const level = known
      ? classifyLine({ available, requested, threshold: limit })
      : 'unknown';
    lines.push({
      sku: item.sku || lookup?.sku || null,
      name: lookup?.name || item.product_name || item.sku || 'sản phẩm',
      product_name: item.product_name || null,
      requested,
      onHand: known ? Number(lookup.onHand) : null,
      reserved: known ? Number(lookup.reserved) : null,
      available,
      level,
      reason: known ? null : (lookup?.reason || 'lookup_failed'),
    });
  }

  const decision = combine(lines.map(line => line.level));
  const assessment = { decision, threshold: limit, lines, draftReply: null, summary: null };
  assessment.draftReply = draftFor(assessment);
  assessment.summary = summaryFor(assessment);
  return assessment;
}

module.exports = {
  threshold,
  classifyLine,
  assessItems,
  draftFor,
  summaryFor,
  DEFAULT_THRESHOLD,
};
