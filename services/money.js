/**
 * Hai cách viết một con số tiền, và chỗ nào dùng cách nào.
 *
 * Khi BÁO GIÁ cho khách:   320K      — ngắn, dễ đọc trên điện thoại
 * Khi LÊN ĐƠN, gửi mã QR:  320.000đ  — khách chuyển khoản theo con số này
 *
 * Trộn hai cách là sinh chuyện: khách đọc "320K" rồi chuyển 320 đồng, hoặc
 * nhân viên đối soát thấy số lẻ không khớp. Nên viết tắt K chỉ được phép
 * trong câu chào giá; mọi chỗ dính tới tiền thật đều gọi chinhXac().
 *
 * Số không tròn nghìn thì không viết tắt: 2.500đ/gram giữ nguyên, vì "2.5K"
 * vừa khó đọc vừa dễ hiểu nhầm.
 */

/** Con số đầy đủ, dùng cho đơn hàng và chuyển khoản. */
function chinhXac(n) {
  return `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
}

/** Con số rút gọn, chỉ dùng khi báo giá trong câu chat. */
function baoGia(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1000 && v % 1000 === 0) return `${(v / 1000).toLocaleString('vi-VN')}K`;
  return chinhXac(v);
}

/** "320K/chai" — dạng farm hay dùng khi khách hỏi giá một món. */
function donGia(p) {
  if (!p) return '';
  const gia = Number(p.sale_price || p.base_price);
  const don = p.unit ? `/${p.unit}` : '';
  if (p.sale_price) {
    return `${baoGia(gia)}${don} (giá gốc ${baoGia(p.base_price)}, đang giảm)`;
  }
  return `${baoGia(gia)}${don}`;
}

/**
 * Điền giá vào câu trả lời FAQ.
 *
 *   {{gia}}     → luôn thay bằng đơn giá
 *   ({{gia1}})  → chỉ thay lần đầu; những lần sau bỏ luôn cả dấu ngoặc
 *
 * Không tìm thấy sản phẩm thì bỏ ô trống đi, không để lại {{gia}} trong tin
 * nhắn và cũng không đoán một con số nào khác.
 */
function dienGia(text, product, daBaoGia = false) {
  let s = String(text || '');
  if (!s.includes('{{gia')) return s;

  const gia = product ? donGia(product) : '';

  // ({{gia1}}) — cả cụm, kể cả khoảng trắng đứng trước, để khi bỏ đi câu
  // không còn thừa dấu cách hay dấu ngoặc rỗng.
  s = s.replace(/\s*\(\{\{gia1\}\}\)/g, (gia && !daBaoGia) ? ` (${gia})` : '');
  s = s.replace(/\s*\(\{\{gia\}\}\)/g, gia ? ` (${gia})` : '');
  s = s.replace(/\{\{gia1?\}\}/g, gia);

  // Nếu không có giá, câu "X giá  ạ." sẽ hụt — dọn lại khoảng trắng thừa.
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
}

/** Câu trả lời này có chỗ điền giá không? */
function coOGia(text) {
  return /\{\{gia1?\}\}/.test(String(text || ''));
}

module.exports = { chinhXac, baoGia, donGia, dienGia, coOGia };
