// index.js
const OpenAI = require("openai");

// Make sure you set this in Render: Environment → OPENAI_API_KEY
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function runTest() {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello, world!" },
      ],
    });

    console.log("AI Response:", response.choices[0].message.content);
  } catch (err) {
    if (err.code === "insufficient_quota") {
      console.error(
        "OpenAI quota exceeded. Please check your plan or API key."
      );
    } else {
      console.error("Error calling OpenAI:", err);
    }
  }
}

runTest();




