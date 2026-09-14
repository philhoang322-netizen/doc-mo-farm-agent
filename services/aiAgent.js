require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const knowledge = require('./knowledge');
const ops = require('./ops');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SYSTEM PROMPT BUILDER
// Injects customer memory + context into every conversation
// ============================================================
function buildSystemPrompt(customer, memories, recentOrders, preferences) {
  const productCatalog = `
Sản phẩm Doc Mo Farm:
- Dầu gội cao cấp (DMF-SHP-001): 180.000đ/chai
- Dầu tắm (DMF-BTH-001): 120.000đ/chai
- Xúc xích phô mai (DMF-SCH-001): 85.000đ/gói
- Xúc xích tỏi (DMF-SCG-001): 85.000đ/gói
- Nước gừng lên men (DMF-NGM-001): 95.000đ/chai
- Nước nghệ lên men (DMF-NNG-001): 95.000đ/chai
- Kẹo chuối (DMF-KC-001): 45.000đ/gói
- Chuối sấy dẻo (DMF-CS-001): 65.000đ/gói`;

  let customerCtx = '';
  if (customer) {
    customerCtx = `\nKhách hàng: ${customer.display_name || customer.full_name || 'Khách'}`;
    if (customer.customer_tier !== 'new') {
      customerCtx += ` | Hạng: ${customer.customer_tier}`;
    }
  }

  let memoriesCtx = '';
  if (memories && memories.length > 0) {
    const lines = memories.map(m => `  - ${m.memory_key}: ${m.memory_value}`).join('\n');
    memoriesCtx = `\nĐiều bạn nhớ về khách này:\n${lines}`;
  }

  let ordersCtx = '';
  if (recentOrders && recentOrders.length > 0) {
    const lines = recentOrders.map(o =>
      `  - ${o.order_number || o.id}: ${o.total_amount?.toLocaleString('vi')}đ (${o.status})`
    ).join('\n');
    ordersCtx = `\nĐơn hàng gần đây:\n${lines}`;
  }

  let prefsCtx = '';
  if (preferences && preferences.length > 0) {
    const lines = preferences.map(p => `  - ${p.preference_key}: ${p.preference_value}`).join('\n');
    prefsCtx = `\nSở thích đã biết:\n${lines}`;
  }

  return `Bạn là trợ lý bán hàng thân thiện của Doc Mo Farm - một eco-farm sản xuất sản phẩm organic thủ công.

NGUYÊN TẮC GIAO TIẾP:
- Luôn xưng "dạ", gọi khách là "mình", "bạn" hoặc "cô/chú" tùy ngữ cảnh
- Trả lời ngắn gọn, dễ đọc trên Zalo (không quá 3-4 dòng mỗi đoạn)
- Thân thiện, ấm áp như người bán hàng tại chợ, không máy móc
- Không hứa hẹn điều trị bệnh
- Dùng emoji nhẹ nhàng khi phù hợp 🌿

${productCatalog}
${customerCtx}${memoriesCtx}${ordersCtx}${prefsCtx}${knowledge.systemPromptBlock()}

KHI KHÁCH ĐẶT HÀNG: Gọi tool create_order để tạo đơn hàng.
KHI KHÁCH HỎI SẢN PHẨM: Gọi tool search_products để tìm.
KHI KHÁCH HỎI CHI TIẾT (thành phần, cách dùng, bảo quản, ai dùng được, vì sao có cặn...): Gọi tool search_knowledge.
KHI BIẾT THÔNG TIN MỚI VỀ KHÁCH (tên, số điện thoại, địa chỉ, sở thích): Gọi tool save_memory.
SỐ ĐIỆN THOẠI: nếu khách hỏi mua hoặc quan tâm nghiêm túc, hãy hỏi số điện thoại một cách
tự nhiên (để farm tiện liên hệ và giữ lịch sử đơn). Lưu ngay bằng save_memory với key "so_dien_thoai".

QUAN TRỌNG: Chỉ nói những gì có trong tài liệu trên. Không tự nghĩ ra công dụng,
thành phần hay con số. Không hứa chữa bệnh. Nếu không biết, nói thật là sẽ hỏi lại farm.`;
}

