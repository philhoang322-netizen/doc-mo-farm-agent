const axios = require('axios');
const crypto = require('crypto');

const ZALO_API_BASE = 'https://openapi.zalo.me/v3.0';

const zaloAPI = axios.create({
  baseURL: ZALO_API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Verify webhook signature
function verifyWebhookSignature(data, signature, token) {
  const hmac = crypto.createHmac('sha256', token);
  const digest = hmac.update(JSON.stringify(data)).digest('hex');
  return digest === signature;
}

// Send text message via Zalo
async function sendTextMessage(recipientId, message) {
  try {
    const response = await zaloAPI.post('/message/text', {
      recipient: {
        user_id: recipientId,
      },
      message: {
        text: message,
      },
    }, {
      headers: {
        Authorization: `Bearer ${process.env.ZALO_APP_ID}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error sending Zalo message:', error.response?.data || error.message);
    throw error;
  }
}

// Send quick reply message
async function sendQuickReply(recipientId, message, quickReplies) {
  try {
    const response = await zaloAPI.post('/message/quick_reply', {
      recipient: {
        user_id: recipientId,
      },
      message: {
        text: message,
        quick_replies: quickReplies.map(reply => ({
          content_type: 'text',
          title: reply.title,
          payload: reply.payload,
        })),
      },
    }, {
      headers: {
        Authorization: `Bearer ${process.env.ZALO_APP_ID}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error sending quick reply:', error.response?.data || error.message);
    throw error;
  }
}

// Get user profile
async function getUserProfile(userId) {
  try {
    const response = await zaloAPI.get(`/user/${userId}/profile`, {
      headers: {
        Authorization: `Bearer ${process.env.ZALO_APP_ID}`,
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching user profile:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  verifyWebhookSignature,
  sendTextMessage,
  sendQuickReply,
  getUserProfile,
};
