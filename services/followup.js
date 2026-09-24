/**
 * Coming back to customers who went quiet.
 *
 * A customer asks the price, gets an answer, and disappears. Nothing is wrong
 * with the conversation — it simply stopped, and stopped conversations are
 * where most chat sales are lost. One specific, unhurried message that refers
 * to what they were actually asking about brings a meaningful share of them
 * back.
 *
 * The restraint matters more than the reach:
 *   - two messages, ever. Then we leave them alone.
 *   - daytime only. A sales nudge at 11pm costs a customer.
 *   - never after an order, never while a person is handling the thread,
 *     never to someone who asked the bot to stop.
 *   - no invented discount, no false scarcity, no pressure.
 */
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const ops = require('./ops');
const notify = require('./notify');
const zaloService = require('./zaloService');
const botService = require('./zaloBotService');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const hitl = require('./hitlGate');
const llm = require('./llm');
const pii = require('./pii');

const MODEL = process.env.FOLLOWUP_MODEL || 'claude-haiku-4-5-20251001';
const STAGE_HOURS = [
  Number(process.env.FOLLOWUP_H1 || 6),   // same day, while intent is warm
  Number(process.env.FOLLOWUP_H2 || 48),  // two days later, then stop
];
const MAX_STAGE = 2;
const SEND_FROM = 8;   // local hours
const SEND_TO = 20;

const SYSTEM = `Bạn viết MỘT tin nhắn ngắn cho khách của Dốc Mơ Farm đã im lặng sau khi hỏi về sản phẩm.

MỤC ĐÍCH: mở lại cuộc trò chuyện một cách tử tế, không thúc ép.

BẮT BUỘC
- Nhắc đúng thứ khách đã hỏi. Cụ thể, không chung chung.
- Tối đa 3 câu. Kết bằng ĐÚNG MỘT câu hỏi dễ trả lời.
- Giọng farm: ấm, chậm, khiêm cung. Xưng "farm" hoặc "em".
- Tôn trọng: khách có quyền im lặng, và mình nói rõ là không phiền nữa nếu họ chưa cần.

TUYỆT ĐỐI KHÔNG
- Không bịa giảm giá, khuyến mãi, quà tặng, số lượng còn lại.
- Không bịa công dụng hay con số.
- Không giục, không "chỉ còn hôm nay", không "nhanh tay".
- Không nhắc lại toàn bộ bảng giá.
- Không emoji quá một cái.

Chỉ trả về nội dung tin nhắn. Không tiêu đề, không giải thích.`;

function withinSendingHours(now = new Date()) {
  const hh = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ_NAME || 'Asia/Ho_Chi_Minh',
    hour: '2-digit', hour12: false,
  }).format(now));
  return hh >= SEND_FROM && hh < SEND_TO;
}

/** Customers who look worth one gentle nudge. */
async function findStalled() {
  if (!db.DB_ENABLED) return [];
  const rows = await db.pool.query(
    `SELECT c.id, c.display_name, c.full_name, c.gender, c.phone,
            c.convo_summary, c.followup_stage, c.last_seen_at,
            (SELECT i.external_id FROM customer_identities i
              WHERE i.customer_id = c.id ORDER BY i.created_at LIMIT 1) AS ext,
            (SELECT i.channel FROM customer_identities i
              WHERE i.customer_id = c.id ORDER BY i.created_at LIMIT 1) AS channel,
            (SELECT COUNT(*)::int FROM messages m WHERE m.customer_id = c.id) AS msgs,
            (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = c.id) AS orders
     FROM customers c
     WHERE c.bot_paused = FALSE
       AND c.followup_optout = FALSE
       AND c.followup_stage < $1
       AND c.last_seen_at < NOW() - ($2 || ' hours')::interval
       AND c.last_seen_at > NOW() - INTERVAL '6 days'
     ORDER BY c.last_seen_at DESC
     LIMIT 25`,
    [MAX_STAGE, String(STAGE_HOURS[0])]
  );

  return rows.rows.filter(c => {
    if (c.orders > 0) return false;        // they bought; leave them be
    if (c.msgs < 2) return false;          // never really started a conversation
    const need = STAGE_HOURS[c.followup_stage] ?? STAGE_HOURS[STAGE_HOURS.length - 1];
    const idleH = (Date.now() - new Date(c.last_seen_at).getTime()) / 3.6e6;
    return idleH >= need;
  });
}

/** Write the message. Falls back to a safe generic line if the model fails. */
async function compose(c) {
  const stage = c.followup_stage || 0;
  const context = c.convo_summary
    || 'Khách có hỏi về sản phẩm của farm nhưng chưa nói rõ điều gì.';

  const brief = stage === 0
    ? 'Đây là lần nhắc đầu tiên, vài giờ sau khi khách im lặng. Nhẹ nhàng hỏi xem khách còn thắc mắc gì không.'
    : 'Đây là lần nhắc CUỐI CÙNG, hai ngày sau. Nói rõ là farm sẽ không làm phiền thêm, và cửa vẫn mở nếu khách cần.';

  const fallback = stage === 0
    ? 'Dạ farm ghé hỏi thăm chút, mình còn thắc mắc gì về sản phẩm không ạ? Farm sẵn sàng tư vấn thêm nhen 🌿'
    : 'Dạ farm không làm phiền mình thêm nữa. Khi nào cần, mình cứ nhắn, farm luôn ở đây ạ 🌿';

  try {
    const { response: res, piiReport } = await llm.anthropicCreate(claude, {
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `${brief}\n\nNhững gì đã trao đổi với khách này:\n${context}`,
      }],
    });
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (text) return { text, piiNote: pii.describe(piiReport) };
  } catch (e) {
    console.warn('Follow-up compose failed:', e.message);
  }

  return { text: fallback, piiNote: null };
}

