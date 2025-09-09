// index.js
const { Client, GatewayIntentBits, ActivityType } = require("discord.js");

// Make sure you set this in Render: Environment → DISCORD_TOKEN
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  
  // Set status as :eyes: Watching Rishi & Poit
  client.user.setActivity("Rishi & Poit", { type: ActivityType.Watching });
});

client.on("messageCreate", (message) => {
  if (message.content === "!ping") {
    message.reply("Pong!");
  }
});

client.login(process.env.DISCORD_TOKEN);






