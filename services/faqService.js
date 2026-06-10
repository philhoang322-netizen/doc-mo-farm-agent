require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// FAQ SERVICE
// Reads real chat history → AI generates FAQ pairs → saves to DB
// ============================================================

/**
 * Generate FAQ from conversation history
 * @param {Object} options
 * @param {number} options.days       - How many days of history to read (default: 30)
 * @param {number} options.minMessages - Minimum messages needed to generate (default: 20)
 * @param {boolean} options.autoPublish - Auto-publish high-confidence FAQs (default: false)
 */
async function generateFaqFromHistory({ days = 30, minMessages = 20, autoPublish = false } = {}) {
  console.log(`🔍 Reading chat history from last ${days} days...`);

  // Pull all customer messages from the given period
  const result = await db.pool.query(`
    SELECT
      m.content,
      m.role,
      m.created_at,
      c.display_name,
      c.full_name
    FROM messages m
    LEFT JOIN customers c ON c.id = m.customer_id
    WHERE m.created_at >= NOW() - INTERVAL '${days} days'
      AND m.role = 'user'
      AND LENGTH(m.content) > 10
    ORDER BY m.created_at ASC
    LIMIT 500
  `);

  const userMessages = result.rows;

  if (userMessages.length < minMessages) {
    return {
      success: false,
      message: `Chưa đủ dữ liệu. Cần ít nhất ${minMessages} tin nhắn, hiện có ${userMessages.length}.`,
      count: 0
    };
  }

  console.log(`📊 Found ${userMessages.length} user messages. Sending to Claude...`);

  // Format messages for AI
  const chatSample = userMessages
    .map(m => `[${new Date(m.created_at).toLocaleDateString('vi')}] Khách: ${m.content}`)
    .join('\n');

  // Ask Claude to extract FAQ pairs
  const aiResponse = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: `Bạn là chuyên gia phân tích dữ liệu khách hàng của Doc Mo Farm.
Doc Mo Farm bán: Dầu gội, dầu tắm, xúc xích phô mai, xúc xích tỏi, nước gừng lên men, nước nghệ lên men, kẹo chuối, chuối sấy dẻo.
Nhiệm vụ: Phân tích tin nhắn thực của khách → tạo FAQ thực tế, hữu ích.`,
    messages: [
      {
        role: 'user',
        content: `Đây là ${userMessages.length} tin nhắn thực từ khách hàng trong ${days} ngày qua:

---
${chatSample}
---

Hãy phân tích và tạo danh sách FAQ (câu hỏi thường gặp) từ các tin nhắn này.

Yêu cầu:
1. Chỉ tạo FAQ từ câu hỏi THỰC SỰ được hỏi nhiều lần hoặc phổ biến
2. Câu trả lời phải ngắn gọn, phù hợp để trả lời qua Zalo (dưới 100 từ)
3. Tone: thân thiện, dùng "dạ", phù hợp với khách mua online
4. Nhóm theo danh mục: product (sản phẩm), order (đặt hàng), delivery (giao hàng), policy (chính sách), other

Trả lời theo định dạng JSON sau, KHÔNG có markdown hay code block:
{
  "faqs": [
    {
      "question": "câu hỏi",
      "answer": "câu trả lời",
      "category": "product|order|delivery|policy|other",
      "frequency_estimate": số từ 1-10 (ước tính tần suất được hỏi),
      "confidence": số từ 0.0-1.0 (độ tự tin câu này thực sự phổ biến)
    }
  ],
  "summary": "Tóm tắt ngắn về xu hướng câu hỏi của khách"
}`
      }
    ]
  });

  // Parse AI response
  let parsed;
  try {
    const rawText = aiResponse.content[0].text.trim();
    // Strip any accidental markdown code blocks
    const jsonText = rawText.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error('Failed to parse FAQ JSON:', err.message);
    console.error('Raw response:', aiResponse.content[0].text.substring(0, 500));
    return {
      success: false,
      message: 'AI không trả về định dạng JSON hợp lệ.',
      count: 0
    };
  }

  const faqs = parsed.faqs || [];
  console.log(`✅ Claude generated ${faqs.length} FAQ items`);

  // Save to database
  const dateStart = new Date();
  dateStart.setDate(dateStart.getDate() - days);
  const saved = [];

  for (const faq of faqs) {
    try {
      const res = await db.pool.query(`
        INSERT INTO faqs
          (question, answer, category, frequency_count, is_published,
           generated_from_date_start, generated_from_date_end, source, generated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'chat_history', 'claude-sonnet-4-6')
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
          faq.question,
          faq.answer,
          faq.category || 'other',
          faq.frequency_estimate || 1,
          autoPublish && (faq.confidence || 0) >= 0.7,
          dateStart.toISOString().split('T')[0],
          new Date().toISOString().split('T')[0]
        ]
      );
      if (res.rows.length > 0) {
        saved.push({ id: res.rows[0].id, question: faq.question, category: faq.category });
      }
    } catch (err) {
      console.warn('FAQ insert error:', err.message);
    }
  }

  return {
    success: true,
    count: saved.length,
    total_generated: faqs.length,
    summary: parsed.summary,
    faqs: saved,
    message: `Đã tạo ${saved.length} FAQ từ ${userMessages.length} tin nhắn của ${days} ngày qua.`
  };
}

/**
 * Get published FAQs, optionally filtered by category
 */
async function getPublishedFaqs(category = null) {
  const query = category
    ? `SELECT * FROM faqs WHERE is_published = true AND category = $1 ORDER BY frequency_count DESC`
    : `SELECT * FROM faqs WHERE is_published = true ORDER BY frequency_count DESC`;
  const params = category ? [category] : [];
  const result = await db.pool.query(query, params);
  return result.rows;
}

/**
 * Get all FAQs (including unpublished) for admin review
 */
async function getAllFaqs({ category = null, published = null } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  if (category) { params.push(category); where += ` AND category = $${params.length}`; }
  if (published !== null) { params.push(published); where += ` AND is_published = $${params.length}`; }

  const result = await db.pool.query(
    `SELECT * FROM faqs ${where} ORDER BY frequency_count DESC, created_at DESC`,
    params
  );
  return result.rows;
}

/**
 * Publish or unpublish a FAQ
 */
async function togglePublish(faqId, publish = true) {
  const result = await db.pool.query(
    `UPDATE faqs SET is_published = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [publish, faqId]
  );
  return result.rows[0];
}

/**
 * Answer a question using FAQ database first, fall back to AI
 */
async function answerWithFaq(question) {
  // Try FAQ database first (simple text match)
  const result = await db.pool.query(`
    SELECT question, answer, category
    FROM faqs
    WHERE is_published = true
      AND (
        question ILIKE $1
        OR answer ILIKE $1
      )
    ORDER BY frequency_count DESC
    LIMIT 1`,
    [`%${question.substring(0, 50)}%`]
  );

  if (result.rows.length > 0) {
    return { source: 'faq_db', ...result.rows[0] };
  }

  // Fall back to knowledge base
  const kb = await db.pool.query(`
    SELECT title, content FROM knowledge_base
    WHERE is_active = true
      AND (title ILIKE $1 OR content ILIKE $1)
    LIMIT 1`,
    [`%${question.substring(0, 50)}%`]
  );

  if (kb.rows.length > 0) {
    return { source: 'knowledge_base', question: kb.rows[0].title, answer: kb.rows[0].content };
  }

  return null;
}

module.exports = {
  generateFaqFromHistory,
  getPublishedFaqs,
  getAllFaqs,
  togglePublish,
  answerWithFaq
};
