require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith('!fact')) {
    const query = message.content.replace('!fact', '').trim();
    if (!query) return message.reply('Please provide a statement to fact-check.');

    const response = `⚡ I checked "${query}" — I cannot verify this right now.`;

    message.reply(response);
  }
});

client.login(process.env.DISCORD_TOKEN);
