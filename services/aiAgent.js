require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

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
${customerCtx}${memoriesCtx}${ordersCtx}${prefsCtx}

KHI KHÁCH ĐẶT HÀNG: Gọi tool create_order để tạo đơn hàng.
KHI KHÁCH HỎI SẢN PHẨM: Gọi tool search_products để tìm.
KHI BIẾT THÔNG TIN MỚI VỀ KHÁCH (tên, số điện thoại, địa chỉ, sở thích): Gọi tool save_memory.`;
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
async function executeTool(toolName, toolInput, customer) {
  try {
    if (toolName === 'search_products') {
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

    if (toolName === 'create_order') {
      if (!customer) return 'Chưa xác định được khách hàng.';
      const order = await db.createOrderNew(
        customer.id,
        toolInput.items,
        toolInput.delivery_address,
        toolInput.customer_note,
        toolInput.payment_method || 'cod'
      );
      const total = toolInput.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
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
  // 1. Load customer context
  const customer = await db.getCustomerByZaloId(zaloUserId);
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
    max_tokens: 600,
    system: systemPrompt,
    tools,
    messages
  });

  // 4. Handle tool use loop
  let finalText = '';
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input, customer);
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
      max_tokens: 600,
      system: systemPrompt,
      tools,
      messages: [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults }
      ]
    });
  }

  // 5. Extract final text
  finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // 6. Track usage
  const tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

  return { text: finalText, tokensUsed };
}

module.exports = { respond };
