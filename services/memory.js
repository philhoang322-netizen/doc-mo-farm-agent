/**
 * Rolling conversation summary.
 *
 * The agent sees the recent turns verbatim plus this summary, so a customer on
 * their fifteenth message is still talking to someone who remembers the first.
 * The summary is refreshed by a small, cheap model every few messages — not on
 * every message — so long memory costs a fraction of what resending the whole
 * transcript would.
 */
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const llm = require('./llm');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const EVERY_N_MESSAGES = Number(process.env.SUMMARY_EVERY || 8);
const MAX_SUMMARY_CHARS = 900;

const SYSTEM = `Bạn tóm tắt cuộc trò chuyện giữa khách và trợ lý bán hàng của Dốc Mơ Farm.

Mục đích: giúp trợ lý nhớ khách này là ai và hai bên đã nói gì, ở những lượt sau.

CHỈ ghi những điều còn giá trị về sau:
- Khách là ai, xưng hô thế nào, ở đâu, số điện thoại (nếu có nói).
- Sản phẩm khách quan tâm, đã hỏi gì, đã được trả lời gì.
- Điều khách băn khoăn hoặc từ chối, và lý do.
- Đơn đã đặt, đã chốt gì, còn chờ gì.
- Hẹn hò, cam kết: farm hứa gì, khi nào.
- Sở thích, thói quen, hoàn cảnh riêng khách kể ra.

BỎ QUA: lời chào, cảm ơn, câu xã giao, những đoạn không dẫn tới đâu.

Viết tiếng Việt, gạch đầu dòng ngắn, tối đa 10 dòng.
Chỉ ghi điều KHÁCH hoặc TRỢ LÝ thật sự đã nói. Không suy diễn, không thêm thắt.
Nếu chưa có gì đáng nhớ, trả về đúng chữ: (chưa có gì)`;

/** Should we refresh the summary for this customer right now? */
function isDue(customer, messageCount) {
  if (!customer) return false;
  const upto = customer.convo_summary_upto || 0;
  return messageCount - upto >= EVERY_N_MESSAGES;
}

/**
 * Rebuild the summary from the older part of the conversation.
 * Runs in the background: a customer should never wait for bookkeeping.
 */
async function refresh(customer, externalKey) {
  if (!db.DB_ENABLED || !customer || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const rows = await db.pool.query(
      `SELECT role, content FROM messages
       WHERE customer_id = $1 ORDER BY created_at ASC LIMIT 120`,
      [customer.id]
    );
    if (rows.rows.length < 4) return null;

    const transcript = rows.rows
      .map(m => `${m.role === 'user' ? 'Khách' : 'Trợ lý'}: ${String(m.content).slice(0, 400)}`)
      .join('\n');

    const { response: res } = await llm.anthropicCreate(claude, {
      model: SUMMARY_MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content:
          (customer.convo_summary
            ? `Tóm tắt đang có:\n${customer.convo_summary}\n\nToàn bộ hội thoại:\n`
            : 'Hội thoại:\n') + transcript,
      }],
    });

    let text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text || /^\(chưa có gì\)$/i.test(text)) text = null;
    if (text && text.length > MAX_SUMMARY_CHARS) text = text.slice(0, MAX_SUMMARY_CHARS) + '…';

    await db.pool.query(
      `UPDATE customers SET convo_summary=$2, convo_summary_at=NOW(), convo_summary_upto=$3
       WHERE id=$1`,
      [customer.id, text, rows.rows.length]
    );

    const used = (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0);
    console.log(`🧠 Tóm tắt hội thoại cho ${externalKey}: ${used} token (${SUMMARY_MODEL})`);
    return text;
  } catch (e) {
    console.warn('Summary refresh failed:', e.message);
    return null;
  }
}

/** Fire-and-forget: refresh if due, never block the reply. */
function maybeRefresh(customer, externalKey, messageCount) {
  if (!isDue(customer, messageCount)) return;
  refresh(customer, externalKey).catch(() => {});
}

module.exports = { refresh, maybeRefresh, isDue, EVERY_N_MESSAGES };
