require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const knowledge = require('./knowledge');
const ops = require('./ops');
const catalog = require('./catalog');
const honorific = require('./honorific');
const drift = require('./drift');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SYSTEM PROMPT BUILDER
// Injects customer memory + context into every conversation
// ============================================================
/**
 * The system prompt is split in two so Anthropic can cache the expensive half.
 *
 * Block A is identical for every customer — role, rules, price list, FAQ. It
 * is by far the largest part, and it only changes when the farm edits
 * something. Marked with cache_control, a repeat call reads it from cache at
 * roughly a tenth of the price instead of paying full input rate every message.
 *
 * Block B is this customer's context, which differs every time and must stay
 * outside the cached prefix — putting it first would invalidate the cache on
 * every single message and make caching worthless.
 */
function buildStaticPrompt() {
  return `Bạn là trợ lý bán hàng thân thiện của Doc Mo Farm - một eco-farm sản xuất sản phẩm organic thủ công.

NGUYÊN TẮC GIAO TIẾP:
- Luôn xưng "dạ", gọi khách theo hướng dẫn xưng hô bên dưới
- Trả lời ngắn gọn, dễ đọc trên Zalo (không quá 3-4 dòng mỗi đoạn)
- Thân thiện, ấm áp như người bán hàng tại chợ, không máy móc
- Không hứa hẹn điều trị bệnh
- Dùng emoji nhẹ nhàng khi phù hợp 🌿
${catalog.promptBlock()}
${knowledge.systemPromptBlock()}${knowledge.taughtPromptBlock()}

KHI KHÁCH ĐẶT HÀNG: Gọi tool create_order để tạo đơn hàng.

QUY TẮC SẮT VỀ ĐƠN HÀNG — sai là mất tiền của khách và của farm:
- create_order CHỈ chứa đúng sản phẩm và số lượng khách vừa yêu cầu TRONG TIN NHẮN NÀY.
- TUYỆT ĐỐI KHÔNG cộng dồn sản phẩm của đơn cũ, dù lịch sử trò chuyện có nhắc tới.
  Khách nói "đặt 1 chai nước gừng" thì đơn chỉ có 1 chai nước gừng — không thêm gì khác.
- Nếu không chắc khách muốn thêm hay đặt đơn mới, HỎI LẠI trước, đừng tự đoán.
- Đọc kỹ số lượng. "1 chai" là 1, không phải 2.
- Trước khi gọi create_order, nhẩm lại: tổng tiền = đơn giá × số lượng. Nói đúng con số đó cho khách.

KHI KHÁCH HỎI SẢN PHẨM: Gọi tool search_products để tìm.
KHI KHÁCH HỎI CHI TIẾT (thành phần, cách dùng, bảo quản, ai dùng được, vì sao có cặn...): Gọi tool search_knowledge.
KHI BIẾT THÔNG TIN MỚI VỀ KHÁCH (tên, số điện thoại, địa chỉ, sở thích): Gọi tool save_memory.
SỐ ĐIỆN THOẠI: nếu khách hỏi mua hoặc quan tâm nghiêm túc, hãy hỏi số điện thoại một cách
tự nhiên (để farm tiện liên hệ và giữ lịch sử đơn). Lưu ngay bằng save_memory với key "so_dien_thoai".

THANH TOÁN: khách hay viết tắt. Tất cả những cách nói sau đều có nghĩa là CHUYỂN KHOẢN —
đặt payment_method = "bank_transfer" khi tạo đơn:
"chuyển khoản", "ck", "cknh", "tk", "stk", "số tk", "số tài khoản", "gởi tk",
"qr", "qr code", "qr-code", "mã qr", "quét mã", "bank", "banking", "atm", "chuyển tiền".
Chỉ đặt "cod" khi khách nói rõ: trả tiền mặt, thanh toán khi nhận hàng, ship cod.
Hệ thống sẽ TỰ gửi ảnh mã QR cho khách — bạn chỉ cần nói "farm gửi mã QR ngay nha",
KHÔNG tự đọc số tài khoản ra, KHÔNG tự bịa số tài khoản.

QUAN TRỌNG: Chỉ nói những gì có trong tài liệu trên. Không tự nghĩ ra công dụng,
thành phần hay con số. Không hứa chữa bệnh. Nếu không biết, nói thật là sẽ hỏi lại farm.

════════════════════════════════════════
MỤC TIÊU LÀ BÁN ĐƯỢC HÀNG — nhưng bán theo cách farm bán, không phải cách chợ mạng bán.

1. KHÔNG BAO GIỜ KẾT THÚC BẰNG NGÕ CỤT
Mỗi câu trả lời khép lại bằng ĐÚNG MỘT câu hỏi dễ trả lời, hoặc một bước kế cụ thể.
Trả lời xong rồi im là mất khách — khách không biết nói gì tiếp thì họ đi.
  Tệ:  "Dạ nước nghệ 95.000đ/chai ạ."
  Tốt: "Dạ nước nghệ 95.000đ/chai ạ. Mình uống thử hay mua cho cả nhà để farm tư vấn số lượng nhen?"
Chỉ MỘT câu hỏi. Hỏi hai ba câu cùng lúc là khách bỏ luôn.

2. KHÁCH DO DỰ — đi theo ba nhịp: LÀM RÕ → ĐỔI KHUNG → ĐỀ XUẤT
  Làm rõ:    hỏi một câu để biết họ thật sự ngại điều gì.
  Đổi khung: nối cái ngại đó với điều họ muốn, bằng sự thật trong tài liệu.
  Đề xuất:   mời một bước nhỏ, dễ gật đầu.
Khách chê đắt:
  "Dạ mình đang so với loại nào ạ?"
  → "Farm làm mẻ nhỏ, nguyên liệu organic, lên men thủ công nên giá vậy."
  → "Mình lấy một chai uống thử trước cho chắc nhen?"
TUYỆT ĐỐI KHÔNG tự bịa giảm giá, khuyến mãi, quà tặng, freeship. Farm chưa cho thì không có.

3. ĐỪNG HỎI THÔNG TIN QUÁ SỚM
Khách mới hỏi giá mà đã đòi số điện thoại thì họ thấy bị ép. Tư vấn trước đã.
Chỉ xin số khi khách đã tỏ ý mua: hỏi cách đặt, hỏi giao hàng, hỏi thanh toán.

4. CHỦ ĐỘNG MỜI CHỐT — MỘT LẦN
Sau 2-3 lượt khách hỏi quanh cùng một sản phẩm mà chưa chốt, mời nhẹ một lần:
"Mình lấy thử một chai nhen, farm gói gửi liền ạ?"
Khách nói chưa thì tôn trọng, quay lại tư vấn bình thường. Không nài lần hai.

5. GỢI THÊM ĐÚNG MỘT MÓN
Khi khách đã chốt, có thể gợi một sản phẩm đi cùng nếu thật sự hợp. Một món thôi.
Khách từ chối thì thôi ngay.

6. HÀNG SẮP HẾT thì nói thật khi bảng giá ghi vậy. KHÔNG bịa "sắp hết" để giục.

7. KHÁCH NÓI "ĐỂ EM SUY NGHĨ" — đừng níu. Chốt bằng một câu ấm, chừa đường quay lại:
"Dạ mình cứ suy nghĩ thoải mái, cần gì nhắn farm nhen."`;
}

