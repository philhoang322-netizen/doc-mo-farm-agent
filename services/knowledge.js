/**
 * Product knowledge base.
 * Loads every .md file under Product/ at boot, splits it into sections by
 * markdown heading, and exposes Vietnamese-friendly keyword search.
 *
 * Small corpora are injected wholesale into the system prompt; the
 * search_knowledge tool covers the corpus once it outgrows that budget.
 */
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '..', 'Product');
const INLINE_BUDGET = 12000; // chars of knowledge we inline into the system prompt

let sections = []; // [{ file, title, body, haystack }]
let totalChars = 0;

/** Lowercase + strip Vietnamese diacritics so "nghệ" matches "nghe". */
function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

function splitSections(text, file) {
  const out = [];
  // Split on markdown headings (## or #), keeping the heading with its body.
  const parts = text.split(/\n(?=#{1,3}\s)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split('\n')[0];
    const title = firstLine.replace(/^#{1,3}\s*/, '').trim();
    const body = trimmed.slice(firstLine.length).trim().replace(/^-{3,}$/gm, '').trim();
    if (!body && !title) continue;
    out.push({
      file,
      title,
      body,
      haystack: normalize(`${title} ${body}`),
    });
  }
  return out;
}

function load() {
  sections = [];
  totalChars = 0;
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      console.log('ℹ️  No Product/ folder — knowledge base empty.');
      return;
    }
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => /\.(md|txt)$/i.test(f));
    for (const f of files) {
      const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8');
      totalChars += text.length;
      sections.push(...splitSections(text, f));
    }
    console.log(`📚 Knowledge base: ${files.length} file(s), ${sections.length} sections, ${totalChars} chars`);
  } catch (err) {
    console.error('Knowledge load error:', err.message);
  }
}

/** Everything, as one block — used when the corpus is small enough to inline. */
function fullText() {
  return sections.map(s => `### ${s.title}\n${s.body}`).join('\n\n');
}

/** Just the headings — used as a map when the corpus is too big to inline. */
function topicIndex() {
  return sections.map(s => `- ${s.title}`).join('\n');
}

/**
 * Small corpora get inlined verbatim; large ones get an index + the search tool.
 *
 * Returns nothing once the FAQ has been imported into the database: keeping
 * both alive meant an answer the farm had just corrected still had the old
 * file text sitting beside it in the same prompt.
 */
function systemPromptBlock() {
  if (mdDisabled) return '';
  if (sections.length === 0) return '';
  if (totalChars <= INLINE_BUDGET) {
    return `\n\nKIẾN THỨC SẢN PHẨM (dùng để trả lời khách, bám sát nội dung này):\n${fullText()}`;
  }
  return `\n\nCÁC CHỦ ĐỀ CÓ TRONG KIẾN THỨC SẢN PHẨM (gọi tool search_knowledge để đọc chi tiết):\n${topicIndex()}`;
}

