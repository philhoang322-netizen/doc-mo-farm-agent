require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const knowledge = require('./knowledge');
const ops = require('./ops');
const catalog = require('./catalog');
const honorific = require('./honorific');
const drift = require('./drift');
const shipping = require('./shipping');
const money = require('./money');
const promo = require('./promo');
const priceMemo = require('./priceMemo');
const stockGate = require('./stockGate');
const confidenceGate = require('./confidenceGate');
const audit = require('./audit');
const llm = require('./llm');
const pii = require('./pii');
const stations = require('./stations');
const trainingLog = require('./trainingLog');
const triage = require('./triage');

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
  return `${stations.PROMPT_STATION}

Bản nháp này chưa gửi cho khách. Giữ nguyên quy tắc bán hàng, giá, KiotViet và bài học của farm ở dưới. Người duyệt trên /admin mới được gửi.

Bạn là trợ lý bán hàng thân thiện của Doc Mo Farm - một eco-farm sản xuất sản phẩm organic thủ công.

NGUYÊN TẮC GIAO TIẾP:
- Luôn xưng "dạ", gọi khách theo hướng dẫn xưng hô bên dưới
- Trả lời ngắn gọn, dễ đọc trên Zalo (không quá 3-4 dòng mỗi đoạn)
- Thân thiện, ấm áp như người bán hàng tại chợ, không máy móc
- Không hứa hẹn điều trị bệnh
- Dùng emoji nhẹ nhàng khi phù hợp 🌿
${catalog.promptBlock()}
${shipping.promptBlock()}
${promo.promptBlock()}
${knowledge.systemPromptBlock()}${knowledge.taughtPromptBlock()}

════════════════════════════════════════
CÁCH NÓI GIÁ — làm sai là khách chuyển khoản sai số tiền.

a) BÁO GIÁ trong câu chat: viết tắt hàng nghìn thành K.
   320.000đ  →  320K        195.000đ  →  195K        2.500.000đ  →  2.500K
   Số lẻ không tròn nghìn thì để nguyên: 2.500đ/gram viết là 2.500đ/gram.

b) LÊN ĐƠN, TỔNG TIỀN, MÃ QR CHUYỂN KHOẢN: viết ĐẦY ĐỦ, không viết tắt.
   "Tổng đơn 640.000đ" — để khách chuyển khoản đúng số.
   KHÔNG BAO GIỜ viết "tổng 640K" khi chốt đơn.

c) Con số phải lấy từ kết quả tool search_products hoặc search_knowledge.
   TUYỆT ĐỐI không đọc giá từ trí nhớ, không suy ra, không ước chừng, không làm tròn.
   Tra cứu không ra giá thì nói thật là farm sẽ kiểm rồi báo lại.

d) Khách hỏi dung tích, khối lượng, quy cách, hay còn hàng không —
   trả lời xong thì kèm luôn đơn giá: "Dầu gội đóng chai 480ml ạ. (320K/chai)"

e) Câu kỹ thuật (thành phần, cách dùng, bảo quản, hạn dùng): kết quả tra cứu
   đã tự kèm giá ở lần đầu và tự bỏ giá ở những lần sau. Cứ theo đúng kết quả
   tra cứu — đừng tự thêm giá vào, cũng đừng tự bỏ giá đi.

KHI KHÁCH ĐẶT HÀNG: Gọi tool create_order để tạo đơn hàng.

QUY TẮC SẮT VỀ ĐƠN HÀNG — sai là mất tiền của khách và của farm:
- create_order CHỈ chứa đúng sản phẩm và số lượng khách vừa yêu cầu TRONG TIN NHẮN NÀY.
- TUYỆT ĐỐI KHÔNG cộng dồn sản phẩm của đơn cũ, dù lịch sử trò chuyện có nhắc tới.
  Khách nói "đặt 1 chai nước gừng" thì đơn chỉ có 1 chai nước gừng — không thêm gì khác.
- Nếu không chắc khách muốn thêm hay đặt đơn mới, HỎI LẠI trước, đừng tự đoán.
- Đọc kỹ số lượng. "1 chai" là 1, không phải 2.
- Trước khi gọi create_order, nhẩm lại: tổng tiền = đơn giá × số lượng. Nói đúng con số đó cho khách.
- create_order tự kiểm tồn kho thật trên KiotViet. Nếu tool trả về CHƯA TẠO ĐƠN, nói đúng cảnh báo đó:
  không nói đã chốt, không hứa còn hàng, không bịa số tồn. Nhân viên farm sẽ đối soát.

DỮ LIỆU ĐÃ CHE: tin khách có thể chứa [PHONE], [EMAIL], [CCCD], [CMND], [BANK], [VIETQR], [ADDRESS], [ID].
Đó là thông tin hệ thống đã giấu trước khi gửi cho bạn. Không đoán, không bịa, không đọc lại các số đó.
Vẫn tư vấn sản phẩm, số lượng và mã đơn bình thường.

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
  Tệ:  "Dạ nước gừng lên men 160K/chai ạ."
  Tốt: "Dạ nước gừng lên men 160K/chai ạ. Mình uống thử hay mua cho cả nhà để farm tư vấn số lượng nhen?"
Chỉ MỘT câu hỏi. Hỏi hai ba câu cùng lúc là khách bỏ luôn.

2. KHÁCH DO DỰ — đi theo ba nhịp: LÀM RÕ → ĐỔI KHUNG → ĐỀ XUẤT
  Làm rõ:    hỏi một câu để biết họ thật sự ngại điều gì.
  Đổi khung: nối cái ngại đó với điều họ muốn, bằng sự thật trong tài liệu.
  Đề xuất:   mời một bước nhỏ, dễ gật đầu.
Khách chê đắt:
  "Dạ mình đang so với loại nào ạ?"
  → "Farm làm mẻ nhỏ, nguyên liệu organic, lên men thủ công nên giá vậy."
  → "Mình lấy một chai uống thử trước cho chắc nhen?"
TUYỆT ĐỐI KHÔNG tự bịa giảm giá, khuyến mãi, quà tặng, freeship.
Chỉ được nhắc đúng những khuyến mãi ghi trong phần KHUYẾN MÃI ĐANG CHẠY ở trên,
hoặc ghi kèm sản phẩm trong kết quả search_products. Ngoài hai chỗ đó thì farm chưa cho.

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
"Dạ mình cứ suy nghĩ thoải mái, cần gì nhắn farm nhen."

════════════════════════════════════════
ĐỘ TIN Ý KHÁCH — gọi tool report_intent_confidence ĐÚNG MỘT LẦN mỗi lượt,
trước create_order và trước câu trả lời cuối. Không chép con số này vào tin gửi khách.

- confidence từ 0 đến 1: bạn chắc khách đang muốn gì.
- Dưới ngưỡng (mặc định 0.6, hệ thống báo lại trong kết quả tool): sticker, ảnh không rõ,
  câu đùa, ký tự vô nghĩa, hoặc bạn không hiểu ý. KHÔNG bịa sản phẩm, giá, công dụng.
  KHÔNG gọi create_order. Một câu ngắn nói farm nhờ nhân viên xem là đủ — hệ thống
  sẽ giữ tin chờ người, không gửi câu bán hàng.
- Từ ngưỡng trở lên: trả lời bình thường theo tài liệu farm.`;
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
    description:
      'Tạo đơn hàng mới cho khách. Hệ thống tự kiểm tồn KiotViet trước khi tạo. ' +
      'Nếu tool báo CHƯA TẠO ĐƠN vì hết hoặc sắp hết hàng, không được xác nhận đơn.',
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
    name: 'check_shipping',
    description:
      'Tra phí giao hàng và thời gian cho một khu vực cụ thể. Dùng khi khách nói rõ nơi nhận ' +
      '(tỉnh, quận, thành phố), nhất là lúc sắp chốt đơn.',
    input_schema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'Nơi khách nhận hàng, vd: "Quận 7", "Đà Nẵng", "Biên Hoà"' },
        order_total: { type: 'number', description: 'Tổng tiền hàng, để biết có đủ miễn phí ship chưa' },
      },
      required: ['place'],
    },
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
    name: 'report_intent_confidence',
    description:
      'Báo độ chắc bạn hiểu ý khách trong tin này. Gọi đúng một lần mỗi lượt, trước create_order ' +
      'và trước câu trả lời cuối. Không chép con số này vào tin cho khách. ' +
      'Dưới ngưỡng: không bịa câu bán hàng và không tạo đơn.',
    input_schema: {
      type: 'object',
      properties: {
        confidence: {
          type: 'number',
          description:
            'Từ 0 đến 1 (hoặc phần trăm 0–100). Dưới 0.6 khi tin vô nghĩa, đùa, sticker, ' +
            'ảnh không rõ, hoặc không chắc khách muốn hỏi gì.',
        },
        intent: {
          type: 'string',
          description: 'Một câu ngắn: khách muốn gì. Không rõ thì ghi "không rõ".',
        },
      },
      required: ['confidence'],
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
const pendingStockHold = new Map();
const pendingConfidence = new Map();

function attachSku(items) {
  return (items || []).map(item => {
    const named = String(item.product_name || '').toLowerCase();
    const hit = catalog.rows().find(p => {
      if (item.sku && p.sku && String(p.sku).toUpperCase() === String(item.sku).toUpperCase()) return true;
      if (!named || !p.name_vi) return false;
      const needle = named.slice(0, 12);
      return p.name_vi.toLowerCase().includes(needle) || named.includes(p.name_vi.toLowerCase());
    });
    return { ...item, sku: item.sku || hit?.sku || null, product_name: item.product_name || hit?.name_vi || null };
  });
}

/**
 * Stock check, then create. Low or short stock does not insert an order and
 * does not leave a "đã tạo đơn" tool result. The warning draft replaces the
 * model reply in finalizeReply().
 */
async function attemptCreateOrder(customer, toolInput, zaloUserId) {
  if (confidenceGate.isLow(pendingConfidence.get(zaloUserId))) {
    return {
      decision: 'blocked',
      toolResult:
        'CHƯA TẠO ĐƠN. Độ tin ý khách dưới ngưỡng — không chốt đơn, không bịa giá. Hệ thống chuyển nhân viên.',
      draftReply: null,
      stockHold: null,
    };
  }
  if (!customer) {
    return { decision: 'error', toolResult: 'Chưa xác định được khách hàng.', draftReply: null, stockHold: null };
  }
  if (toolInput.customer_phone) {
    await db.setPhoneAndMerge(customer.id, toolInput.customer_phone);
  }

  const items = attachSku(toolInput.items);
  const stock = await stockGate.assessItems(items);
  if (stock.decision === 'low' || stock.decision === 'blocked') {
    const handoff = {
      kind: 'stock',
      reason: stock.summary,
      urgency: 'high',
      customerId: customer.id,
      externalId: zaloUserId,
    };
    pendingHandoff.set(zaloUserId, handoff);
    pendingStockHold.set(zaloUserId, stock);
    pendingOrder.delete(zaloUserId);
    return {
      decision: stock.decision,
      toolResult:
        `CHƯA TẠO ĐƠN (${stock.decision}). Không được nói đã chốt đơn hay còn đủ hàng.\n` +
        `Trả lời khách đúng nội dung sau:\n${stock.draftReply}`,
      draftReply: stock.draftReply,
      stockHold: stock,
    };
  }

  const order = await db.createOrderNew(
    customer.id,
    items,
    toolInput.delivery_address,
    toolInput.customer_note,
    toolInput.payment_method || 'cod'
  );
  await db.pool.query(
    `UPDATE customers SET lead_stage='ordered', lead_updated_at=NOW() WHERE id=$1`,
    [customer.id]
  ).catch(() => {});

  const total = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price || 0), 0);
  if (pendingHandoff.get(zaloUserId)?.kind === 'stock') pendingHandoff.delete(zaloUserId);
  pendingStockHold.delete(zaloUserId);
  const pending = {
    order_number: order.order_number,
    total,
    items,
    phone: toolInput.customer_phone || customer.phone || null,
    address: toolInput.delivery_address || null,
    note: toolInput.customer_note || null,
    payment: toolInput.payment_method || 'cod',
    customerName: customer.display_name || customer.full_name || 'Khách',
  };
  pendingOrder.set(zaloUserId, pending);
  await audit.record({
    actor: 'ai',
    action: 'order.created',
    entity_type: 'order',
    entity_id: String(order.order_number || order.id || ''),
    before: null,
    after: audit.orderSnapshot(pending),
    meta: {
      conversation_id: zaloUserId,
      order_number: order.order_number ? String(order.order_number) : null,
      customer_id: customer.id,
    },
  });
  return {
    decision: stock.decision,
    toolResult: `Đã tạo đơn hàng ${order.order_number}. Tổng: ${total.toLocaleString('vi')}đ. Thanh toán: ${toolInput.payment_method || 'COD'}.`,
    draftReply: null,
    stockHold: null,
    order,
  };
}

