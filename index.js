const fs = require("fs");

// Load facts from JSON file
const facts = JSON.parse(fs.readFileSync("./facts.json", "utf8"));

client.on("messageCreate", (message) => {
  if (message.content.startsWith("!cap")) {
    const userStatement = message.content.slice(4).trim();
    if (!userStatement) {
      return message.reply("⚠️ Please provide a statement after `!cap`.");
    }

    // Pick random fact
    const randomFact = facts[Math.floor(Math.random() * facts.length)];

    message.reply(
      `🔎 You asked me to fact-check: "${userStatement}"\n\n✅ ${randomFact}`
    );
  }
});








