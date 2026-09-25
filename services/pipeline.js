/**
 * One inbound-message pipeline shared by the OA and Bot channels.
 *
 * Both channels used to duplicate this logic, which is how the OA side ended
 * up without de-duplication. Everything now goes through handleMessage():
 * dedup → per-customer lock → paused inbox card (no model) → AI → HITL draft or reply → owner alerts.
 * Customer-facing text goes through services/hitlGate.js (HITL_REQUIRE_APPROVAL,
 * default on) so it is not sent until /admin approves it.
 */
const db = require('./database');
const ops = require('./ops');
const aiAgent = require('./aiAgent');
const notify = require('./notify');
const vietqr = require('./vietqr');
const kiotviet = require('./kiotviet');
const honorific = require('./honorific');
const zaloService = require('./zaloService');
const memory = require('./memory');
const drift = require('./drift');
const followup = require('./followup');
const priceMemo = require('./priceMemo');
const catalog = require('./catalog');
const money = require('./money');
const hitl = require('./hitlGate');
const stockGate = require('./stockGate');
const confidenceGate = require('./confidenceGate');
const audit = require('./audit');
const triage = require('./triage');
const faqDraft = require('./faqDraft');

const FALLBACK_REPLY =
  'Dạ farm đang bận xử lý một chút, bạn nhắn lại giúp mình sau ít phút nha 🌿 ' +
  'Hoặc gọi trực tiếp nếu gấp ạ.';

/** Shown on the HITL ticket when a paused customer messages again. */
const PAUSED_REASON = 'Bot đang tạm dừng — khách vừa nhắn';

/** Staff edit this before Duyệt và gửi. It is never auto-sent. */
const PAUSED_INBOX_REPLY =
  'Dạ farm đã nhận tin. Bot đang tạm dừng, nhân viên sẽ trả lời mình sớm ạ.';

