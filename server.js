require("dotenv").config();

const express = require("express");
const axios = require("axios");
const zaloService = require("./services/zaloService");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Doc Mo Farm AI Agent Running");
});

app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const aiReply = response.data.content[0].text;

    res.json({
      reply: aiReply,
    });
} catch (error) {
  console.log("FULL ERROR:");

  if (error.response) {
    console.log(error.response.data);
  } else {
    console.log(error.message);
  }

  res.status(500).json({
    error: "AI request failed",
  });
}
});

// Zalo Webhook - Verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === process.env.ZALO_WEBHOOK_TOKEN) {
      console.log("✓ Webhook verified");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Zalo Webhook - Message Handler (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("📨 Incoming webhook:", JSON.stringify(req.body, null, 2));

    const events = req.body.events || [];

    for (const event of events) {
      if (event.event_name === "user_send_text") {
        const senderId = event.sender_id;
        const userMessage = event.message;

        console.log(`📝 Message from ${senderId}: ${userMessage}`);

        // Send to Claude Anthropic for AI response
        const aiResponse = await getAIResponse(userMessage);

        // Send response back to Zalo
        await zaloService.sendTextMessage(senderId, aiResponse);
        console.log(`✓ Sent response to ${senderId}`);
      }
    }

    res.status(200).json({ message: "Event received" });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// Get AI response from Anthropic Claude
async function getAIResponse(userMessage) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error("AI request failed:", error.response?.data || error.message);
    return "Xin lỗi, tôi không thể xử lý yêu cầu của bạn lúc này. Vui lòng thử lại!";
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

});