const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Hard-coded Google Fact Check API key
const API_KEY = "AIzaSyC18iQzr_v8xemDMPhZc1UEYxK0reODTSc";

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "👀 Rishi & Poit", type: 3 }],
    status: "dnd",
  });
});

// Function to query Google Fact Check Tools API
async function factCheck(statement) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(statement)}&key=${API_KEY}`;

  try {
    const response = await fetch(url);
    if (!response.ok) return { error: `⚠️ Error contacting Fact Check API: ${response.status}` };

    const data = await response.json();
    const claims = data.claims || [];

    if (claims.length === 0) return { error: "❌ No fact-checks found." };

    const results = [];
    claims.slice(0, 3).forEach(claim => {
      claim.claimReview.forEach(review => {
        results.push({
          claim: claim.text,
          rating: review.textualRating || "Unknown",
          publisher: review.publisher.name,
          url: review.url
        });
      });
    });

    return { results };
  } catch (error) {
    console.error(error);
    return { error: "⚠️ An error occurred while contacting the Fact Check API." };
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("!cap")) {
    const statement = message.content.slice(4).trim();

    if (!statement) {
      return message.reply("⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`");
    }

    // Temporary "checking" message
    const sentMessage = await message.reply(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);

    const { results, error } = await factCheck(statement);

    if (error) {
      await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${error}`);
      return;
    }

    // Create embeds for each result
    const embeds = results.map(r => new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Fact-Check Result")
      .addFields(
        { name: "Claim", value: r.claim },
        { name: "Rating", value: r.rating, inline: true },
        { name: "Publisher", value: r.publisher, inline: true },
        { name: "Source", value: `[Link](${r.url})` }
      )
      .setTimestamp()
    );

    await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds });
  }
});

// Login using Discord token from Render environment variable
client.login(process.env.DISCORD_TOKEN);