/** Keyword search across sections. Returns formatted text for a tool result. */
function search(query, limit = 3, daBao = null) {
  // Once the FAQ is in the database it is the only source; searching the stale
  // file would reintroduce exactly the text the farm edited away.
  if (mdDisabled) return searchLessons(query, limit, daBao);
  if (sections.length === 0) return 'Chưa có tài liệu sản phẩm.';

  const terms = normalize(query).split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return 'Câu hỏi quá ngắn để tra cứu.';

  const scored = sections
    .map(s => {
      let score = 0;
      for (const t of terms) {
        if (s.haystack.includes(t)) score += 1;
        if (normalize(s.title).includes(t)) score += 2; // title hits weigh more
      }
      return { s, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) return 'Không tìm thấy thông tin này trong tài liệu sản phẩm.';

  return scored.map(x => `### ${x.s.title}\n${x.s.body}`).join('\n\n');
}

function stats() {
  return { files: [...new Set(sections.map(s => s.file))], sections: sections.length, chars: totalChars };
}

// ============================================================
// TAUGHT ANSWERS + HOUSE RULES (edited from /admin, stored in the database)
//
// These outrank the .md files: they are what the farm explicitly told the
// agent to say after seeing a reply it didn't like.
// ============================================================
const db = require('./database');
const state = require('./state');
const money = require('./money');
const catalog = require('./catalog');

let lessons = [];
let rules = '';
let taughtAt = 0;
let mdDisabled = false;   // true once the FAQ lives in the database
const TAUGHT_TTL = 60 * 1000;

async function refreshTaught() {
  if (!db.DB_ENABLED) return;
  try {
    const r = await db.pool.query(
      `SELECT id, question, answer, sku, COALESCE(product, 'Chung') AS product
       FROM bot_lessons WHERE is_active = TRUE
       ORDER BY product, sort_order, updated_at DESC LIMIT 600`
    );
    lessons = r.rows;
    rules = (await state.get('bot_rules')) || '';
    mdDisabled = (await state.get('faq_md_disabled')) === 'true';
    taughtAt = Date.now();
  } catch (e) {
    // Table may not exist yet on a database that hasn't run migration 004.
    if (!/bot_lessons/.test(e.message)) console.warn('Taught refresh failed:', e.message);
  }
}

function touchTaught() {
  if (Date.now() - taughtAt > TAUGHT_TTL) refreshTaught().catch(() => {});
}

/**
 * Lessons + house rules, appended after the product FAQ.
 *
 * With ~20 products the FAQ will run to hundreds of answers — far too much to
 * carry in every prompt. Under the budget we inline everything (fastest, most
 * accurate). Over it, the agent gets the questions grouped by product and
 * looks the answer up with search_knowledge, which costs one extra round trip
 * but keeps each message affordable.
 */
const LESSON_BUDGET = 9000; // characters

function taughtPromptBlock() {
  touchTaught();
  const parts = [];

  if (lessons.length) {
    const full = lessons.map(l => `Hỏi: ${l.question}\nTrả lời: ${dienGiaVaoCau(l, null)}`).join('\n\n');

    if (full.length <= LESSON_BUDGET) {
      parts.push(
        '\n\nCÂU TRẢ LỜI DO FARM SOẠN SẴN — ưu tiên cao nhất.\n' +
        'Nếu khách hỏi trùng ý với một mục dưới đây, hãy trả lời đúng theo nội dung đó ' +
        '(được diễn đạt lại cho hợp ngữ cảnh, nhưng KHÔNG đổi thông tin):\n' + full
      );
    } else {
      const byProduct = new Map();
      for (const l of lessons) {
        const k = l.product || 'Chung';
        if (!byProduct.has(k)) byProduct.set(k, []);
        byProduct.get(k).push(l.question);
      }
      const index = [...byProduct.entries()]
        .map(([p, qs]) => `● ${p}:\n${qs.map(q => `   - ${q}`).join('\n')}`)
        .join('\n');
      parts.push(
        `\n\nFARM ĐÃ SOẠN SẴN ${lessons.length} CÂU TRẢ LỜI CHÍNH THỨC.\n` +
        'Dưới đây là danh mục câu hỏi. Khi khách hỏi trùng ý với bất kỳ mục nào, ' +
        'BẮT BUỘC gọi tool search_knowledge để lấy đúng câu trả lời của farm rồi mới trả lời. ' +
        'Không tự nghĩ ra câu trả lời cho những chủ đề này:\n' + index
      );
    }
  }

  if (rules && rules.trim()) {
    parts.push('\n\nQUY TẮC RIÊNG CỦA FARM — phải tuân thủ tuyệt đối:\n' + rules.trim());
  }

  return parts.join('');
}

/**
 * Score every taught answer against the customer's words.
 *
 * Whole-string containment was fine for 20 rows; at several hundred it misses
 * almost everything, because customers never phrase a question the way the FAQ
 * writes it. Term overlap on the question, with a smaller weight on the answer
 * body, handles "để tủ lạnh hông" → "Có cần bảo quản lạnh không?".
 */
/**
 * Điền giá vào câu trả lời trước khi đưa cho bot.
 *
 * Câu trả lời trong database chứa ô trống {{gia}} chứ không chứa con số, nên
 * giá luôn là giá hiện hành trong bảng products — sửa giá ở /admin là 264 câu
 * đổi theo cùng lúc. daBao là tập sku đã báo giá cho khách này; nó quyết định
 * ô {{gia1}} (chỉ hiện lần đầu) có hiện hay không.
 */
function dienGiaVaoCau(l, daBao) {
  if (!money.coOGia(l.answer)) return l.answer;
  const p = l.sku ? catalog.rows().find(x => x.sku === l.sku) : null;
  return money.dienGia(l.answer, p, daBao ? daBao.has(l.sku) : false);
}

function searchLessons(query, limit = 3, daBao = null) {
  touchTaught();
  if (!lessons.length) return 'Chưa có câu trả lời nào do farm soạn.';

  const STOP = new Set(['co','khong','la','gi','the','nao','duoc','minh','ban','farm','a','voi','va','cho','thi','nhu','nay','o','tai','cua','bao','nhieu']);
  const terms = normalize(query).split(/\s+/).filter(t => t.length > 1 && !STOP.has(t));
  if (!terms.length) return 'Câu hỏi quá ngắn để tra cứu.';

  const scored = lessons
    .map(l => {
      const q = normalize(l.question);
      const a = normalize(l.answer);
      let score = 0;
      for (const t of terms) {
        if (q.includes(t)) score += 3;      // the question is what was indexed
        else if (a.includes(t)) score += 1; // body match is weaker evidence
      }
      if (l.product && normalize(l.product) && terms.some(t => normalize(l.product).includes(t))) score += 2;
      return { l, score };
    })
    .filter(x => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (!scored.length) {
    return 'Không có trong tài liệu farm. Hãy nói thật là chưa rõ và sẽ hỏi lại farm, đừng tự nghĩ ra câu trả lời.';
  }
  return scored
    .map(x => `[${x.l.product || 'Chung'}] ${x.l.question}\n${dienGiaVaoCau(x.l, daBao)}`)
    .join('\n\n');
}

function taughtStats() {
  return { lessons: lessons.length, rules_chars: rules.length };
}

load();

module.exports = {
  load, search, systemPromptBlock, fullText, topicIndex, stats,
  refreshTaught, taughtPromptBlock, taughtStats,
};
