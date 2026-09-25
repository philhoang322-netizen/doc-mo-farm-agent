/**
 * Modular Claude block: bot rules plus the top FAQ candidates.
 * Callers concatenate this after training-log examples (those win on style).
 * A parallel thread-context block can sit beside this one.
 */
const store = require('./faqStore');
const retrieve = require('./faqRetrieve');
const policy = require('./faqPolicy');

function usable(query, hit, rank, confidence) {
  if (!hit || rank !== 0) return false;
  if (confidence < policy.CONFIDENCE_MIN) return false;
  const item = hit.item;
  if (!item.enabled || item.action_flag !== 'TU_DONG' || item.verify_status !== 'verified') return false;
  if (policy.isComplaint(query) || policy.isHoursToday(query) || policy.isOrderTaking(query, item)) return false;
  if (policy.sensitiveReason(query) || policy.sensitiveReason(
    [item.group, item.product, item.question, item.answer, item.conditions].join(' ')
  )) return false;
  return true;
}

function formatBlock(rulesBody, query, hits, confidence) {
  const lines = [
    'QUY TẮC VĂN MƠ — tuân thủ khi soạn tin.',
    'Giọng các ví dụ quản lý đã sửa, nếu có ở phía trên, thắng cách diễn đạt của FAQ.',
    'Số và điều kiện chỉ lấy từ mục được đánh dấu DÙNG. Mục KHÔNG DÙNG không được đưa vào tin khách.',
    'Được chỉnh câu. Không đổi số, điều kiện, hay chính sách.',
    'Không hỏi lại điều câu trả lời DÙNG đã nói.',
    'Không xin và không nhắc số điện thoại hay địa chỉ.',
    'Không viết khối [Người duyệt].',
    String(rulesBody || '').trim(),
    'CÁC MỤC FAQ GẦN NHẤT (tối đa 5).',
  ];
  if (!hits.length) {
    lines.push('Không có mục khớp. Không bịa. Nhờ người trực xem.');
    return `\n\n${lines.filter(Boolean).join('\n')}`;
  }
  hits.forEach((hit, index) => {
    const item = hit.item;
    const allow = usable(query, hit, index, confidence);
    const bits = [
      `#${index + 1} ${item.code} ${allow ? 'DÙNG' : 'KHÔNG DÙNG'}`,
      `Nhóm: ${item.group || '—'} | Sản phẩm: ${item.product || '—'}`,
      `Câu hỏi: ${item.question}`,
      item.variants ? `Cách hỏi khác: ${item.variants}` : '',
      item.conditions ? `Điều kiện: ${item.conditions}` : '',
      `Cờ: ${item.action_flag} | Xác minh: ${item.verify_status}`,
    ];
    if (allow) bits.push(`Trả lời: ${item.answer}`);
    else bits.push('Trả lời không đưa vào prompt vì chưa được phép nêu với khách.');
    lines.push(bits.filter(Boolean).join('\n'));
  });
  return `\n\n${lines.filter(Boolean).join('\n\n')}`;
}

/**
 * @param {string} userMessage
 * @returns {Promise<string>} empty when no enabled FAQ rows exist
 */
async function promptBlock(userMessage) {
  const items = await store.enabledItems();
  if (!items.length) return '';
  const rules = await store.currentRules();
  const hits = retrieve.search(items, userMessage, 5);
  const confidence = retrieve.confidence(hits[0], hits[1]);
  return formatBlock(rules.body, userMessage, hits, confidence);
}

module.exports = { promptBlock, formatBlock, usable };
