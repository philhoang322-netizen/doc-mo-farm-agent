require("dotenv").config();

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function askChatGPT(
  userMessage,
  systemPrompt = "You are Doc Mo Farm AI assistant."
) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",

      temperature: 0.7,

      max_tokens: 500,

      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error(
      "OpenAI API error:",
      error.response?.data || error.message
    );

    return "Xin lỗi, hệ thống AI đang bận. Vui lòng thử lại sau.";
  }
}

async function askChatGPTWithHistory(
  messages,
  systemPrompt = "You are Doc Mo Farm AI assistant."
) {
  try {
    const fullMessages = [
      {
        role: "system",
        content: systemPrompt,
      },
      ...messages,
    ];

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",

      temperature: 0.7,

      max_tokens: 500,

      messages: fullMessages,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error(
      "OpenAI API error:",
      error.response?.data || error.message
    );

    return "Xin lỗi, hệ thống AI đang bận. Vui lòng thử lại sau.";
  }
}

module.exports = {
  askChatGPT,
  askChatGPTWithHistory,
  client,
};