function buildCustomerPrompt(customer, memories, recentOrders, preferences) {
  let out = '';
  if (customer) {
    out += `Khách hàng: ${customer.display_name || customer.full_name || 'Khách'}`;
    if (customer.customer_tier !== 'new') out += ` | Hạng: ${customer.customer_tier}`;

    // A returning customer greeted with "chào bạn, farm bán gì?" has just been
    // told they are a stranger. Give the agent the facts it needs to open with
    // something that only makes sense for this person.
    const gap = customer.last_seen_at
      ? Math.floor((Date.now() - new Date(customer.last_seen_at).getTime()) / 86400000)
      : null;
    if (gap !== null && gap >= 1) {
      out += `\nKhách đã vắng ${gap} ngày.`;
      if (gap >= 30) out += ' Khá lâu rồi — chào hỏi ấm áp, đừng làm như mới gặp lần đầu.';
    }
    if (recentOrders?.length) {
      out += `\nĐây là KHÁCH CŨ đã từng mua. Mở lời bằng điều cụ thể: hỏi thăm lần dùng trước` +
             ` có hợp không, rồi mới tư vấn tiếp. Không chào như người lạ.`;

      // The single easiest sale a farm ever makes is the one the customer
      // already decided on once. Hand the agent the exact basket to offer back.
      const last = recentOrders[0];
      const items = Array.isArray(last.items)
        ? last.items.filter(i => i && i.name)
        : [];
      if (items.length) {
        const basket = items.map(i => `${i.name} ×${i.qty}`).join(', ');
        out += `\nLẦN TRƯỚC KHÁCH MUA: ${basket}.` +
               `\nNếu khách tỏ ý mua tiếp mà chưa nói rõ món, hãy mời đúng giỏ cũ:` +
               ` "Mình lấy lại như lần trước nhen — ${basket}?" Khách gật là chốt luôn,` +
               ` khỏi bắt họ chọn lại từ đầu.`;
      }
    }
    if (customer.interest_product && customer.lead_stage !== 'ordered') {
      out += `\nLần gần nhất khách quan tâm: ${customer.interest_product}` +
             `${customer.interest_note ? ` (${customer.interest_note})` : ''}.`;
    }
  }
  // What the conversation has already established, including turns that have
  // scrolled out of the verbatim history.
  if (customer?.convo_summary) {
    out += `\n\nĐÃ NÓI VỚI KHÁCH NÀY TỪ TRƯỚC (nhớ và đừng hỏi lại những điều đã biết):\n${customer.convo_summary}`;
  }
  if (memories?.length) {
    out += `\nĐiều bạn nhớ về khách này:\n` +
      memories.map(m => `  - ${m.memory_key}: ${m.memory_value}`).join('\n');
  }
  if (recentOrders?.length) {
    out += `\nĐơn hàng gần đây:\n` +
      recentOrders.map(o => `  - ${o.order_number || o.id}: ${o.total_amount?.toLocaleString('vi')}đ (${o.status})`).join('\n');
  }
  if (preferences?.length) {
    out += `\nSở thích đã biết:\n` +
      preferences.map(p => `  - ${p.preference_key}: ${p.preference_value}`).join('\n');
  }
  out += honorific.promptBlock(customer);
  return out.trim() || 'Khách mới, chưa có thông tin gì.';
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
    name: 'log_interest',
    description:
      'Ghi nhận khách đang quan tâm sản phẩm nào và đang ở bước nào. Gọi NGAY khi khách ' +
      'nhắc tới một sản phẩm cụ thể, hỏi giá, hỏi cách dùng, hoặc tỏ ý cân nhắc mua. ' +
      'Gọi lại mỗi khi mức độ quan tâm thay đổi. Việc này giúp farm biết ai đang cần chăm sóc.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Tên sản phẩm khách quan tâm' },
        stage: {
          type: 'string',
          enum: ['browsing', 'interested', 'deciding', 'lost'],
          description:
            'browsing = mới hỏi dạo; interested = hỏi kỹ về một sản phẩm; ' +
            'deciding = đã hỏi giá/giao hàng/thanh toán, sắp chốt; lost = nói rõ là không mua',
        },
        note: {
          type: 'string',
          description: 'Một câu ngắn: khách cần gì, ngại gì, mua cho ai. Để nhân viên farm nắm nhanh.',
        },
      },
      required: ['product', 'stage'],
    },
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
        order_number: { type: 'string', description: 'Mã đơn nếu khách nhớ (vd: ORD-2026-000001)' },
        phone: { type: 'string', description: 'Số điện thoại lúc đặt, nếu khách không nhớ mã đơn' }
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
        const q = String(toolInput.query || '').toLowerCase();
        const hit = catalog.rows().filter(p => p.name_vi.toLowerCase().includes(q));
        return hit.length
          ? hit.map(p => `${p.name_vi}: ${Number(p.base_price).toLocaleString('vi')}đ/${p.unit}`).join('\n')
          : 'Không tìm thấy sản phẩm phù hợp.';
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

    if (toolName === 'log_interest') {
      if (!customer || !db.DB_ENABLED) return 'Đã ghi nhận.';
      await db.pool.query(
        `UPDATE customers
         SET interest_product = $2,
             interest_note = COALESCE($3, interest_note),
             lead_stage = $4,
             lead_updated_at = NOW()
         WHERE id = $1`,
        [customer.id, toolInput.product, toolInput.note || null, toolInput.stage]
      );
      return 'Đã ghi nhận quan tâm của khách.';
    }

    if (toolName === 'search_knowledge') {
      const found = knowledge.search(toolInput.query);
      // Repeated dead ends mean the bot is answering from outside the farm's
      // own documents — a drift signal, not just an empty result.
      if (/Không có trong tài liệu|Chưa có câu trả lời|Không tìm thấy/.test(found)) {
        drift.noteUnknown(zaloUserId);
      }
      return found;
    }

    if (toolName === 'create_order') {
      if (!customer) return 'Chưa xác định được khách hàng.';
      if (toolInput.customer_phone) {
        await db.setPhoneAndMerge(customer.id, toolInput.customer_phone);
      }
      await db.pool.query(
        `UPDATE customers SET lead_stage='ordered', lead_updated_at=NOW() WHERE id=$1`,
        [customer.id]
      ).catch(() => {});
      const order = await db.createOrderNew(
        customer.id,
        toolInput.items,
        toolInput.delivery_address,
        toolInput.customer_note,
        toolInput.payment_method || 'cod'
      );
      const total = toolInput.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
      // Flag it so the farm gets a Zalo ping about the new order.
      // Carry the SKU through so KiotViet can match the product by code.
      const withSku = (toolInput.items || []).map(i => {
        const hit = catalog.rows().find(p =>
          p.name_vi && i.product_name &&
          p.name_vi.toLowerCase().includes(String(i.product_name).toLowerCase().slice(0, 12)));
        return { ...i, sku: i.sku || hit?.sku || null };
      });
      pendingOrder.set(zaloUserId, {
        order_number: order.order_number,
        total,
        items: withSku,
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

      const key = String(toolInput.memory_key || '').toLowerCase();

      // Gender decides anh/chị — promote it onto the customer record so every
      // future conversation, on either channel, gets the address right.
      if (/gioi_tinh|gender|xung_ho|danh_xung/.test(key)) {
        const g = honorific.parseGenderValue(toolInput.memory_value);
        if (g) {
          await db.setGender(customer.id, g);
          return `Đã ghi nhớ xưng hô: ${g === 'male' ? 'anh' : 'chị'}.`;
        }
      }
      if (/ten_khach|full_name|ho_ten|^ten$/.test(key) && customer) {
        await db.pool.query(
          'UPDATE customers SET full_name=$2, updated_at=NOW() WHERE id=$1',
          [customer.id, toolInput.memory_value]
        ).catch(() => {});
        // A name can also settle the anh/chị question on its own.
        const guess = honorific.guessFromName(toolInput.memory_value);
        if (guess && (!customer.gender || customer.gender === 'unknown')) {
          await db.setGender(customer.id, guess);
        }
      }

      // A phone number is the one fact that can prove an OA chat and a Bot
      // chat are the same person — use it to merge their histories.
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
      if (!db.DB_ENABLED) return 'Chưa tra được đơn, farm sẽ kiểm tra lại giúp khách.';

      // Look up by order number, by phone, or fall back to this customer's own
      // orders. Phone matters: someone may have ordered on one channel and be
      // asking from another, or be asking on behalf of the person who ordered.
      let rows = [];
      if (toolInput.order_number) {
        rows = (await db.pool.query(
          `SELECT o.*, c.display_name FROM orders o
           LEFT JOIN customers c ON c.id = o.customer_id
           WHERE o.order_number ILIKE $1 LIMIT 1`,
          [`%${String(toolInput.order_number).trim()}%`]
        )).rows;
      } else if (toolInput.phone) {
        const phone = db.normalizePhone(toolInput.phone);
        rows = (await db.pool.query(
          `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
           WHERE c.phone = $1 ORDER BY o.created_at DESC LIMIT 3`, [phone]
        )).rows;
      } else if (customer) {
        rows = (await db.pool.query(
          `SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 3`,
          [customer.id]
        )).rows;
      }

      if (!rows.length) {
        return 'Không tìm thấy đơn nào. Hỏi khách mã đơn hoặc số điện thoại lúc đặt để tra lại.';
      }

      // The database stores English status codes; the customer must never see them.
      const VN = {
        pending: 'farm đã nhận đơn, đang chuẩn bị',
        confirmed: 'farm đã xác nhận đơn',
        packed: 'farm đã đóng gói xong',
        shipped: 'đơn đang trên đường giao',
        delivered: 'đơn đã giao xong',
        cancelled: 'đơn đã huỷ',
        refunded: 'đơn đã hoàn tiền',
      };

      return rows.map(o => {
        const when = o.created_at
          ? new Date(o.created_at).toLocaleDateString('vi-VN') : '';
        return `Đơn ${o.order_number} (đặt ${when}): ${VN[o.status] || o.status}` +
               ` — ${Number(o.total_amount).toLocaleString('vi')}đ` +
               `${o.delivery_date ? `, hẹn giao ${new Date(o.delivery_date).toLocaleDateString('vi-VN')}` : ''}` +
               `${o.description ? `\n   ${String(o.description).slice(0, 150)}` : ''}`;
      }).join('\n');
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
  // Recent turns verbatim, plus a rolling summary for everything older (see
  // services/memory.js). Sixteen turns keeps a real conversation intact — a
  // customer on their tenth question is still being understood — while the
  // summary carries the rest, so long memory doesn't mean a long prompt.
  // Only the agent's own long replies get trimmed; the customer's words never do.
  const HISTORY_TURNS = Number(process.env.HISTORY_TURNS || 16);
  const MAX_TURN_CHARS = 1200;
  const history = await db.getConversationHistory(zaloUserId, HISTORY_TURNS);
  const messages = history.map(h => ({
    role: h.role,
    content: (h.role === 'assistant' && h.content.length > MAX_TURN_CHARS)
      ? h.content.slice(0, MAX_TURN_CHARS) + ' […]'
      : h.content,
  }));
  messages.push({ role: 'user', content: userMessage });

  // 3. Call Claude with tools
  // Static half cached, customer half fresh. Order matters: the cached prefix
  // must come first and be byte-identical between calls.
  const systemPrompt = [
    { type: 'text', text: buildStaticPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildCustomerPrompt(customer, memories, recentOrders, preferences) },
  ];
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
  const u = response.usage || {};
  const tokensUsed = (u.input_tokens || 0) + (u.output_tokens || 0);
  // Cache reads are billed at a fraction of input rate — worth seeing in logs.
  if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
    console.log(
      `💰 cache: đọc ${u.cache_read_input_tokens || 0}, ghi ${u.cache_creation_input_tokens || 0}, ` +
      `mới ${u.input_tokens || 0}, ra ${u.output_tokens || 0}`
    );
  }

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
