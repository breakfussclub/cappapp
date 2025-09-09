// index.js
const { Client, GatewayIntentBits } = require("discord.js");

// Make sure you set this in Render: Environment → DISCORD_TOKEN
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  client.user.setActivity("💡 Watching Rishi & Poit"); // optional
});

// simple ping/pong to keep it responsive
client.on("messageCreate", (message) => {
  if (message.content === "!cap") {
    message.reply("...coming soon :nerd:");
  }
});

client.login(process.env.DISCORD_TOKEN);





