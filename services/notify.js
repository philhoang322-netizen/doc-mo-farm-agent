/**
 * Messages addressed to the farm owner (not to customers).
 *
 * Delivered over the Bot channel: it is free, has no 7-day messaging window,
 * and stays reachable even when the OA token is the thing that broke.
 */
const botService = require('./zaloBotService');

function ownerChatId() {
  return process.env.ALERT_BOT_CHAT_ID || null;
}

async function send(text) {
  const chatId = ownerChatId();
  if (!chatId) {
    console.warn('⚠️  ALERT_BOT_CHAT_ID not set — owner message dropped:\n' + text);
    return false;
  }
  try {
    return !!(await botService.sendMessage(chatId, text));
  } catch (e) {
    console.error('Owner notify failed:', e.message);
    return false;
  }
}

function money(n) {
  return Number(n || 0).toLocaleString('vi') + 'đ';
}

/**
 * A customer asked for a human — the farm needs to step in.
 *
 * This is a handover card, not an alert. Whoever picks it up should be able to
 * answer without scrolling back through the thread or asking the customer to
 * repeat themselves, which is the fastest way to lose someone who was already
 * unhappy enough to ask for a person.
 */
async function handoff(info, customer, lastMessage) {
  const flag = info.urgency === 'high' ? '🔴 GẤP' : '🟡';
  const name = customer?.display_name || customer?.full_name || 'Khách';
  const call = customer?.gender === 'male' ? 'anh'
    : customer?.gender === 'female' ? 'chị' : '';

  const lines = [
    `${flag} Khách cần gặp người thật`,
    '',
    `👤 ${call ? call + ' ' : ''}${name}${customer?.phone ? ` · ${customer.phone}` : ' · chưa có số'}`,
  ];

  if (customer?.customer_tier && customer.customer_tier !== 'new') {
    lines.push(`⭐ Hạng: ${customer.customer_tier}`);
  }
  if (customer?.full_address) lines.push(`📍 ${customer.full_address}`);

  lines.push('', `💬 Khách vừa nhắn:`, `"${String(lastMessage || '').slice(0, 250)}"`);

  // Everything the conversation already established — the point of the card.
  if (customer?.convo_summary) {
    lines.push('', '📋 Đã trao đổi:', customer.convo_summary.slice(0, 600));
  }

  lines.push('', `📌 Lý do chuyển: ${info.reason}`);
  lines.push('', 'Bot đã tạm dừng với khách này.', `Trả lời xong, nhắn: /mo ${info.externalId}`);
  return send(lines.join('\n'));
}

/** A new order was created by the agent. */
async function newOrder(o) {
  const items = (o.items || [])
    .map(i => `  • ${i.product_name} ×${i.quantity} — ${money(i.quantity * i.unit_price)}`)
    .join('\n');
  const lines = [
    `🛒 ĐƠN MỚI — ${o.order_number}`,
    '',
    `👤 ${o.customerName}${o.phone ? ` · ${o.phone}` : ''}`,
    items,
    `💰 Tổng: ${money(o.total)} · ${String(o.payment).toUpperCase()}`,
  ];
  if (o.address) lines.push(`📍 ${o.address}`);
  if (o.note) lines.push(`📝 ${o.note}`);

  if (o.kiot) {
    if (o.kiot.ok) {
      lines.push('', `🧾 KiotViet: đã tạo đơn ${o.kiot.kiotOrderCode || ''}`.trim());
    } else if (o.kiot.missing?.length) {
      lines.push(
        '',
        `⚠️ Chưa đẩy được sang KiotViet — thiếu hàng hoá: ${o.kiot.missing.join(', ')}`,
        'Thêm sản phẩm vào KiotViet với đúng mã, rồi tạo đơn tay lần này.'
      );
    } else if (o.kiot.error && o.kiot.error !== 'KiotViet tắt') {
      lines.push('', `⚠️ KiotViet lỗi: ${o.kiot.error}`, 'Cần tạo đơn tay trên KiotViet.');
    }
  }
  return send(lines.join('\n'));
}

module.exports = { send, handoff, newOrder, ownerChatId, money };
