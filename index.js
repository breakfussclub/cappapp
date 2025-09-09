const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "Rishi & Poit", type: 3 }], // 👀 Watching
    status: "online",
  });
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Look for messages starting with !cap
  if (message.content.startsWith("!cap")) {
    const statement = message.content.slice(4).trim(); // remove "!cap"

    if (!statement) {
      return message.reply("⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`");
    }

    // Dummy response for now
    message.reply(`🧐 Fact-checking: "${statement}"\n\n✅ This is just a placeholder response until AI integration is added.`);
  }
});

client.login(process.env.DISCORD_TOKEN);