/**
 * Apply a stock hold over whatever the model wrote, then clear the turn flags.
 * A low confidence score drops any order from this turn so the caller cannot
 * confirm it. The caller also replaces the model text — this function still
 * returns that text so a mistaken draft can be detected in tests.
 */
function finalizeReply(zaloUserId, modelText) {
  const handoff = pendingHandoff.get(zaloUserId) || null;
  let newOrder = pendingOrder.get(zaloUserId) || null;
  const stockHold = pendingStockHold.get(zaloUserId) || null;
  const confidence = pendingConfidence.has(zaloUserId)
    ? pendingConfidence.get(zaloUserId)
    : null;
  pendingHandoff.delete(zaloUserId);
  pendingOrder.delete(zaloUserId);
  pendingStockHold.delete(zaloUserId);
  pendingConfidence.delete(zaloUserId);

  if (confidenceGate.isLow(confidence)) newOrder = null;

  let text = String(modelText || '').trim();
  if (stockHold?.draftReply) text = stockHold.draftReply;
  if (!text && !confidenceGate.isLow(confidence)) {
    text = 'Dạ mình chưa rõ ý bạn lắm ạ. Bạn nói rõ hơn giúp mình nha! 🌿';
  }
  return { text, handoff, newOrder, stockHold, confidence };
}