// ============================================================
// CLAUDE TOOLS
// ============================================================
const tools = [
  {
    name: 'search_products',
    description: 'Tìm kiếm sản phẩm theo tên hoặc danh mục',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tên hoặc loại sản phẩm cần tìm' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_knowledge',
    description:
      'Tra cứu tài liệu sản phẩm của farm (FAQ, thành phần, cách dùng, bảo quản, đối tượng phù hợp). Dùng khi khách hỏi chi tiết vượt ngoài bảng giá.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nội dung cần tra cứu, vd: "bảo quản lạnh", "có đường không"' }
      },
      required: ['query']
    }
  },
  {
    name: 'create_order',
    description: 'Tạo đơn hàng mới cho khách',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_name: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' }
            },
            required: ['product_name', 'quantity', 'unit_price']
          },
          description: 'Danh sách sản phẩm đặt mua'
        },
        customer_phone: { type: 'string', description: 'Số điện thoại khách (rất nên hỏi khi chốt đơn)' },
        delivery_address: { type: 'string', description: 'Địa chỉ giao hàng' },
        customer_note: { type: 'string', description: 'Ghi chú của khách' },
        payment_method: {
          type: 'string',
          enum: ['cod', 'bank_transfer', 'momo', 'zalo_pay'],
          description: 'Phương thức thanh toán'
        }
      },
      required: ['items']
    }
  },
  {
    name: 'save_memory',
    description: 'Lưu thông tin quan trọng về khách hàng để nhớ cho lần sau',
    input_schema: {
      type: 'object',
      properties: {
        memory_type: {
          type: 'string',
          enum: ['fact', 'preference', 'order_pattern', 'complaint', 'life_event', 'relationship', 'financial'],
          description: 'Loại thông tin'
        },
        memory_key: { type: 'string', description: 'Tên ngắn của thông tin (vd: ten_khach, so_dien_thoai)' },
        memory_value: { type: 'string', description: 'Nội dung thông tin' },
        importance: { type: 'number', description: 'Độ quan trọng 1-5', minimum: 1, maximum: 5 }
      },
      required: ['memory_type', 'memory_key', 'memory_value']
    }
  },
  {
    name: 'request_human',
    description:
      'Chuyển cuộc trò chuyện cho người thật của farm. Dùng khi khách yêu cầu gặp người, khiếu nại, ' +
      'hỏi việc ngoài khả năng (đổi trả, hoá đơn, hợp tác, giá sỉ), hoặc khi bạn đã trả lời 2 lần mà khách vẫn chưa hài lòng.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Lý do ngắn gọn để farm nắm tình hình' },
        urgency: { type: 'string', enum: ['normal', 'high'], description: 'high nếu khách bực hoặc việc gấp' }
      },
      required: ['reason']
    }
  },
  {
    name: 'get_order_status',
    description: 'Kiểm tra trạng thái đơn hàng của khách',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Số đơn hàng (vd: ORD-2025-000001)' }
      }
    }
  }
];

// ============================================================
// TOOL EXECUTION
// ============================================================
// Set by request_human during a turn, read once the reply is built so the
// caller can notify the farm and mute the bot for that customer.
const pendingHandoff = new Map();
const pendingOrder = new Map();

async function executeTool(toolName, toolInput, customer, zaloUserId) {
  try {
    if (toolName === 'request_human') {
      const info = {
        reason: toolInput.reason || 'Khách muốn gặp người thật',
        urgency: toolInput.urgency || 'normal',
        customerId: customer ? customer.id : null,
        externalId: zaloUserId,
      };
      pendingHandoff.set(zaloUserId, info);
      if (customer && db.DB_ENABLED) {
        await db.pauseBot(customer.id, info.reason);
      }
      const when = ops.isWorkingHours()
        ? 'Người của farm sẽ trả lời bạn ngay ạ'
        : `Ngoài giờ làm việc (${ops.workHoursText()}) nên farm sẽ phản hồi vào đầu giờ làm việc ạ`;
      return `Đã chuyển cho người thật. Hãy báo khách: ${when}.`;
    }

    if (toolName === 'search_products') {
      if (!db.DB_ENABLED) {
        // No database yet — fall back to the catalog already in the prompt.
        return 'Dùng bảng giá trong hệ thống (chưa kết nối database sản phẩm).';
      }
      const result = await db.pool.query(
        `SELECT name_vi, base_price, unit, is_available
         FROM products
         WHERE (name_vi ILIKE $1 OR name ILIKE $1 OR $2 = ANY(tags))
           AND is_available = true
         LIMIT 5`,
        [`%${toolInput.query}%`, toolInput.query.toLowerCase()]
      );
      if (result.rows.length === 0) {
        return 'Không tìm thấy sản phẩm phù hợp.';
      }
      return result.rows.map(p =>
        `${p.name_vi}: ${Number(p.base_price).toLocaleString('vi')}đ/${p.unit}`
      ).join('\n');
    }

    if (toolName === 'search_knowledge') {
      return knowledge.search(toolInput.query);
    }

    if (toolName === 'create_order') {
      if (!customer) return 'Chưa xác định được khách hàng.';
      if (toolInput.customer_phone) {
        await db.setPhoneAndMerge(customer.id, toolInput.customer_phone);
      }
      const order = await db.createOrderNew(
        customer.id,
        toolInput.items,
        toolInput.delivery_address,
        toolInput.customer_note,
        toolInput.payment_method || 'cod'
      );
      const total = toolInput.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
      // Flag it so the farm gets a Zalo ping about the new order.
      pendingOrder.set(zaloUserId, {
        order_number: order.order_number,
        total,
        items: toolInput.items,
        phone: toolInput.customer_phone || customer.phone || null,
        address: toolInput.delivery_address || null,
        note: toolInput.customer_note || null,
        payment: toolInput.payment_method || 'cod',
        customerName: customer.display_name || customer.full_name || 'Khách',
      });
      return `Đã tạo đơn hàng ${order.order_number}. Tổng: ${total.toLocaleString('vi')}đ. Thanh toán: ${toolInput.payment_method || 'COD'}.`;
    }

    if (toolName === 'save_memory') {
      if (!customer) return 'Chưa xác định được khách hàng.';
      await db.saveMemory(
        customer.id,
        toolInput.memory_type,
        toolInput.memory_key,
        toolInput.memory_value,
        toolInput.importance || 3
      );

      // A phone number is the one fact that can prove an OA chat and a Bot
      // chat are the same person — use it to merge their histories.
      const key = String(toolInput.memory_key || '').toLowerCase();
      const looksLikePhone = /phone|dien_thoai|điện thoại|sdt|sđt|so_dt/.test(key);
      if (looksLikePhone) {
        const phone = db.normalizePhone(toolInput.memory_value);
        if (phone) {
          // A merge failure must never break the conversation.
          try {
            const survivor = await db.setPhoneAndMerge(customer.id, phone);
            if (survivor && survivor !== customer.id) {
              return 'Đã lưu số điện thoại và nhận ra đây là khách cũ — đã gộp lịch sử hai kênh.';
            }
          } catch (mergeErr) {
            console.error('⚠️  Phone merge failed:', mergeErr.message);
          }
        }
      }
      return `Đã lưu: ${toolInput.memory_key}`;
    }

    if (toolName === 'get_order_status') {
      if (!customer) return 'Chưa xác định được khách hàng.';
      const q = toolInput.order_number
        ? 'SELECT order_number, status, total_amount, delivery_date FROM orders WHERE customer_id=$1 AND order_number=$2'
        : 'SELECT order_number, status, total_amount, delivery_date FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1';
      const params = toolInput.order_number
        ? [customer.id, toolInput.order_number]
        : [customer.id];
      const result = await db.pool.query(q, params);
      if (!result.rows.length) return 'Không tìm thấy đơn hàng.';
      const o = result.rows[0];
      return `Đơn ${o.order_number}: ${o.status} | ${Number(o.total_amount).toLocaleString('vi')}đ${o.delivery_date ? ` | Giao: ${o.delivery_date}` : ''}`;
    }

    return 'Tool không hợp lệ.';
  } catch (err) {
    console.error(`Tool ${toolName} error:`, err.message);
    return `Lỗi xử lý: ${err.message}`;
  }
}

