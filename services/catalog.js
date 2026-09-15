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

const INLINE_LIMIT = 40; // products we can afford to list in full

function line(p) {
  const price = Number(p.sale_price || p.base_price).toLocaleString('vi');
  const sale = p.sale_price ? ` (đang giảm từ ${Number(p.base_price).toLocaleString('vi')}đ)` : '';
  const low = p.stock_qty != null && p.stock_qty > 0 && p.stock_qty <= 5
    ? ' — sắp hết hàng' : '';
  return `- ${p.name_vi} (${p.sku}): ${price}đ/${p.unit}${sale}${low}`;
}

/**
 * The block injected into the system prompt.
 *
 * A farm with a few dozen products can carry its whole price list in every
 * message. With several hundred that would cost thousands of tokens per reply
 * and bury the useful context, so past a threshold the agent gets a map of the
 * categories — what exists, roughly what it costs — and looks up the exact
 * item with search_products. It must never quote a price from memory.
 */
function promptBlock() {
  touch();
  const all = rows();

  if (all.length <= INLINE_LIMIT) {
    return `\nSản phẩm Doc Mo Farm (bảng giá chính thức, luôn dùng con số này):\n` +
           all.map(line).join('\n');
  }

  const byCat = new Map();
  for (const p of all) {
    const c = p.category || 'Khác';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }

  const summary = [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, list]) => {
      const prices = list.map(p => Number(p.sale_price || p.base_price)).filter(n => n > 0);
      const lo = Math.min(...prices), hi = Math.max(...prices);
      const examples = list.slice(0, 4).map(p => p.name_vi).join(', ');
      return `● ${cat} — ${list.length} mặt hàng, ${lo.toLocaleString('vi')}đ đến ${hi.toLocaleString('vi')}đ` +
             `\n   ví dụ: ${examples}${list.length > 4 ? '…' : ''}`;
    }).join('\n');

  return `
Doc Mo Farm đang bán ${all.length} mặt hàng, chia theo nhóm:
${summary}

BẮT BUỘC: bảng giá đầy đủ KHÔNG nằm ở đây. Khách hỏi bất kỳ sản phẩm nào,
hoặc hỏi giá, hoặc hỏi farm có bán gì — PHẢI gọi tool search_products trước khi trả lời.
TUYỆT ĐỐI KHÔNG đọc giá từ trí nhớ, không suy ra giá, không ước chừng.
Nếu search_products không tìm thấy, nói thật là farm không có mặt hàng đó
hoặc sẽ hỏi lại farm — đừng đoán.`;
}

module.exports = { refresh, rows, promptBlock, SEED };