/**
 * @param {object} p
 * @param {'oa'|'bot'|'messenger'} p.channel
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
      await noteInbound(p, p.text);
      try { require('./healthWatch').noteSuccess('pipeline'); } catch (_) {}
      if (p.typing) p.typing(p.replyTo).catch(() => {});

      let customer = await db.getOrCreateCustomer(p.externalKey, p.senderName);
      customer = await learnHonorific(customer, p);
      const triaged = triage.classify(p.text);

      // 2b. "ngưng bot" / "gặp người thật" — honoured before anything else.
      //     Deliberately decided from the raw text, not by the model: if a
      //     customer asks for a human, that must hold even when the AI is
      //     down, and must never be second-guessed.
      if (ops.wantsHuman(p.text)) {
        await db.saveMessage(p.externalKey, 'user', p.text);
        if (customer) await db.pauseBot(customer.id, 'Khách yêu cầu ngưng bot');

        const when = ops.isWorkingHours()
          ? 'Nhân viên farm sẽ trả lời bạn ngay ạ'
          : `Hiện đang ngoài giờ làm việc (${ops.workHoursText()}), farm sẽ phản hồi vào đầu giờ làm việc ạ`;
        const reply =
          `Dạ vâng ạ, em dừng trả lời tự động tại đây. ${when} 🌿\n\n` +
          `Bạn cứ để lại nội dung cần hỗ trợ, farm đọc hết và trả lời sớm nhất có thể ạ.`;

        const release = await hitl.releaseToCustomer(p, reply, {
          intent: p.text,
          customer,
          wantsHuman: true,
          urgency: 'high',
          reason: 'Khách chủ động yêu cầu ngưng bot',
          ticket_status: 'NEEDS_HUMAN',
          route: 'needs-human',
          triage: triaged,
        });
        await db.saveMessage(p.externalKey, 'assistant', reply);
        if (!release.held) log({ type: 'stop_bot', channel: p.channel, to: p.replyTo });

        return {
          ok: true,
          stopped: true,
          held: release.held,
          draftId: release.draft?.id || null,
          assignee: release.assignment?.assignee_name || null,
        };
      }

      // 3. A human already took this thread. Do not call the model and do
      //    not send. The new words still become a PENDING_REVIEW card so
      //    /admin does not drop Messenger or Zalo while bot_paused is set.
      //    Triage and urgency stay clear — this is not a new escalation.
      if (customer && customer.bot_paused) {
        await db.saveMessage(p.externalKey, 'user', p.text);
        const release = await hitl.releaseToCustomer(p, PAUSED_INBOX_REPLY, {
          intent: p.text,
          customer,
          customer_name: customer.display_name || p.senderName,
          forceHold: true,
          ack: false,
          handover: false,
          ticket_status: PAUSED_REASON,
          reason: PAUSED_REASON,
          clearTriage: true,
        });
        log({
          type: 'paused_skipped',
          channel: p.channel,
          to: p.replyTo,
          held: release.held,
          draft_id: release.draft?.id || null,
        });
        await notify.send(
          `💬 Khách đang chờ người thật vừa nhắn:\n"${String(p.text).slice(0, 200)}"\n\n` +
          `Mở lại bot: /mo ${p.externalKey}`
        );
        return {
          ok: true,
          skipped: 'paused',
          held: !!release.held,
          draftId: release.draft?.id || null,
        };
      }

      await db.saveMessage(p.externalKey, 'user', p.text);
      drift.noteQuestion(p.externalKey, p.text);
      // They came back on their own — reset the nudge counter.
      if (customer) followup.stopFor(customer.id).catch(() => {});

      // Refunds, returns, exchanges, complaints, and anger never reach the
      // model. The canned draft does not approve anything. It stays
      // PENDING_REVIEW and the roster handover still runs.
      if (triaged.skipModel) {
        return holdUrgent(p, customer, triaged, log);
      }

      // 2c. An angry customer must not receive one more automated reply, so
      //     this is settled before the model is called at all.
      if (drift.soundsAbusive(p.text)) {
        return stepAside(p, customer, {
          signal: 'anger', urgency: 'high',
          reason: 'Khách đang bực và có lời lẽ nặng — cần người thật xử lý ngay',
        }, log);
      }

      // A bare "ok" / "👍" / "cảm ơn" doesn't need a model call. Answering
      // these locally saves a full prompt every time, and they are common.
      const quick = quickReply(p.text);
      if (quick) {
        const release = await hitl.releaseToCustomer(p, quick, { intent: p.text, triage: triaged });
        await db.saveMessage(p.externalKey, 'assistant', quick);
        if (!release.held) log({ type: 'quick_reply', channel: p.channel, to: p.replyTo });
        return { ok: true, quick: true, held: release.held, draftId: release.draft?.id || null };
      }

      // 2d. Other drift signals — a long thread, a question asked three times,
      //     repeated dead-end lookups. Checked before answering, so the
      //     customer gets a hand over instead of one more wobbly answer.
      let msgCount = 0;
      if (customer && db.DB_ENABLED) {
        const c = await db.pool.query(
          'SELECT COUNT(*)::int AS n FROM messages WHERE customer_id=$1', [customer.id]);
        msgCount = c.rows[0].n;
      }
      const verdict = drift.assess(p.externalKey, { messageCount: msgCount, lastUserText: p.text });
      if (verdict.handoff) {
        return stepAside(p, customer, verdict, log);
      }

      // Sticker text, empty intent, jokes, and keyboard mash never become a
      // sales draft — and never spend a model call inventing one.
      const edge = confidenceGate.edgeCase(p.text);
      if (edge) {
        return urgentHuman(p, customer, {
          confidence: edge.confidence,
          reason: edge.reason,
          signal: 'low_confidence',
        }, log);
      }

      const grounded = await faqDraft.compose(p.text);
      if (grounded && grounded.handled) {
        const release = await hitl.releaseToCustomer(p, grounded.text, {
          intent: p.text,
          forceHold: true,
          ack: false,
          rewriteDv: false,
          triage: grounded.triage,
          needsHuman: grounded.reviewer.handoff === true,
          reason: grounded.reviewer.reason,
          urgency: grounded.reviewer.handoff ? 'high' : undefined,
          route: grounded.reviewer.handoff ? 'needs-human' : undefined,
          ticket_status: grounded.reviewer.handoff ? 'Cần người thật' : undefined,
          faq_review: grounded.reviewer,
        });
        return {
          ok: true,
          held: !!release.held,
          sent: false,
          draftId: release.draft && release.draft.id,
          faq: true,
          triage: grounded.triage && grounded.triage.level,
        };
      }

      const { text: reply, tokensUsed, handoff, newOrder, stockHold, confidence, piiNote } =
        await aiAgent.respond(p.externalKey, p.text);

      // Low / zero stock: the reply is a warning, not a confirmation.
      // Hold it for Sales even when HITL_REQUIRE_APPROVAL is off.
      // That warning wins over the confidence gate: it is not a fake sales pitch.
      const stockHeld = stockHold && (stockHold.decision === 'low' || stockHold.decision === 'blocked');

      if (!stockHeld && confidenceGate.isLow(confidence)) {
        return urgentHuman(p, customer, {
          confidence,
          reason:
            `Độ tin AI ${confidenceGate.formatPercent(confidence)} dưới ngưỡng ` +
            `${confidenceGate.formatPercent(confidenceGate.minConfidence())} — ` +
            `${confidenceGate.HUMAN_LABEL}`,
          signal: 'low_confidence',
          piiNote,
        }, log);
      }

      drift.noteAnswer(p.externalKey, reply);

      await db.saveMessage(p.externalKey, 'assistant', reply, {
        model: 'claude-sonnet-4-6',
        tokensUsed,
      });

      // HITL_REQUIRE_APPROVAL (default on): hold this text as PENDING_REVIEW.
      // Do not call p.send with the AI body. See services/hitlGate.js.
      const release = await hitl.releaseToCustomer(p, reply, {
        intent: p.text,
        forceHold: !!stockHeld,
        ack: stockHeld ? false : undefined,
        kiot_summary: stockHold?.summary || undefined,
        ticket_status: stockHeld ? 'Cần đối soát kho' : undefined,
        pii_note: piiNote || undefined,
        triage: triaged,
        rewriteDv: true,
      });
      if (!release.held) {
        log({
          type: 'replied',
          channel: p.channel,
          to: p.replyTo,
          reply: reply.slice(0, 120),
          tokensUsed,
          send_ok: !!release.sent,
        });
      }

      // Follow-through must not turn a held reply into a second customer send
      // if a later step throws.
      try {
        // Món nào giá đã thật sự nói ra trong tin vừa gửi thì ghi lại, để lần
        // sau câu kỹ thuật về món đó không lặp lại giá nữa. Ghi sau khi gửi, và
        // chỉ ghi món có con số nằm trong tin — nếu ghi lúc tra cứu, gặp lúc bot
        // bỏ mất giá thì khách sẽ không bao giờ được nghe giá món đó.
        // A draft is not "đã gửi" — skip until a person actually sends it.
        if (customer && !release.held) {
          const skus = priceMemo.skusTrongTin(reply, catalog.rows(), money);
          if (skus.length) priceMemo.ghiNhan(customer.id, skus).catch(() => {});
        }

        // Refresh the rolling summary in the background when it falls behind,
        // so the next turns still know what this conversation is about.
        if (customer && db.DB_ENABLED) {
          db.pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE customer_id=$1', [customer.id])
            .then(r => memory.maybeRefresh(customer, p.externalKey, r.rows[0].n))
            .catch(() => {});
        }

        // 4. Order follow-through: pay-by-QR for the customer, POS + alert for the farm.
        //    Customers write "ck", "stk", "gởi qr" far more often than
        //    "chuyển khoản", so trust the raw text, not only the model.
        const askedTransfer = vietqr.wantsTransfer(p.text);

        if (newOrder && !stockHeld) {
          await afterOrder(newOrder, p, log, askedTransfer);
        } else if (newOrder && stockHeld) {
          log({
            type: 'order_blocked_stock',
            order: newOrder.order_number,
            decision: stockHold.decision,
          });
        } else if (askedTransfer && vietqr.configured()) {
          await sendAccountInfo(p, log);
        }
        if (handoff) {
          await notify.handoff(
            { ...handoff, source: handoff.source || 'ai_handoff' },
            customer,
            p.text
          );
        }
      } catch (postErr) {
        console.error(`Pipeline follow-up error (${p.channel}):`, postErr);
        log({ type: 'error', channel: p.channel, error: postErr.message });
        await notify.send(`⚠️ Bot lỗi sau khi soạn trả lời (${p.channel}): ${postErr.message}`);
      }

      return {
        ok: true,
        tokensUsed,
        handoff: !!handoff,
        order: stockHeld ? null : (newOrder?.order_number || null),
        held: release.held,
        draftId: release.draft?.id || null,
        stock: stockHold?.decision || null,
        triage: triaged.level,
      };
    } catch (err) {
      console.error(`Pipeline error (${p.channel}):`, err);
      log({ type: 'error', channel: p.channel, error: err.message });
      try { require('./healthWatch').noteFailure('pipeline', 'exception'); } catch (_) {}
      // Same gate as a normal reply: the apology is customer-facing content.
      // With approval on, it becomes a draft. With approval off, it is sent.
      try {
        await hitl.releaseToCustomer(p, FALLBACK_REPLY, { intent: p.text });
      } catch (_) {}
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
/**
 * Work out whether to say "anh" or "chị", once per customer.
 *
 * The OA API actually reports gender, so ask it. The Bot API doesn't, so fall
 * back to the name — and only when the name is unambiguous. Everything else
 * stays unknown and the agent asks the customer directly.
 */
