const axios = require('axios');
const crypto = require('crypto');

const ZALO_API_BASE = 'https://openapi.zalo.me/v3.0';
const ZALO_OAUTH_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
const MAX_MSG_LEN = 2000; // Zalo text limit

// In-memory tokens (start from env, can be set/refreshed at runtime)
let accessToken = process.env.ZALO_ACCESS_TOKEN || null;
let refreshToken = process.env.ZALO_REFRESH_TOKEN || null;

const state = require('./state');
const K_ACCESS = 'zalo_oa_access_token';
const K_REFRESH = 'zalo_oa_refresh_token';
const K_REFRESHED_AT = 'zalo_oa_refreshed_at';

function setTokens(newAccess, newRefresh) {
  if (newAccess) accessToken = newAccess;
  if (newRefresh) refreshToken = newRefresh;
  // Persist so a restart doesn't fall back to a spent refresh token.
  if (newAccess) state.set(K_ACCESS, newAccess);
  if (newRefresh) state.set(K_REFRESH, newRefresh);
  state.set(K_REFRESHED_AT, new Date().toISOString());
}

/**
 * Load tokens saved by a previous run. Database wins over env: the env copy
 * is the bootstrap value and goes stale the first time Zalo rotates it.
 */
async function loadTokens() {
  const saved = await state.getMany([K_ACCESS, K_REFRESH, K_REFRESHED_AT]);
  if (saved[K_ACCESS]) accessToken = saved[K_ACCESS];
  if (saved[K_REFRESH]) refreshToken = saved[K_REFRESH];
  if (saved[K_ACCESS] || saved[K_REFRESH]) {
    console.log(`🔑 Zalo tokens restored from database (last refreshed ${saved[K_REFRESHED_AT] || 'unknown'})`);
  } else if (accessToken || refreshToken) {
    // First boot after this feature shipped: seed the store from env.
    await state.set(K_ACCESS, accessToken);
    await state.set(K_REFRESH, refreshToken);
    console.log('🔑 Seeded Zalo tokens from environment into database');
  }
  return { accessToken, refreshToken, refreshedAt: saved[K_REFRESHED_AT] || null };
}

/**
 * Renew before Zalo expires the access token (~25h), instead of waiting for
 * a customer message to fail. Runs every REFRESH_HOURS (default 20).
 */
function startTokenRefresh() {
  const hours = Number(process.env.ZALO_TOKEN_REFRESH_HOURS || 20);
  const tick = async () => {
    if (!refreshToken) return;
    const ok = await refreshAccessToken();
    console.log(ok ? '🔁 Proactive Zalo token refresh OK' : '⚠️  Proactive Zalo token refresh failed');
  };
  const t = setInterval(tick, hours * 3600 * 1000);
  if (t.unref) t.unref();
  console.log(`🔁 Zalo token auto-refresh every ${hours}h`);
}

function getTokens() {
  return { accessToken, refreshToken };
}

const zaloAPI = axios.create({
  baseURL: ZALO_API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

// Verify webhook signature
function verifyWebhookSignature(data, signature, token) {
  const hmac = crypto.createHmac('sha256', token);
  const digest = hmac.update(JSON.stringify(data)).digest('hex');
  return digest === signature;
}

// ------------------------------------------------------------
// Token refresh (needs ZALO_REFRESH_TOKEN + ZALO_APP_ID + ZALO_APP_SECRET)
// NOTE: Zalo rotates the refresh token on every use. The new one is
// printed to logs — copy it into the ZALO_REFRESH_TOKEN env var.
// ------------------------------------------------------------
async function refreshAccessToken() {
  const { ZALO_APP_ID, ZALO_APP_SECRET } = process.env;
  if (!refreshToken || !ZALO_APP_ID || !ZALO_APP_SECRET) {
    console.error('❌ Cannot refresh Zalo token: missing refresh token / ZALO_APP_ID / ZALO_APP_SECRET');
    return false;
  }
  try {
    const res = await axios.post(
      ZALO_OAUTH_URL,
      new URLSearchParams({
        refresh_token: refreshToken,
        app_id: ZALO_APP_ID,
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          secret_key: ZALO_APP_SECRET,
        },
      }
    );
    if (res.data?.access_token) {
      // setTokens persists both — the rotated refresh token must not be lost.
      setTokens(res.data.access_token, res.data.refresh_token);
      console.log('🔄 Zalo access token refreshed and saved to database.');
      return true;
    }
    console.error('❌ Token refresh failed:', JSON.stringify(res.data));
    return false;
  } catch (err) {
    console.error('❌ Token refresh error:', err.response?.data || err.message);
    return false;
  }
}

// ------------------------------------------------------------
// Low-level send. Zalo v3 returns HTTP 200 even on errors —
// real status is in body: { error: 0 } means success.
// ------------------------------------------------------------
async function postMessage(payload, attempt = 1) {
  const response = await zaloAPI.post('/oa/message/cs', payload, {
    headers: { access_token: accessToken },
  });
  const data = response.data;

  if (data && data.error === 0) return data;

  // -216 / -124: invalid or expired access token → try refresh once
  const tokenErrors = [-216, -124, -204];
  if (attempt === 1 && data && tokenErrors.includes(data.error)) {
    console.warn(`⚠️  Zalo token error ${data.error} (${data.message}). Refreshing...`);
    const ok = await refreshAccessToken();
    if (ok) return postMessage(payload, 2);
  }

  console.error('❌ Zalo send failed:', JSON.stringify(data));
  lastError = data;
  return null;
}

let lastError = null;
function getLastError() {
  return lastError;
}

// Send text message via Zalo OA (chunks long texts)
async function sendTextMessage(recipientId, message) {
  if (!accessToken) {
    console.error('❌ No ZALO_ACCESS_TOKEN configured — cannot reply.');
    return null;
  }
  const text = String(message || '').trim();
  if (!text) return null;

  // Chunk to 2000 chars
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
    chunks.push(text.slice(i, i + MAX_MSG_LEN));
  }

  let last = null;
  for (const chunk of chunks) {
    last = await postMessage({
      recipient: { user_id: recipientId },
      message: { text: chunk },
    });
  }
  return last;
}

// Send quick reply message
async function sendQuickReply(recipientId, message, quickReplies) {
  return postMessage({
    recipient: { user_id: recipientId },
    message: {
      text: message,
      quick_replies: quickReplies.map(reply => ({
        content_type: 'text',
        title: reply.title,
        payload: reply.payload,
      })),
    },
  });
}

// Get user profile (v3: /oa/user/detail with JSON-encoded data param)
async function getUserProfile(userId) {
  try {
    const response = await zaloAPI.get('/oa/user/detail', {
      params: { data: JSON.stringify({ user_id: userId }) },
      headers: { access_token: accessToken },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching user profile:', error.response?.data || error.message);
    return null;
  }
}

module.exports = {
  verifyWebhookSignature,
  sendTextMessage,
  sendQuickReply,
  getUserProfile,
  refreshAccessToken,
  setTokens,
  getTokens,
  getLastError,
  loadTokens,
  startTokenRefresh,
};
