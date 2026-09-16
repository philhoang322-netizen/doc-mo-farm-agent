/**
 * Khuyến mãi — đặt ở /admin, bot đọc và nhắc khách.
 *
 * Hai loại trong cùng một bảng: dòng có sku là khuyến mãi của riêng một sản
 * phẩm, dòng để trống sku là chính sách chung cho cả farm. Bot luôn thấy các
 * chính sách chung; khuyến mãi riêng chỉ nhắc khi khách đang hỏi món đó.
 *
 * Ngày bắt đầu và ngày kết thúc là thứ giữ cho farm khỏi phải nhớ: chương
 * trình Tết tự hết hiệu lực sau Tết, không ai phải vào tắt tay và cũng không
 * còn cảnh bot mời khuyến mãi đã kết thúc từ tháng trước.
 */
const db = require('./database');

const TTL_MS = 60 * 1000;
let cache = { at: 0, rows: [] };

async function refresh() {
  if (!db.DB_ENABLED) return [];
  try {
    const r = await db.pool.query(
      `SELECT p.sku, p.title, p.detail, p.starts_on, p.ends_on,
              pr.name_vi
         FROM promotions p
         LEFT JOIN products pr ON pr.sku = p.sku
        WHERE p.is_active = TRUE
          AND (p.starts_on IS NULL OR p.starts_on <= CURRENT_DATE)
          AND (p.ends_on   IS NULL OR p.ends_on   >= CURRENT_DATE)
        ORDER BY p.sku NULLS FIRST, p.created_at`
    );
    cache = { at: Date.now(), rows: r.rows };
  } catch (e) {
    if (!/promotions/.test(e.message)) console.warn('Promo refresh failed:', e.message);
  }
  return cache.rows;
}

function touch() {
  if (Date.now() - cache.at > TTL_MS) refresh().catch(() => {});
}

/** Chính sách chung — lúc nào cũng đúng, nên luôn nằm trong prompt. */
function chung() {
  touch();
  return cache.rows.filter(r => !r.sku);
}

/** Khuyến mãi của một sản phẩm cụ thể. */
function theoSku(sku) {
  touch();
  if (!sku) return [];
  return cache.rows.filter(r => r.sku === sku);
}

/**
 * Khối chèn vào prompt.
 *
 * Chỉ chính sách chung. Khuyến mãi từng sản phẩm không vào đây — với vài chục
 * sản phẩm thì danh sách đó dài hơn cả phần còn lại của prompt, và bot sẽ đem
 * khuyến mãi dầu gội ra mời người đang hỏi xúc xích. Bot lấy khuyến mãi riêng
 * qua tool search_products, đúng lúc khách hỏi đúng món.
 */
function promptBlock() {
  const g = chung();
  const rieng = cache.rows.filter(r => r.sku).length;
  if (!g.length && !rieng) return '';

  const parts = [];
  if (g.length) {
    parts.push('\nKHUYẾN MÃI ĐANG CHẠY (áp dụng cho mọi đơn, nói đúng nguyên văn, không tự thêm bớt):');
    parts.push(g.map(r => `- ${r.detail}`).join('\n'));
  }
  if (rieng) {
    parts.push(
      `\nNgoài ra ${rieng} sản phẩm có khuyến mãi riêng. Chúng nằm trong kết quả ` +
      'tool search_products. Không tự nghĩ ra khuyến mãi nào khác, không hứa giảm giá ' +
      'nếu kết quả tra cứu không ghi.'
    );
  }
  return parts.join('\n');
}

module.exports = { refresh, chung, theoSku, promptBlock };
