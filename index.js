require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Configuration, OpenAIApi } = require('openai');
const express = require('express');

// --------------------
// Discord Bot Setup
// --------------------
const client = new Client({ 
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(configuration);

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// Fact-check command
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith('!fact')) {
        const query = message.content.replace('!fact', '').trim();
        if (!query) return message.reply('Please provide a statement to fact-check.');

        try {
            const response = await openai.createChatCompletion({
                model: "gpt-4",
                messages: [
                    { role: "system", content: "You are a fact-checker. Respond only with factual verification." },
                    { role: "user", content: `Check this statement: "${query}"` }
                ],
                temperature: 0
            });

            const answer = response.data.choices[0].message.content;
            message.reply(`⚡ Fact-check result:\n${answer}`);
        } catch (err) {
            console.error(err);
            message.reply("⚠️ Sorry, I couldn't check that right now.");
        }
    }
});

// Log in to Discord
client.login(process.env.DISCORD_TOKEN);

// --------------------
// Dummy Web Server for Render
// --------------------
const app = express();
app.get('/', (req, res) => {
    res.send('TruthSync bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});

