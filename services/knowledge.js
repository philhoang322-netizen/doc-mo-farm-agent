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
function search(query, limit = 3) {
  // Once the FAQ is in the database it is already in the prompt; searching the
  // stale file would only reintroduce the text the farm edited away.
  if (mdDisabled) {
    const hit = lessons.find(l => normalize(l.question).includes(normalize(query)) ||
                                  normalize(query).includes(normalize(l.question)));
    return hit ? hit.answer : 'Không có trong tài liệu farm. Hãy nói thật là sẽ hỏi lại farm.';
  }
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

let lessons = [];
let rules = '';
let taughtAt = 0;
let mdDisabled = false;   // true once the FAQ lives in the database
const TAUGHT_TTL = 60 * 1000;

async function refreshTaught() {
  if (!db.DB_ENABLED) return;
  try {
    const r = await db.pool.query(
      'SELECT id, question, answer FROM bot_lessons WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 200'
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

/** Lessons + house rules, appended after the product FAQ. */
function taughtPromptBlock() {
  touchTaught();
  const parts = [];

  if (lessons.length) {
    const list = lessons
      .map(l => `Hỏi: ${l.question}\nTrả lời: ${l.answer}`)
      .join('\n\n');
    parts.push(
      '\n\nCÂU TRẢ LỜI DO FARM SOẠN SẴN — ưu tiên cao nhất.\n' +
      'Nếu khách hỏi trùng ý với một mục dưới đây, hãy trả lời đúng theo nội dung đó ' +
      '(được diễn đạt lại cho hợp ngữ cảnh, nhưng KHÔNG đổi thông tin):\n' + list
    );
  }

  if (rules && rules.trim()) {
    parts.push('\n\nQUY TẮC RIÊNG CỦA FARM — phải tuân thủ tuyệt đối:\n' + rules.trim());
  }

  return parts.join('');
}

function taughtStats() {
  return { lessons: lessons.length, rules_chars: rules.length };
}

load();

module.exports = {
  load, search, systemPromptBlock, fullText, topicIndex, stats,
  refreshTaught, taughtPromptBlock, taughtStats,
};
