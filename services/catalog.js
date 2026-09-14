/**
 * Product catalog, read from the database.
 *
 * The price list used to be hardcoded in the system prompt, which meant a
 * price change needed a code edit and a deploy — and the prompt could quietly
 * disagree with the `products` table the order tool reads from. One source of
 * truth now: the table. Cached briefly so we don't hit the DB on every message.
 */
const db = require('./database');

const TTL_MS = 60 * 1000;
let cache = { at: 0, rows: [] };

// Fallback for the first boot / DB outage, so the bot still knows the shop.
const SEED = [
  { name_vi: 'Dầu gội cao cấp', sku: 'DMF-SHP-001', base_price: 180000, unit: 'chai' },
  { name_vi: 'Dầu tắm', sku: 'DMF-BTH-001', base_price: 120000, unit: 'chai' },
  { name_vi: 'Xúc xích phô mai', sku: 'DMF-SCH-001', base_price: 85000, unit: 'gói' },
  { name_vi: 'Xúc xích tỏi', sku: 'DMF-SCG-001', base_price: 85000, unit: 'gói' },
  { name_vi: 'Nước gừng lên men', sku: 'DMF-NGM-001', base_price: 95000, unit: 'chai' },
  { name_vi: 'Nước nghệ lên men', sku: 'DMF-NNG-001', base_price: 95000, unit: 'chai' },
  { name_vi: 'Kẹo chuối', sku: 'DMF-KC-001', base_price: 45000, unit: 'gói' },
  { name_vi: 'Chuối sấy dẻo', sku: 'DMF-CS-001', base_price: 65000, unit: 'gói' },
];

/** Refresh the cache from the database. Safe to call often. */
async function refresh() {
  if (!db.DB_ENABLED) {
    cache = { at: Date.now(), rows: SEED };
    return cache.rows;
  }
  try {
    const r = await db.pool.query(
      `SELECT sku, name_vi, description, base_price, sale_price, unit, stock_qty, is_available
       FROM products WHERE is_available = TRUE
       ORDER BY category, base_price DESC`
    );
    cache = { at: Date.now(), rows: r.rows.length ? r.rows : SEED };
  } catch (e) {
    console.warn('Catalog refresh failed, using last known list:', e.message);
    if (!cache.rows.length) cache = { at: Date.now(), rows: SEED };
  }
  return cache.rows;
}

function rows() {
  return cache.rows.length ? cache.rows : SEED;
}

/** Kick a background refresh if the cache is stale; never blocks a reply. */
function touch() {
  if (Date.now() - cache.at > TTL_MS) refresh().catch(() => {});
}

/** The block injected into the system prompt. */
function promptBlock() {
  touch();
  const lines = rows().map(p => {
    const price = Number(p.sale_price || p.base_price).toLocaleString('vi');
    const sale = p.sale_price ? ` (đang giảm từ ${Number(p.base_price).toLocaleString('vi')}đ)` : '';
    const low = p.stock_qty != null && p.stock_qty > 0 && p.stock_qty <= 5
      ? ' — sắp hết hàng' : '';
    return `- ${p.name_vi} (${p.sku}): ${price}đ/${p.unit}${sale}${low}`;
  });
  return `\nSản phẩm Doc Mo Farm (bảng giá chính thức, luôn dùng con số này):\n${lines.join('\n')}`;
}

module.exports = { refresh, rows, promptBlock, SEED };