async function executeTool(toolName, toolInput, customer, zaloUserId, daBaoGia = null) {
  try {
    if (toolName === 'report_intent_confidence') {
      const score = confidenceGate.clamp(toolInput.confidence);
      if (score == null) {
        return 'confidence không hợp lệ. Gọi lại với số từ 0 đến 1.';
      }
      pendingConfidence.set(zaloUserId, score);
      const min = confidenceGate.minConfidence();
      if (confidenceGate.isLow(score)) {
        return (
          `Độ tin ${score} dưới ngưỡng ${min}. KHÔNG gọi create_order. ` +
          'KHÔNG bịa giá, công dụng, hay câu chốt đơn. Hệ thống sẽ chuyển nhân viên.'
        );
      }
      return `Đã ghi độ tin ${score} (ngưỡng ${min}). Được trả lời theo tài liệu farm.`;
    }

    if (toolName === 'request_human') {
      const info = {
        reason: toolInput.reason || 'Khách muốn gặp người thật',
        urgency: toolInput.urgency || 'normal',
        customerId: customer ? customer.id : null,
        externalId: zaloUserId,
      };
      pendingHandoff.set(zaloUserId, info);
      // The model asking for a person does not pause. Only ops.wantsHuman does.
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
          ? hit.map(p => `${p.name_vi}: ${money.donGia(p)}`).join('\n')
          : 'Không tìm thấy sản phẩm phù hợp.';
      }
      const result = await db.pool.query(
        `SELECT sku, name_vi, base_price, sale_price, unit, is_available
         FROM products
         WHERE (name_vi ILIKE $1 OR name ILIKE $1 OR $2 = ANY(tags))
           AND is_available = true
         LIMIT 5`,
        [`%${toolInput.query}%`, toolInput.query.toLowerCase()]
      );
      if (result.rows.length === 0) {
        return 'Không tìm thấy sản phẩm phù hợp.';
      }
      // Khuyến mãi riêng của món đi kèm ngay đây, để bot khỏi phải nhớ hàng
      // chục chương trình trong prompt và khỏi mời nhầm sang món khác.
      return result.rows.map(p => {
        const km = promo.theoSku(p.sku).map(k => `\n   Khuyến mãi: ${k.detail}`).join('');
        return `${p.name_vi}: ${money.donGia(p)}${km}`;
      }).join('\n');
    }

    if (toolName === 'check_shipping') {
      return shipping.quote(toolInput.place, toolInput.order_total || 0);
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
      const found = knowledge.search(toolInput.query, 3, daBaoGia);
      // Repeated dead ends mean the bot is answering from outside the farm's
      // own documents — a drift signal, not just an empty result.
      if (/Không có trong tài liệu|Chưa có câu trả lời|Không tìm thấy/.test(found)) {
        drift.noteUnknown(zaloUserId);
      }
      return found;
    }

    if (toolName === 'create_order') {
      const created = await attemptCreateOrder(customer, toolInput, zaloUserId);
      return created.toolResult;
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
  // A previous turn that threw must not leak its score into this one.
  pendingConfidence.delete(zaloUserId);

  // Refunds, returns, exchanges, complaints, and anger are drafted locally.
  // The model must not invent an approval.
  const triaged = triage.classify(userMessage);
  if (triaged.skipModel) {
    return {
      text: triage.customerReply(triaged),
      tokensUsed: 0,
      handoff: null,
      newOrder: null,
      stockHold: null,
      confidence: 1,
      customer: null,
      piiNote: null,
      triage: triaged,
    };
  }

  // 1. Load customer context (resolves across channels)
  const customer = await db.getCustomerByExternalId(zaloUserId);
  let memories = [], recentOrders = [], preferences = [];

  // Những món đã báo giá cho khách này. Quyết định câu kỹ thuật lần này còn
  // kèm giá nữa hay thôi — xem services/priceMemo.js.
  let daBaoGia = new Set();

  if (customer) {
    [memories, recentOrders, preferences, daBaoGia] = await Promise.all([
      db.getTopMemories(customer.id, 8),
      db.getRecentOrders(customer.id, 3),
      db.getCustomerPreferences(customer.id),
      priceMemo.daBao(customer.id)
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
  const routed = stations.filterAndRoute(userMessage);
  messages.push({
    role: 'user',
    content: stations.llmUserTurn(userMessage, routed, triaged),
  });

  // 3. Call Claude with tools
  // Static half cached, customer half fresh. Order matters: the cached prefix
  // must come first and be byte-identical between calls. Manager corrections
  // sit in the uncached block so they are in context before generation
  // without busting the shared cache.
  const systemPrompt = await systemBlocks(
    customer, memories, recentOrders, preferences, userMessage, 'farm'
  );
  const piiReports = [];
  let created = await llm.anthropicCreate(claude, {
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    tools,
    messages
  });
  let response = created.response;
  piiReports.push(created.piiReport);

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
      const result = await executeTool(block.name, block.input, customer, zaloUserId, daBaoGia);
      console.log(`🔧 Tool [${block.name}]:`, JSON.stringify(block.input), '→', result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result
      });
    }

    // Continue conversation with tool results
    created = await llm.anthropicCreate(claude, {
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
    response = created.response;
    piiReports.push(created.piiReport);
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

  // Low confidence must not leave a live order behind for the pipeline to push.
  if (confidenceGate.isLow(pendingConfidence.get(zaloUserId))) {
    const abandoned = pendingOrder.get(zaloUserId);
    pendingOrder.delete(zaloUserId);
    if (abandoned?.order_number && db.DB_ENABLED) {
      await db.pool.query(
        `UPDATE orders SET status = 'cancelled' WHERE order_number = $1 AND status = 'pending'`,
        [abandoned.order_number]
      ).catch(err => console.error('cancel low-confidence order:', err.message));
    }
  }

  // Stock warning replaces a silent "đã chốt". Empty text still gets a fallback
  // unless this turn is already below the confidence gate.
  const flags = finalizeReply(zaloUserId, finalText);

  return {
    text: flags.text,
    tokensUsed,
    handoff: flags.handoff,
    newOrder: flags.newOrder,
    stockHold: flags.stockHold,
    confidence: flags.confidence,
    customer,
    piiNote: pii.describe(pii.mergeReports(piiReports)),
  };
}

async function systemBlocks(customer, memories, recentOrders, preferences, userMessage, salesChannel) {
  let trainingText = '';
  try {
    trainingText = await trainingLog.promptBlock(userMessage, salesChannel || 'farm');
  } catch (e) {
    console.error('Training examples skipped:', e.message);
  }
  return [
    { type: 'text', text: buildStaticPrompt(), cache_control: { type: 'ephemeral' } },
    {
      type: 'text',
      text: buildCustomerPrompt(customer, memories, recentOrders, preferences) + trainingText,
    },
  ];
}

module.exports = { respond, attemptCreateOrder, finalizeReply, systemBlocks };
