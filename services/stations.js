/**
 * Three in-process stations. This is not Make.com and nothing here sends.
 *
 * 1. Filter & routing — read the customer text, name the main need, pick
 *    sales | faq | needs-human | other. Stored on the HITL draft.
 * 2. Prompt station — the Vietnamese instruction wrapped around the existing
 *    farm prompt. The model only writes a draft.
 * 3. Response station — services/drafts.js deliver(), and only after a
 *    person approves. Messenger uses the PSID; Zalo uses the user id.
 */
const ops = require('./ops');

const ROUTES = ['sales', 'faq', 'needs-human', 'other'];

const DEPARTMENT = {
  sales: 'Sales',
  faq: 'FAQ',
  'needs-human': 'Người thật',
  other: 'Khác',
};

const PROMPT_STATION =
  'Bạn là bộ lọc thông minh. Hãy đọc câu hỏi của khách, trích xuất nhu cầu chính và viết câu trả lời ngắn gọn, lịch sự bằng tiếng Việt.';

const SALES = [
  'gia', 'bao nhieu', 'mua', 'dat hang', 'dat ', 'order', 'chot',
  'con hang', 'het hang', 'ton kho', 'thanh toan', 'chuyen khoan',
  'giao hang', 'phi ship', 'ship', 'lay ',
];

const FAQ = [
  'thanh phan', 'cach dung', 'bao quan', 'han dung', 'cong dung',
  'dia chi', 'gio mo cua', 'may gio', 'cua hang o dau', 'huong dan',
  'ai dung duoc', 'vi sao', 'faq',
];

const HUMAN = [
  'khieu nai', 'doi tra', 'tra hang', 'bom hang', 'lua dao',
  'tuc gian', 'buc minh', 'nhan vien', 'nguoi that',
];

function has(text, phrases) {
  return phrases.some((p) => text.includes(p));
}

function salesNeed(text) {
  if (has(text, ['gia', 'bao nhieu'])) return 'Hỏi giá';
  if (has(text, ['dat', 'mua', 'chot', 'order', 'lay '])) return 'Muốn đặt hàng';
  if (has(text, ['con hang', 'het hang', 'ton kho'])) return 'Hỏi còn hàng';
  if (has(text, ['giao', 'ship', 'van chuyen'])) return 'Hỏi giao hàng';
  if (has(text, ['thanh toan', 'chuyen khoan'])) return 'Hỏi thanh toán';
  return 'Hỏi mua / giá / đặt hàng';
}

function faqNeed(text) {
  if (has(text, ['thanh phan', 'cong dung', 'cach dung', 'bao quan', 'han dung'])) {
    return 'Hỏi cách dùng / thành phần';
  }
  if (has(text, ['dia chi', 'gio mo', 'may gio', 'cua hang'])) return 'Hỏi địa chỉ / giờ mở cửa';
  return 'Hỏi thông tin';
}

/**
 * @param {string} text customer words, or a short label such as "[image]"
 * @param {string} [forceRoute] sales | faq | needs-human | other
 * @returns {{route:string, need:string, department:string, storedIntent:string}}
 */
function filterAndRoute(text, forceRoute) {
  const original = String(text || '').replace(/\s+/g, ' ').trim();
  const folded = ops.normalizeText(original);
  let route = 'other';
  let need = 'Nhu cầu khác';

  if (ROUTES.includes(forceRoute)) {
    route = forceRoute;
    need = forceRoute === 'needs-human' ? 'Cần người thật'
      : forceRoute === 'sales' ? 'Hỏi mua / giá / đặt hàng'
      : forceRoute === 'faq' ? 'Hỏi thông tin'
      : 'Nhu cầu khác';
  } else if (!folded) {
    need = 'Tin nhắn trống';
  } else if (ops.wantsHuman(original) || has(folded, HUMAN)) {
    route = 'needs-human';
    need = 'Cần người thật';
  } else if (has(folded, SALES)) {
    route = 'sales';
    need = salesNeed(folded);
  } else if (has(folded, FAQ)) {
    route = 'faq';
    need = faqNeed(folded);
  }

  const head = `[${route}] ${need}`;
  let storedIntent = original ? `${head} — ${original}` : head;
  if (storedIntent.length > 1000) storedIntent = storedIntent.slice(0, 1000);

  return {
    route,
    need,
    department: DEPARTMENT[route],
    storedIntent,
  };
}

/** Current user turn for the model. `maskedText` is already PII-masked. */
function llmUserTurn(maskedText, routed) {
  return [
    'Trạm lọc đã đọc câu hỏi.',
    `Nhu cầu chính: ${routed.need}`,
    `Tuyến: ${routed.route} (${routed.department})`,
    'Viết câu trả lời ngắn gọn, lịch sự bằng tiếng Việt. Giữ quy tắc bán hàng, giá, và tồn kho của farm. Đây chỉ là bản nháp.',
    '',
    'Câu hỏi của khách:',
    String(maskedText ?? ''),
  ].join('\n');
}

module.exports = {
  ROUTES,
  DEPARTMENT,
  PROMPT_STATION,
  filterAndRoute,
  llmUserTurn,
};
