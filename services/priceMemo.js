/**
 * Nhớ đã báo giá món nào cho khách nào.
 *
 * Quy tắc của farm: câu trả lời kỹ thuật lần đầu thì kèm giá, các lần sau
 * thôi — trừ khi khách hỏi thẳng về giá. Muốn làm đúng thì phải nhớ, và nhớ
 * bằng lời dặn trong prompt thì lúc được lúc không. Ghi xuống bảng thì chắc.
 *
 * Ghi SAU khi tin đã gửi, và chỉ ghi món nào con số thật sự nằm trong tin
 * nhắn. Nếu ghi lúc tra cứu, gặp lúc bot diễn đạt lại rồi bỏ mất giá, khách
 * sẽ không bao giờ được nghe giá món đó nữa.
 */
const db = require('./database');

const cache = new Map(); // customerId -> { at, skus:Set }
const TTL_MS = 5 * 60 * 1000;

/** Những sku đã báo giá cho khách này. */
async function daBao(customerId) {
  if (!db.DB_ENABLED || !customerId) return new Set();
  const hit = cache.get(customerId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.skus;
  try {
    const r = await db.pool.query(
      'SELECT sku FROM price_quotes WHERE customer_id = $1', [customerId]
    );
    const skus = new Set(r.rows.map(x => x.sku));
    cache.set(customerId, { at: Date.now(), skus });
    return skus;
  } catch (e) {
    if (!/price_quotes/.test(e.message)) console.warn('priceMemo read failed:', e.message);
    return new Set();
  }
}

/** Ghi nhận đã báo giá. Im lặng khi lỗi — không đáng để hỏng một câu trả lời. */
async function ghiNhan(customerId, skus) {
  if (!db.DB_ENABLED || !customerId || !skus || !skus.length) return;
  try {
    await db.pool.query(
      `INSERT INTO price_quotes (customer_id, sku)
       SELECT $1, UNNEST($2::text[])
       ON CONFLICT (customer_id, sku) DO NOTHING`,
      [customerId, skus]
    );
    const hit = cache.get(customerId);
    if (hit) skus.forEach(s => hit.skus.add(s));
  } catch (e) {
    if (!/price_quotes/.test(e.message)) console.warn('priceMemo write failed:', e.message);
  }
}

/**
 * Đọc lại tin vừa gửi, tìm xem giá của món nào thật sự đã nói ra.
 *
 * So bằng chuỗi báo giá ("320K") và cả chuỗi đầy đủ ("320.000đ"), vì bot có
 * thể viết cách nào cũng được. Hai món cùng giá thì đánh dấu cả hai — chấp
 * nhận sai lệch đó, vì cái giá kia đúng là đã hiện ra trước mắt khách.
 */
function skusTrongTin(text, products, money) {
  const s = String(text || '');
  if (!s) return [];
  const found = [];
  for (const p of products) {
    const gia = Number(p.sale_price || p.base_price);
    if (!gia) continue;
    if (s.includes(money.baoGia(gia)) || s.includes(money.chinhXac(gia))) found.push(p.sku);
  }
  return [...new Set(found)];
}

module.exports = { daBao, ghiNhan, skusTrongTin };
