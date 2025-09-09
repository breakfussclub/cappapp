const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2
const http = require("http");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Hard-coded Google Fact Check API key
const API_KEY = "AIzaSyC18iQzr_v8xemDMPhZc1UEYxK0reODTSc";

// ------------------------
// Helper: truncate text
// ------------------------
function truncate(text, maxLength = 1000) {
  return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
}

// ------------------------
// Fact-check function
// ------------------------
async function factCheck(statement) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(statement)}&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { error: `⚠️ Error contacting Fact Check API: ${response.status}` };
    const data = await response.json();
    const claims = data.claims || [];

    if (claims.length === 0) return { error: "❌ No fact-checks found. Try a more specific statement." };

    const results = [];
    claims.forEach(claim => {
      claim.claimReview.forEach(review => {
        results.push({
          claim: truncate(claim.text),
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

// ------------------------
// Message handler (!cap prefix)
// ------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Only trigger on !cap prefix
  if (!message.content.startsWith("!cap")) return;

  let statement = null;

  // If replying to a message, use the original message content
  if (message.reference) {
    try {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedMessage) {
        statement = repliedMessage.content.trim();
      }
    } catch (err) {
      console.error("Failed to fetch replied-to message:", err);
    }
  }

  // If not a reply or failed to fetch, use the rest of the message
  if (!statement) {
    statement = message.content.slice(4).trim();
  }

  if (!statement) {
    return message.reply("⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`");
  }

  // Initial "thinking..." message
  const sentMessage = await message.reply(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);

  const { results, error } = await factCheck(statement);

  if (error) {
    await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${error}`);
    return;
  }

  // Pagination setup
  let index = 0;

  const generateEmbed = (idx) => {
    const r = results[idx];
    return new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle(`Fact-Check Result ${idx + 1}/${results.length}`)
      .addFields(
        { name: "Claim", value: r.claim },
        { name: "Rating", value: r.rating, inline: true },
        { name: "Publisher", value: r.publisher, inline: true },
        { name: "Source", value: `[Link](${r.url})` }
      )
      .setTimestamp();
  };

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId("prev").setLabel("◀️ Previous").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId("next").setLabel("Next ▶️").setStyle(ButtonStyle.Primary).setDisabled(results.length === 1)
    );

  const msg = await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [generateEmbed(index)], components: [row] });

  // Collector for buttons (any user can interact)
  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

  collector.on("collect", async i => {
    if (i.customId === "next") index++;
    if (i.customId === "prev") index--;

    row.components[0].setDisabled(index === 0);
    row.components[1].setDisabled(index === results.length - 1);

    await i.update({ embeds: [generateEmbed(index)], components: [row] });
  });

  collector.on("end", async () => {
    row.components.forEach(button => button.setDisabled(true));
    await msg.edit({ components: [row] });
  });
});

// ------------------------
// Bot ready
// ------------------------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "👀 Rishi & Poit", type: 3 }],
    status: "online",
  });
});

// ------------------------
// Discord login
// ------------------------
client.login(process.env.DISCORD_TOKEN);

// ------------------------
// Dummy HTTP server for Render
// ------------------------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!");
}).listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
