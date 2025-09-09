// index.js
import OpenAI from "openai";

// Make sure your API key is set as an environment variable in Render:
// OPENAI_API_KEY

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Example function to test the client
async function runTest() {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello, world!" }
      ]
    });

    console.log(response.choices[0].message.content);
  } catch (error) {
    console.error("Error calling OpenAI:", error);
  }
}

runTest();




