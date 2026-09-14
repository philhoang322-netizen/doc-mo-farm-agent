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

/** Small corpora get inlined verbatim; large ones get an index + the search tool. */
function systemPromptBlock() {
  if (sections.length === 0) return '';
  if (totalChars <= INLINE_BUDGET) {
    return `\n\nKIẾN THỨC SẢN PHẨM (dùng để trả lời khách, bám sát nội dung này):\n${fullText()}`;
  }
  return `\n\nCÁC CHỦ ĐỀ CÓ TRONG KIẾN THỨC SẢN PHẨM (gọi tool search_knowledge để đọc chi tiết):\n${topicIndex()}`;
}

/** Keyword search across sections. Returns formatted text for a tool result. */
function search(query, limit = 3) {
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

load();

module.exports = { load, search, systemPromptBlock, fullText, topicIndex, stats };