// ============================================================
// MAIN AGENT FUNCTION
// Called from webhook for every incoming Zalo message
// ============================================================
async function respond(zaloUserId, userMessage, sessionId = null) {
  // 1. Load customer context (resolves across channels)
  const customer = await db.getCustomerByExternalId(zaloUserId);
  let memories = [], recentOrders = [], preferences = [];

  if (customer) {
    [memories, recentOrders, preferences] = await Promise.all([
      db.getTopMemories(customer.id, 8),
      db.getRecentOrders(customer.id, 3),
      db.getCustomerPreferences(customer.id)
    ]);
  }

  // 2. Load recent conversation history (last 10 messages)
  const history = await db.getConversationHistory(zaloUserId, 10);
  const messages = history.map(h => ({ role: h.role, content: h.content }));
  messages.push({ role: 'user', content: userMessage });

  // 3. Call Claude with tools
  const systemPrompt = buildSystemPrompt(customer, memories, recentOrders, preferences);
  let response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    tools,
    messages
  });

  // 4. Handle tool use loop — capped, so a confused model can't spin forever
  //    (each turn costs an API call, and a runaway loop would hang the reply).
  let finalText = '';
  const MAX_TOOL_TURNS = 6;
  let turns = 0;
  while (response.stop_reason === 'tool_use' && turns < MAX_TOOL_TURNS) {
    turns++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input, customer, zaloUserId);
      console.log(`🔧 Tool [${block.name}]:`, JSON.stringify(block.input), '→', result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result
      });
    }

    // Continue conversation with tool results
    response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      tools,
      messages: [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults }
      ]
    });
  }

  if (turns >= MAX_TOOL_TURNS && response.stop_reason === 'tool_use') {
    console.warn(`⚠️  Tool loop hit the ${MAX_TOOL_TURNS}-turn cap for ${zaloUserId}`);
  }

  // 5. Extract final text
  finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // 6. Track usage
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

  // A silent bot looks broken to the customer — never return an empty reply.
  if (!finalText.trim()) {
    finalText = 'Dạ mình chưa rõ ý bạn lắm ạ. Bạn nói rõ hơn giúp mình nha! 🌿';
  }

  // Hand these to the caller exactly once, then forget them.
  const handoff = pendingHandoff.get(zaloUserId) || null;
  const newOrder = pendingOrder.get(zaloUserId) || null;
  pendingHandoff.delete(zaloUserId);
  pendingOrder.delete(zaloUserId);

  return { text: finalText, tokensUsed, handoff, newOrder, customer };
}

module.exports = { respond };