async function learnHonorific(customer, p) {
  if (!customer || !db.DB_ENABLED) return customer;
  if (customer.gender === 'male' || customer.gender === 'female') return customer;

  let gender = null;
  let fullName = customer.full_name || p.senderName || null;

  if (p.channel === 'oa') {
    try {
      const res = await zaloService.getUserProfile(p.externalKey);
      const d = res?.data || res || {};
      gender = honorific.fromZaloGender(d.user_gender);
      if (d.display_name) fullName = d.display_name;
      if (d.shared_info?.name) fullName = d.shared_info.name;
    } catch (e) {
      // Profile lookup is a nicety, never a blocker.
    }
  }

  if (!gender) gender = honorific.guessFromName(fullName);
  if (!gender) return customer;

  await db.setGender(customer.id, gender, fullName);
  return { ...customer, gender, full_name: fullName || customer.full_name };
}

/**
 * Low confidence, empty intent, or a non-text message.
 * Holds the short waiting line as PENDING_REVIEW and notifies whoever is on
 * shift. Does not set bot_paused — only an explicit wantsHuman phrase does.
 * The model sales text is not drafted and not sent.
 */
function urgentHuman(p, customer, info, log) {
  return stepAside(p, customer, {
    signal: info.signal || 'low_confidence',
    urgency: 'high',
    reason: info.reason || confidenceGate.HUMAN_LABEL,
  }, log, {
    reply: confidenceGate.WAITING_REPLY,
    forceHold: true,
    ack: false,
    ticket_status: confidenceGate.TICKET_STATUS,
    needsHuman: true,
    confidence: info.confidence,
    pii_note: info.piiNote,
  });
}

