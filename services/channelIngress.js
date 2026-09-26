/**
 * Zalo OA and Zalo Bot webhooks.
 *
 * Inbound text becomes a PENDING_REVIEW draft. These handlers pass the
 * customer send functions through, but those functions throw unless a
 * person approved that exact message on /admin.
 *
 * AUTO-SEND IS FORBIDDEN until the owner explicitly re-enables it in a
 * future PR. Typing indicators are not sent.
 */
const crypto = require('crypto');
const db = require('./database');
const selfCheck = require('./selfCheck');
const notify = require('./notify');
const zaloService = require('./zaloService');
const botService = require('./zaloBotService');

function esc(s) {
  return String(s || '').replace(/[<>]/g, '').slice(0, 40);
}

async function handleOwnerCommand(text, reply) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return false;

  const [cmd, ...rest] = t.split(/\s+/);
  const arg = rest.join(' ').trim();

  try {
    if (cmd === '/mo' || cmd === '/resume') {
      if (!arg) return reply('Cú pháp: /mo <id khách>'), true;
      const c = await db.getCustomerByExternalId(arg);
      if (!c) return reply(`Không tìm thấy khách: ${arg}`), true;
      await db.resumeBot(c.id);
      await reply(`✅ Đã mở lại bot cho ${c.display_name || arg}`);
      return true;
    }

    if (cmd === '/dung' || cmd === '/pause') {
      if (!arg) return reply('Cú pháp: /dung <id khách>'), true;
      const c = await db.getCustomerByExternalId(arg);
      if (!c) return reply(`Không tìm thấy khách: ${arg}`), true;
      await db.pauseBot(c.id, 'Chủ farm tạm dừng');
      await reply(`⏸️ Đã tạm dừng bot cho ${c.display_name || arg}. Mở lại: /mo ${arg}`);
      return true;
    }

    if (cmd === '/cho' || cmd === '/waiting') {
      const rows = await db.listPaused();
      if (rows.length === 0) return reply('Không có khách nào đang chờ người thật ✅'), true;
      const lines = rows.map(r => {
        const id = (r.identities || [])[0]?.external_id || r.id;
        return `• ${r.display_name || 'Khách'}${r.phone ? ` · ${r.phone}` : ''}\n  ${r.paused_reason || ''}\n  mở lại: /mo ${id}`;
      });
      await reply(`⏳ ${rows.length} khách đang chờ:\n\n${lines.join('\n\n')}`);
      return true;
    }

    if (cmd === '/tinhtrang' || cmd === '/status') {
      const h = await selfCheck.run('owner-command');
      const head = h.healthy ? '💚 Hệ thống bình thường' : `💛 ${h.problems.length} vấn đề`;
      const c = h.counts || {};
      await reply(
        `${head}\n\n` +
        `👥 Khách: ${c.customers ?? '?'} · 💬 Tin: ${c.messages ?? '?'} · 🛒 Đơn: ${c.orders ?? '?'}\n` +
        `📨 Tin 24h: ${h.messages_24h ?? '?'}\n` +
        (h.problems?.length ? `\n${h.problems.map(x => '• ' + x).join('\n')}` : '')
      );
      return true;
    }

    if (cmd === '/help' || cmd === '/lenh') {
      await reply(
        'Lệnh dành cho farm:\n' +
        '/cho — khách đang chờ người thật\n' +
        '/mo <id> — mở lại bot cho khách\n' +
        '/dung <id> — tạm dừng bot cho khách\n' +
        '/tinhtrang — kiểm tra hệ thống\n' +
        '/baocao — báo cáo kinh doanh hôm nay\n' +
        '/khach — khách đã hỏi mà chưa mua (tuần này)'
      );
      return true;
    }

    if (cmd === '/baocao' || cmd === '/report') {
      await reply(await selfCheck.dailyReportText());
      return true;
    }

    if (cmd === '/khach' || cmd === '/leads') {
      await reply(await selfCheck.weeklyLeadsText());
      return true;
    }
  } catch (e) {
    await reply(`Lỗi lệnh: ${e.message}`);
    return true;
  }

  await reply(
    `Không có lệnh "${esc(cmd)}".\n\n` +
    'Lệnh hiện có:\n' +
    '/cho — khách đang chờ người thật\n' +
    '/mo <id> — mở lại bot cho khách\n' +
    '/dung <id> — tạm dừng bot cho khách\n' +
    '/tinhtrang — kiểm tra hệ thống\n' +
    '/baocao — báo cáo kinh doanh'
  );
  return true;
}

async function answer(res, body, work) {
  // Tests await the draft. Production answers first; Zalo retries are deduped.
  if (process.env.NODE_ENV === 'test') {
    await work();
    return res.status(200).json(body);
  }
  res.status(200).json(body);
  await work();
}

