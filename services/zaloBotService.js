/**
 * Zalo Bot API (Bot Creator / Marketplace bot) — FREE, no OA Tier Package needed.
 * Telegram-style API: https://bot-api.zapps.me/bot<TOKEN>/<method>
 *
 * Used as the primary reply channel because the OA Customer-Service API
 * (openapi.zalo.me /oa/message/cs) returns error -224 without a paid OA tier.
 */
const axios = require('axios');

const BOT_API_BASE = 'https://bot-api.zapps.me';
const MAX_MSG_LEN = 2000; // Zalo Bot API text limit

function botUrl(method) {
  const token = process.env.ZALO_BOT_TOKEN;
  if (!token) throw new Error('ZALO_BOT_TOKEN not set');
  return `${BOT_API_BASE}/bot${token}/${method}`;
}

async function call(method, payload = {}, httpMethod = 'post') {
  try {
    const res =
      httpMethod === 'get'
        ? await axios.get(botUrl(method), { params: payload, timeout: 15000 })
        : await axios.post(botUrl(method), payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
          });
    const data = res.data;
    if (data && data.ok === false) {
      console.error(`❌ Bot API ${method} failed:`, JSON.stringify(data));
      return null;
    }
    return data;
  } catch (err) {
    console.error(`❌ Bot API ${method} error:`, err.response?.data || err.message);
    return null;
  }
}

/** Bot identity — use to verify the token is alive. */
async function getMe() {
  return call('getMe', {}, 'get');
}

/** Send text to a chat, chunked to 2000 chars. */
async function sendMessage(chatId, text) {
  const body = String(text || '').trim();
  if (!body || !chatId) return null;

  const chunks = [];
  for (let i = 0; i < body.length; i += MAX_MSG_LEN) {
    chunks.push(body.slice(i, i + MAX_MSG_LEN));
  }

  let last = null;
  for (const chunk of chunks) {
    last = await call('sendMessage', { chat_id: String(chatId), text: chunk });
  }
  return last;
}

/** Send an image by URL, with an optional caption. */
async function sendPhoto(chatId, photoUrl, caption) {
  if (!chatId || !photoUrl) return null;
  const payload = { chat_id: String(chatId), photo: photoUrl };
  if (caption) payload.caption = String(caption).slice(0, MAX_MSG_LEN);
  const res = await call('sendPhoto', payload);
  // Not every bot tier supports photos — fall back to a link so the
  // customer still gets their payment QR.
  if (!res) {
    return sendMessage(chatId, `${caption ? caption + '\n\n' : ''}${photoUrl}`);
  }
  return res;
}

/** Typing indicator (best effort — ignored if unsupported). */
async function sendTyping(chatId) {
  return call('sendChatAction', { chat_id: String(chatId), action: 'typing' });
}

/** Register the webhook. secretToken must be 8–256 chars. */
async function setWebhook(url, secretToken) {
  const payload = { url };
  if (secretToken) payload.secret_token = secretToken;
  return call('setWebhook', payload);
}

async function getWebhookInfo() {
  return call('getWebhookInfo', {}, 'get');
}

async function deleteWebhook() {
  return call('deleteWebhook', {});
}

/**
 * Normalize an inbound Bot API webhook body into { chatId, text, messageId, eventName }.
 * Returns null when the payload is not a text message we should answer.
 */
function parseTextEvent(body) {
  if (!body || typeof body !== 'object') return null;

  const eventName = body.event_name || body.event || null;
  const msg = body.message || body.result?.message || null;
  if (!msg) return null;

  const text = msg.text;
  const chatId = msg.chat?.id ?? msg.chat_id ?? msg.from?.id;
  if (!text || !chatId) return null;

  // Only answer text messages
  if (eventName && !String(eventName).includes('text')) return null;

  return {
    chatId: String(chatId),
    text: String(text),
    messageId: msg.message_id || msg.msg_id || null,
    senderName: msg.from?.display_name || msg.chat?.name || null,
    eventName,
  };
}

module.exports = {
  getMe,
  sendMessage,
  sendPhoto,
  sendTyping,
  setWebhook,
  getWebhookInfo,
  deleteWebhook,
  parseTextEvent,
};