/**
 * Bow out gracefully: tell the customer, stop answering, and put the thread
 * in front of a person. Used whenever the bot is more likely to hurt than help.
 * options.forceHold keeps the text as a draft even when auto-send is on.
 */
async function stepAside(p, customer, verdict, log, options = {}) {
  const text = options.reply || drift.message(verdict.signal);
  try {
    const ticketStatus = options.ticket_status
      || ((verdict.urgency || 'high') === 'high' ? 'NEEDS_HUMAN' : 'HANDOFF');
    const release = await hitl.releaseToCustomer(p, text, {
      intent: p.text,
      forceHold: options.forceHold === true,
      ack: options.ack,
      ticket_status: ticketStatus,
      customer,
      source: 'step_aside',
      urgency: verdict.urgency || 'high',
      reason: verdict.reason,
      needsHuman: options.needsHuman === true || String(ticketStatus).includes('NEEDS_HUMAN'),
      pii_note: options.pii_note || undefined,
      route: 'needs-human',
      triage: options.triage,
    });
    await db.saveMessage(p.externalKey, 'assistant', text);
    if (customer) {
      // Do not pause. bot_paused is only for ops.wantsHuman (and /dung).
      // A low-confidence or needs-human card must not silence the next message.
      await followup.optOut(customer.id);
    }
    drift.markHandedOff(p.externalKey);

    log({
      type: 'stepped_aside',
      channel: p.channel,
      signal: verdict.signal,
      to: p.replyTo,
      held: release.held,
      needs_human: options.needsHuman === true || String(ticketStatus).includes('NEEDS_HUMAN'),
      assignee: release.assignment?.assignee_name || null,
    });
    return {
      ok: true,
      steppedAside: verdict.signal,
      held: release.held,
      draftId: release.draft?.id || null,
      needsHuman: options.needsHuman === true || String(ticketStatus).includes('NEEDS_HUMAN'),
      confidence: options.confidence ?? null,
      assignee: release.assignment?.assignee_name || null,
      triage: options.triage?.level || release.triage || null,
    };
  } catch (e) {
    console.error('stepAside failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Urgent after-sales and complaints skip the model. The reply is the
 * shared canned text from services/triage.js. The draft stays
 * PENDING_REVIEW and releaseToCustomer assigns whoever is on shift.
 * The bot is not paused.
 */
function holdUrgent(p, customer, triaged, log) {
  return stepAside(p, customer, {
    signal: triaged.kind || 'triage_urgent',
    urgency: 'high',
    reason: triaged.reason,
  }, log, {
    reply: triage.customerReply(triaged),
    forceHold: true,
    ack: false,
    ticket_status: 'NEEDS_HUMAN',
    needsHuman: true,
    triage: triaged,
  });
}

/**
 * Acknowledgements that carry no question. Matched strictly — the whole
 * message must be one of these — so a real question is never swallowed.
 */
const ACKS = new Map([
  ['ok', 'Dạ vâng ạ 🌿'],
  ['okie', 'Dạ vâng ạ 🌿'],
  ['oki', 'Dạ vâng ạ 🌿'],
  ['okay', 'Dạ vâng ạ 🌿'],
  ['vâng', 'Dạ 🌿'],
  ['dạ', 'Dạ 🌿'],
  ['ừ', 'Dạ 🌿'],
  ['uh', 'Dạ 🌿'],
  ['um', 'Dạ 🌿'],
  ['cảm ơn', 'Dạ farm cảm ơn bạn nhiều ạ 🌿'],
  ['cám ơn', 'Dạ farm cảm ơn bạn nhiều ạ 🌿'],
  ['thanks', 'Dạ farm cảm ơn bạn nhiều ạ 🌿'],
  ['thank you', 'Dạ farm cảm ơn bạn nhiều ạ 🌿'],
  ['tks', 'Dạ farm cảm ơn bạn nhiều ạ 🌿'],
  ['thank', 'Dạ farm cảm ơn bạn nhiều ạ 🌿'],
]);
const ACK_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;

function quickReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.length <= 8 && ACK_EMOJI.test(raw)) return 'Dạ 🌿';

  const t = raw.toLowerCase().replace(/[.!,~\s]+$/g, '').trim();
  if (t.length > 20) return null;
  return ACKS.get(t) || null;
}

/** Customer asked for our account or a QR but hasn't ordered yet. */
async function sendAccountInfo(p, log) {
  try {
    const url = vietqr.imageUrl(0, '');
    const text = vietqr.accountInfoMessage();
    if (hitl.hitlRequired()) {
      const body = (p.sendPhoto && url) ? text : `${text}\n\n${url || ''}`.trim();
      await hitl.releaseToCustomer(p, body, {
        ack: false,
        intent: p.text,
        qr_image_url: url || null,
      });
    } else if (p.sendPhoto && url) {
      await p.sendPhoto(p.replyTo, url, text);
    } else {
      await p.send(p.replyTo, `${text}\n\n${url || ''}`.trim());
    }
    log({ type: 'account_info_sent', channel: p.channel, held: hitl.hitlRequired() });
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
      const caption = vietqr.caption(order);
      if (hitl.hitlRequired()) {
        const body = p.sendPhoto ? caption : `${caption}\n\n${url}`;
        await hitl.releaseToCustomer(p, body, {
          ack: false,
          intent: p.text,
          qr_image_url: p.sendPhoto ? url : null,
          kiot_summary: order.order_number ? `Đơn ${order.order_number}` : null,
        });
      } else if (p.sendPhoto) {
        await p.sendPhoto(p.replyTo, url, caption);
      } else {
        await p.send(p.replyTo, `${caption}\n\n${url}`);
      }
      log({ type: 'qr_sent', order: order.order_number, held: hitl.hitlRequired() });
    }
  } catch (e) {
    console.error('QR send failed:', e.message);
  }

  // b) KiotViet — live stock again, in case it moved after the draft was built.
  //    Below STOCK_LOW_THRESHOLD, or short of the requested qty: do not push.
  let kiot = { ok: false, error: 'KiotViet tắt' };
  if (kiotviet.enabled()) {
    const stock = await stockGate.assessItems(order.items || []);
    if (stock.decision === 'low' || stock.decision === 'blocked') {
      kiot = {
        ok: false,
        blocked: true,
        stock,
        error: stock.decision === 'low'
          ? 'Sắp hết hàng — chưa đẩy KiotViet, chờ Sales đối soát'
          : 'Không đủ tồn — chưa đẩy KiotViet',
      };
      log({
        type: 'kiotviet_stock_blocked',
        order: order.order_number,
        decision: stock.decision,
        summary: stock.summary,
      });
      await noteOrderPush(order, p, 'order.push_blocked', kiot);
    } else {
      kiot = await kiotviet.pushOrder(order);
      log({ type: 'kiotviet_push', order: order.order_number, ok: kiot.ok, error: kiot.error || null });
      await noteOrderPush(order, p, kiot.ok ? 'order.pushed' : 'order.push_failed', kiot);
      if (kiot.ok && db.DB_ENABLED) {
        await db.pool.query(
          `UPDATE orders SET description = COALESCE(description,'') || $2 WHERE order_number = $1`,
          [order.order_number, ` [KiotViet: ${kiot.kiotOrderCode || 'đã tạo'}]`]
        ).catch(() => {});
      }
    }
  }

  // c) Farm alert, including whatever went wrong with the POS push.
  await notify.newOrder({ ...order, kiot });
}