/** One pass. Safe to call often; it only acts on who is actually due. */
async function run(reason = 'scheduled') {
  if (process.env.FOLLOWUP_ENABLED === 'false') return { skipped: 'disabled' };
  if (!db.DB_ENABLED) return { skipped: 'no-db' };
  if (!withinSendingHours()) return { skipped: 'outside-hours' };

  let sent = 0;
  let held = 0;
  try {
    const due = await findStalled();
    for (const c of due) {
      if (!c.ext) continue;
      const composed = await compose(c);
      const text = composed.text;

      // Same gate as inbound replies: a nudge is AI sales copy.
      if (hitl.hitlRequired()) {
        const release = await hitl.releaseToCustomer(followupTarget(c), text, {
          ack: false,
          intent: c.convo_summary || 'Khách im lặng sau khi hỏi sản phẩm',
          customer_name: c.display_name || c.full_name || null,
          pii_note: composed.piiNote,
        });
        if (!release.held) continue;
        await db.saveMessage(c.ext, 'assistant', text);
        await db.pool.query(
          `UPDATE customers SET followup_stage = followup_stage + 1,
                                followup_last_at = NOW()
           WHERE id = $1`, [c.id]);
        held++;
        console.log(`📝 Nhắc khách ${c.display_name || c.ext} chờ duyệt (lần ${(c.followup_stage || 0) + 1})`);
        continue;
      }

      const ok = c.channel === 'bot'
        ? await botService.sendMessage(String(c.ext).replace(/^bot_/, ''), text)
        : await zaloService.sendTextMessage(c.ext, text);

      if (!ok) {
        // Most often the OA 7-day window has closed. Stop trying this customer.
        await db.pool.query(
          'UPDATE customers SET followup_optout = TRUE WHERE id = $1', [c.id]);
        continue;
      }

      await db.saveMessage(c.ext, 'assistant', text);
      await db.pool.query(
        `UPDATE customers SET followup_stage = followup_stage + 1,
                              followup_last_at = NOW()
         WHERE id = $1`, [c.id]);
      sent++;
      console.log(`📮 Nhắc khách ${c.display_name || c.ext} (lần ${(c.followup_stage || 0) + 1})`);
    }

    if (sent) {
      await notify.send(`📮 Đã nhắn hỏi thăm ${sent} khách im lặng (${reason}).`);
    }
    if (held) {
      await notify.send(`📝 ${held} tin nhắc khách đang chờ duyệt trên /admin (${reason}).`);
    }
    return { ok: true, sent, held, considered: due.length };
  } catch (e) {
    console.error('Follow-up run failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Shape a stalled customer the same way the inbound pipeline does, so deliver() still works. */
function followupTarget(c) {
  const name = c.display_name || c.full_name || null;
  const intent = c.convo_summary || 'Khách im lặng sau khi hỏi sản phẩm';
  const refuseSend = async () => {
    throw new Error('HITL follow-up must not call send');
  };
  if (c.channel === 'bot') {
    const chatId = String(c.ext).replace(/^bot_/, '');
    return {
      channel: 'bot',
      externalKey: `bot_${chatId}`,
      replyTo: chatId,
      senderName: name,
      text: intent,
      send: refuseSend,
    };
  }
  return {
    channel: 'oa',
    externalKey: String(c.ext),
    replyTo: String(c.ext),
    senderName: name,
    text: intent,
    send: refuseSend,
  };
}

/** A customer who replies, orders, or asks for a human is done being nudged. */
async function stopFor(customerId) {
  if (!db.DB_ENABLED || !customerId) return;
  await db.pool.query(
    'UPDATE customers SET followup_stage = 0 WHERE id = $1', [customerId]
  ).catch(() => {});
}

async function optOut(customerId) {
  if (!db.DB_ENABLED || !customerId) return;
  await db.pool.query(
    'UPDATE customers SET followup_optout = TRUE WHERE id = $1', [customerId]
  ).catch(() => {});
}

function start() {
  if (process.env.FOLLOWUP_ENABLED === 'false') {
    console.log('ℹ️  Follow-up disabled');
    return;
  }
  const t = setInterval(() => run('scheduled').catch(() => {}), 30 * 60 * 1000);
  if (t.unref) t.unref();
  console.log('📮 Nhắc khách im lặng: quét mỗi 30 phút, chỉ gửi trong giờ 8h–20h');
}

module.exports = { run, start, stopFor, optOut, findStalled, withinSendingHours };
