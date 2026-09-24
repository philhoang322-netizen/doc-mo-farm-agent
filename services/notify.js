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

async function sendTo(chatId, text) {
  if (!chatId) return false;
  try {
    return !!(await botService.sendMessage(chatId, text));
  } catch (e) {
    console.error('Owner notify failed:', e.message);
    return false;
  }
}

async function send(text) {
  const chatId = ownerChatId();
  if (!chatId) {
    console.warn('⚠️  ALERT_BOT_CHAT_ID not set — owner message dropped:\n' + text);
    return false;
  }
  return sendTo(chatId, text);
}

/**
 * Internal alert. `chatIds` are Zalo Bot chat ids (the only notify channel
 * in this repo — there is no Telegram sender). Empty list logs and drops.
 */
async function deliver(text, chatIds) {
  const ids = [...new Set((chatIds || []).filter(Boolean).map(String))];
  if (!ids.length) {
    console.warn('⚠️  No alert chat — owner message dropped:\n' + text);
    return false;
  }
  let ok = false;
  for (const id of ids) {
    if (await sendTo(id, text)) ok = true;
  }
  return ok;
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
function assigneeTargets(info) {
  const ids = [];
  const owner = ownerChatId();
  const staff = info?.assignee?.notify_target;
  if (staff && staff !== 'owner') ids.push(String(staff));
  if (owner && !ids.includes(String(owner))) ids.push(String(owner));
  return ids;
}

function assigneeLines(info) {
  const a = info?.assignee;
  if (!a) return [];
  const who = a.assignee_name || 'người trực';
  const how = {
    online: 'đang trong ca, ưu tiên vì online',
    on_shift: 'đang trong ca',
    next_shift: 'ca kế tiếp (hiện ngoài giờ)',
    owner: 'chủ farm — chưa có ca nào phủ giờ này',
  }[a.mode] || a.mode || '';
  const lines = ['', `➡️ Giao cho: ${who}${how ? ` · ${how}` : ''}`];
  if (a.window_label) lines.push(`🕐 Ca: ${a.window_label}`);
  if (a.mode === 'next_shift' && a.next_label) lines.push(`⏳ Ca kế bắt đầu ${a.next_label}`);
  if (a.label) lines.push(`🏷 ${a.label}`);
  return lines;
}

async function handoff(info, customer, lastMessage) {
  // Existing pause/handoff callers land here. Assign a person on shift
  // first, then send the card below. _fromRoster skips that so escalate()
  // does not loop.
  if (!info?._fromRoster) {
    try {
      const handover = require('./handover');
      return handover.escalate({
        reason: info?.reason,
        urgency: info?.urgency || 'normal',
        externalId: info?.externalId,
        customer,
        lastMessage,
        source: info?.source || 'handoff',
        ticketStatus: info?.ticketStatus || info?.ticket_status,
        needsHuman: info?.needsHuman,
        wantsHuman: info?.wantsHuman,
        claim: info?.claim,
        handoff: info?.handoff,
        force: true,
      });
    } catch (e) {
      console.error('Roster handover failed, sending owner card anyway:', e.message);
    }
  }

  if (!info) return false;
  const flag = info.urgency === 'high' ? '🔴 GẤP' : '🟡';
  const name = customer?.display_name || customer?.full_name || 'Khách';
  const call = customer?.gender === 'male' ? 'anh'
    : customer?.gender === 'female' ? 'chị' : '';

  const lines = [
    `${flag} Khách cần gặp người thật`,
    ...assigneeLines(info),
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
  if (info.botPaused) {
    lines.push('', 'Bot đã tạm dừng với khách này.', `Trả lời xong, nhắn: /mo ${info.externalId}`);
  } else {
    lines.push('', 'Tin đang chờ duyệt trên /admin. Bot không tự gửi, và không tạm dừng.');
  }
  const text = lines.join('\n');
  if (info?._fromRoster) return deliver(text, assigneeTargets(info));
  return send(text);
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
    } else if (o.kiot.blocked) {
      lines.push(
        '',
        `⚠️ Chưa đẩy KiotViet: ${o.kiot.error}`,
        'Cần Sales đối soát tồn kho trước khi chốt. Chưa trừ kho, chưa xuất hoá đơn.'
      );
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

module.exports = { send, sendTo, deliver, handoff, newOrder, ownerChatId, money };