/**
 * Non-text messages. Zalo sends images, stickers, files and voice notes.
 * We cannot read them, so a warm guess ("bạn cần tư vấn gì?") is a sales
 * draft that pretends to understand. Hold the waiting line for a person.
 * Payment screenshots still ping the farm directly.
 */
const UNCLEAR_KINDS = new Set(['image', 'sticker', 'audio', 'video', 'file']);

async function handleNonText(p) {
  const log = p.log || (() => {});
  if (!(await ops.isNewEvent(p.msgId, p.channel))) return { skipped: 'duplicate' };
  if (!UNCLEAR_KINDS.has(p.kind)) return { skipped: 'ignored' };

  const shown = `[${p.kind}]`;
  const inbound = { ...p, text: shown };

  try {
    const customer = await db.getOrCreateCustomer(p.externalKey, p.senderName);
    await noteInbound(p, shown);
    await db.saveMessage(p.externalKey, 'user', shown);

    // An image is very often a bank transfer receipt — the farm should look.
    if (p.kind === 'image') {
      await notify.send(
        `📸 Khách vừa gửi ảnh (có thể là chuyển khoản).\n` +
        `Xem tại ${p.channel === 'messenger' ? 'Facebook Messenger' : 'Zalo'}. Khách: ${p.senderName || p.externalKey}`
      );
    }

    return urgentHuman(inbound, customer, {
      confidence: 0,
      signal: 'non_text',
      reason: `Khách gửi ${p.kind} — không đủ ý để trả lời tự động. ${confidenceGate.HUMAN_LABEL}`,
    }, log);
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
    const release = await hitl.releaseToCustomer(p, text, { intent: 'Khách vừa quan tâm OA' });
    await db.saveMessage(p.externalKey, 'assistant', text);
    if (!release.held) log({ type: 'follow_welcomed', channel: p.channel });
    return { ok: true, held: release.held, draftId: release.draft?.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function noteInbound(p, text) {
  try { require('./healthWatch').noteInbound(p.channel); } catch (_) { /* health must not block a draft */ }
  const conversation = String(p.externalKey || '').trim();
  if (!conversation) return;
  await audit.record({
    actor: 'system',
    action: 'message.received',
    entity_type: 'conversation',
    entity_id: conversation,
    before: null,
    after: {
      received_at: new Date().toISOString(),
      channel: p.channel || null,
      sender_name: p.senderName || null,
      summary: audit.summarize(text),
    },
    meta: {
      conversation_id: conversation,
      channel: p.channel || null,
      msg_id: p.msgId || null,
    },
  });
}

async function noteOrderPush(order, p, action, kiot) {
  const orderNumber = String(order && order.order_number || '').trim();
  if (!orderNumber) return;
  const conversation = String(p.externalKey || '').trim() || null;
  await audit.record({
    actor: order.staff_name ? audit.staffActor(order.staff_name) : 'system',
    action,
    entity_type: 'order',
    entity_id: orderNumber,
    before: null,
    after: audit.orderSnapshot(order, kiot),
    meta: {
      conversation_id: conversation,
      order_number: orderNumber,
      source: 'kiotviet',
      automated: !order.staff_name,
    },
  });
}

module.exports = {
  handleMessage,
  handleNonText,
  handleFollow,
  FALLBACK_REPLY,
  PAUSED_REASON,
  PAUSED_INBOX_REPLY,
};