async function handleBot(req, res, deps) {
  const pipeline = deps.pipeline;
  const log = deps.log || (() => {});
  await answer(res, { ok: true }, async () => {
    const secret = process.env.ZALO_BOT_WEBHOOK_SECRET || process.env.ZALO_WEBHOOK_TOKEN;
    const got = req.headers['x-bot-api-secret-token'];
    if (secret && got && got !== secret) {
      log({ type: 'bot_bad_secret' });
      return;
    }

    log({ type: 'bot_incoming', body: req.body });

    const body = req.body || {};
    const msg = body.message || {};
    const chatId = msg.chat?.id || msg.from?.id;
    const eventName = String(body.event_name || '');
    const evt = botService.parseTextEvent(body);

    if (evt && chatId && String(chatId) === String(notify.ownerChatId())) {
      const handled = await handleOwnerCommand(evt.text, (t) => botService.sendStaffNotice(chatId, t));
      if (handled) {
        log({ type: 'owner_command', text: evt.text.slice(0, 60) });
        return;
      }
    }

    if (evt) {
      console.log(`🤖 [bot ${evt.chatId}] ${evt.text}`);
      await pipeline.handleMessage({
        channel: 'bot',
        externalKey: `bot_${evt.chatId}`,
        replyTo: evt.chatId,
        text: evt.text,
        msgId: evt.messageId,
        senderName: evt.senderName,
        send: (to, text) => botService.sendMessage(to, text),
        sendPhoto: (to, url, caption) => botService.sendPhoto(to, url, caption),
        log,
      });
      return;
    }

    const kind = /image/.test(eventName) ? 'image'
      : /sticker/.test(eventName) ? 'sticker'
      : /audio|voice/.test(eventName) ? 'audio'
      : /video/.test(eventName) ? 'video'
      : /file|document/.test(eventName) ? 'file'
      : null;

    if (kind && chatId) {
      await pipeline.handleNonText({
        channel: 'bot',
        kind,
        externalKey: `bot_${chatId}`,
        replyTo: chatId,
        msgId: msg.message_id,
        senderName: msg.from?.display_name,
        send: (to, text) => botService.sendMessage(to, text),
        log,
      });
      return;
    }

    log({ type: 'bot_skipped', event_name: eventName });
  });
}

async function handleOa(req, res, deps) {
  const pipeline = deps.pipeline;
  const log = deps.log || (() => {});
  await answer(res, { message: 'ok' }, async () => {
    log({ type: 'incoming', event_name: req.body?.event_name || (req.body?.events ? 'batch' : 'unknown'), body: req.body });

    try {
      const signature = req.headers['x-zalo-signature'];
      if (signature && process.env.ZALO_OA_SECRET_KEY) {
        const expected = crypto
          .createHmac('sha256', process.env.ZALO_OA_SECRET_KEY)
          .update(JSON.stringify(req.body))
          .digest('base64');
        if (signature !== expected) {
          console.warn('⚠️  Invalid webhook signature');
          return;
        }
      }

      const events = Array.isArray(req.body.events) ? req.body.events : [req.body];

      for (const event of events) {
        const name = String(event.event_name || '');
        const senderId = event.sender?.id;
        const senderName = event.sender?.display_name || null;
        const send = (to, text) => zaloService.sendTextMessage(to, text);

        if (name.startsWith('oa_') || name === 'user_received_message' || name === 'user_seen_message') {
          log({ type: 'skipped', event_name: name });
          continue;
        }

        if (name === 'follow') {
          await pipeline.handleFollow({
            channel: 'oa', externalKey: senderId, replyTo: senderId,
            senderName, send, log,
          });
          continue;
        }

        if (name === 'unfollow') {
          log({ type: 'unfollow', from: senderId });
          continue;
        }

        if (name === 'user_send_text') {
          console.log(`📨 [${senderId}] ${event.message?.text}`);
          await pipeline.handleMessage({
            channel: 'oa',
            externalKey: senderId,
            replyTo: senderId,
            text: event.message?.text || '',
            msgId: event.message?.msg_id,
            receivedAt: event.timestamp || null,
            senderName,
            send,
            log,
          });
          continue;
        }

        const kind = name === 'user_send_image' ? 'image'
          : name === 'user_send_sticker' ? 'sticker'
          : name === 'user_send_audio' ? 'audio'
          : name === 'user_send_video' ? 'video'
          : name === 'user_send_file' ? 'file'
          : null;

        if (kind) {
          await pipeline.handleNonText({
            channel: 'oa', kind, externalKey: senderId, replyTo: senderId,
            msgId: event.message?.msg_id, senderName, send, log,
          });
          continue;
        }

        log({ type: 'skipped', event_name: name });
      }
    } catch (error) {
      console.error('Webhook processing error:', error);
      log({ type: 'error', error: error.message });
    }
  });
}

function mount(app, deps) {
  app.post('/bot/webhook', (req, res) => handleBot(req, res, deps));
  app.post('/webhook', (req, res) => handleOa(req, res, deps));
}

module.exports = { mount, handleBot, handleOa, handleOwnerCommand };
