/**
 * One inbound-message pipeline shared by the OA and Bot channels.
 *
 * Both channels used to duplicate this logic, which is how the OA side ended
 * up without de-duplication. Everything now goes through handleMessage():
 * dedup → per-customer lock → paused check → AI → reply → owner alerts.
 */
const db = require('./database');
const ops = require('./ops');
const aiAgent = require('./aiAgent');
const notify = require('./notify');
const vietqr = require('./vietqr');
const kiotviet = require('./kiotviet');

const FALLBACK_REPLY =
  'Dạ farm đang bận xử lý một chút, bạn nhắn lại giúp mình sau ít phút nha 🌿 ' +
  'Hoặc gọi trực tiếp nếu gấp ạ.';

/**
 * @param {object} p
 * @param {'oa'|'bot'} p.channel
 * @param {string} p.externalKey  channel-scoped customer key (already prefixed for bot)
 * @param {string} p.replyTo      id to send the answer to
 * @param {string} p.text         the customer's message
 * @param {string} [p.msgId]      for de-duplication
 * @param {string} [p.senderName]
 * @param {function} p.send       (replyTo, text) => Promise
 * @param {function} [p.typing]   (replyTo) => Promise
 * @param {function} [p.log]      event logger
 */
async function handleMessage(p) {
  const log = p.log || (() => {});

  // 1. Zalo retries slow webhooks — answer each message once.
  if (!(await ops.isNewEvent(p.msgId, p.channel))) {
    log({ type: 'duplicate_skipped', channel: p.channel, msgId: p.msgId });
    return { skipped: 'duplicate' };
  }

  // 2. Serialize per customer so two quick messages can't produce two
  //    replies built from the same stale history.
  return ops.withLock(`${p.channel}:${p.externalKey}`, async () => {
    try {
      if (p.typing) p.typing(p.replyTo).catch(() => {});

      const customer = await db.getOrCreateCustomer(p.externalKey, p.senderName);

      // 3. A human took over this conversation — stay out of the way.
      if (customer && customer.bot_paused) {
        await db.saveMessage(p.externalKey, 'user', p.text);
        log({ type: 'paused_skipped', channel: p.channel, to: p.replyTo });
        await notify.send(
          `💬 Khách đang chờ người thật vừa nhắn:\n"${String(p.text).slice(0, 200)}"\n\n` +
          `Mở lại bot: /mo ${p.externalKey}`
        );
        return { skipped: 'paused' };
      }

      await db.saveMessage(p.externalKey, 'user', p.text);

      const { text: reply, tokensUsed, handoff, newOrder } =
        await aiAgent.respond(p.externalKey, p.text);

      await db.saveMessage(p.externalKey, 'assistant', reply, {
        model: 'claude-sonnet-4-6',
        tokensUsed,
      });

      const sent = await p.send(p.replyTo, reply);
      log({
        type: 'replied',
        channel: p.channel,
        to: p.replyTo,
        reply: reply.slice(0, 120),
        tokensUsed,
        send_ok: !!sent,
      });

      // 4. Order follow-through: pay-by-QR for the customer, POS + alert for the farm.
      //    Customers write "ck", "stk", "gởi qr" far more often than
      //    "chuyển khoản", so trust the raw text, not only the model.
      const askedTransfer = vietqr.wantsTransfer(p.text);

      if (newOrder) {
        await afterOrder(newOrder, p, log, askedTransfer);
      } else if (askedTransfer && vietqr.configured()) {
        await sendAccountInfo(p, log);
      }
      if (handoff) await notify.handoff(handoff, customer, p.text);

      return { ok: true, tokensUsed, handoff: !!handoff, order: newOrder?.order_number || null };
    } catch (err) {
      console.error(`Pipeline error (${p.channel}):`, err);
      log({ type: 'error', channel: p.channel, error: err.message });
      // Never leave the customer staring at silence.
      try { await p.send(p.replyTo, FALLBACK_REPLY); } catch (_) {}
      await notify.send(`⚠️ Bot lỗi khi trả lời khách (${p.channel}): ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}

/**
 * Everything that happens once an order exists: send the customer a VietQR
 * payment code, push the order into KiotViet, and tell the farm.
 *
 * Runs after the reply has already been delivered, and each step is wrapped
 * on its own — a POS outage must not cost the customer their confirmation.
 */
/** Customer asked for our account or a QR but hasn't ordered yet. */
async function sendAccountInfo(p, log) {
  try {
    const url = vietqr.imageUrl(0, '');
    const text = vietqr.accountInfoMessage();
    if (p.sendPhoto && url) await p.sendPhoto(p.replyTo, url, text);
    else await p.send(p.replyTo, `${text}\n\n${url || ''}`.trim());
    log({ type: 'account_info_sent', channel: p.channel });
  } catch (e) {
    console.error('Account info send failed:', e.message);
  }
}

async function afterOrder(order, p, log, askedTransfer = false) {
  // a) Payment QR. Skip only when it's genuinely cash on delivery — if the
  //    customer said ck/stk/qr in this very message, send it regardless of
  //    what the model recorded as the payment method.
  try {
    const cod = String(order.payment || 'cod').toLowerCase() === 'cod' && !askedTransfer;
    const url = vietqr.imageUrl(order.total, order.order_number);
    if (!cod && url) {
      if (p.sendPhoto) await p.sendPhoto(p.replyTo, url, vietqr.caption(order));
      else await p.send(p.replyTo, `${vietqr.caption(order)}\n\n${url}`);
      log({ type: 'qr_sent', order: order.order_number });
    }
  } catch (e) {
    console.error('QR send failed:', e.message);
  }

  // b) KiotViet
  let kiot = { ok: false, error: 'KiotViet tắt' };
  if (kiotviet.enabled()) {
    kiot = await kiotviet.pushOrder(order);
    log({ type: 'kiotviet_push', order: order.order_number, ok: kiot.ok, error: kiot.error || null });
    if (kiot.ok && db.DB_ENABLED) {
      await db.pool.query(
        `UPDATE orders SET description = COALESCE(description,'') || $2 WHERE order_number = $1`,
        [order.order_number, ` [KiotViet: ${kiot.kiotOrderCode || 'đã tạo'}]`]
      ).catch(() => {});
    }
  }

  // c) Farm alert, including whatever went wrong with the POS push.
  await notify.newOrder({ ...order, kiot });
}

/**
 * Non-text messages. Zalo sends images, stickers, files and voice notes;
 * answering something warm beats silence, and payment screenshots need a human.
 */
async function handleNonText(p) {
  const log = p.log || (() => {});
  if (!(await ops.isNewEvent(p.msgId, p.channel))) return { skipped: 'duplicate' };

  const kinds = {
    image: 'Dạ farm nhận được ảnh của bạn rồi ạ! 📸 Bạn nhắn thêm vài chữ cho farm biết ảnh này là gì nha — ' +
           'ảnh sản phẩm, ảnh chuyển khoản hay bạn muốn hỏi gì ạ?',
    sticker: 'Dạ 😊🌿 Bạn cần farm tư vấn gì không ạ?',
    audio: 'Dạ farm nhận được tin nhắn thoại ạ. Bạn gõ giúp farm vài chữ được không — ' +
           'trợ lý chưa nghe được voice, farm sợ trả lời sai ý bạn 🙏',
    video: 'Dạ farm nhận được video của bạn rồi ạ! Bạn mô tả ngắn giúp farm nội dung nha 🌿',
    file: 'Dạ farm nhận được tệp của bạn ạ. Bạn nói rõ nội dung giúp farm nha 🌿',
    link: null, // links are handled as plain text
  };

  const reply = kinds[p.kind];
  if (!reply) return { skipped: 'ignored' };

  try {
    await db.getOrCreateCustomer(p.externalKey, p.senderName);
    await db.saveMessage(p.externalKey, 'user', `[${p.kind}]`);
    await p.send(p.replyTo, reply);
    log({ type: 'non_text_replied', channel: p.channel, kind: p.kind });

    // An image is very often a bank transfer receipt — the farm should look.
    if (p.kind === 'image') {
      await notify.send(
        `📸 Khách vừa gửi ảnh (có thể là chuyển khoản).\n` +
        `Xem tại Zalo. Khách: ${p.senderName || p.externalKey}`
      );
    }
    return { ok: true };
  } catch (e) {
    console.error('Non-text handling failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/** Someone just followed the OA — greet them once. */
async function handleFollow(p) {
  const log = p.log || (() => {});
  try {
    await db.getOrCreateCustomer(p.externalKey, p.senderName);
    const text =
      'Dạ em chào bạn, cảm ơn bạn đã quan tâm Dốc Mơ Farm 🌿\n\n' +
      'Farm mình làm thủ công các sản phẩm organic: nước nghệ / nước gừng lên men, ' +
      'xúc xích, chuối sấy, dầu gội, dầu tắm.\n\n' +
      'Bạn muốn tìm hiểu sản phẩm nào, nhắn em nha!';
    await p.send(p.replyTo, text);
    await db.saveMessage(p.externalKey, 'assistant', text);
    log({ type: 'follow_welcomed', channel: p.channel });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { handleMessage, handleNonText, handleFollow, FALLBACK_REPLY };
