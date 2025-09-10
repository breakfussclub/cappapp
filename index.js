const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2
const http = require("http");

// ------------------------
// CONFIG
// ------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Hard-coded Google Fact Check API key
const API_KEY = "AIzaSyC18iQzr_v8xemDMPhZc1UEYxK0reODTSc";

// Hard-coded Perplexity API key
const PERPLEXITY_API_KEY = "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";

// Rate limiting: userId -> timestamp
const cooldowns = {};
const COOLDOWN_SECONDS = 10;

// Command aliases
const COMMANDS = ["!cap", "!fact", "!verify"];

// ------------------------
// Helper: truncate / split text
// ------------------------
function splitText(text, maxLength = 1000) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.slice(i, i + maxLength));
  }
  return parts;
}

// Map rating to embed color
function ratingColor(rating) {
  if (!rating) return 0x808080; // gray for unknown
  const r = rating.toLowerCase();
  if (r.includes("true")) return 0x00ff00; // green
  if (r.includes("false")) return 0xff0000; // red
  return 0xffff00; // yellow for partially true/misleading
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
          claim: claim.text,
          rating: review.textualRating || "Unknown",
          publisher: review.publisher.name,
          url: review.url,
          date: review.publishDate || "Unknown"
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
// Perplexity Sonar API fallback (debug version)
// ------------------------
async function queryPerplexity(statement) {
  const url = 'https://sonar.perplexity.ai/v1/answer';
  const headers = {
    'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const body = JSON.stringify({
    query: statement,
    return_images: false
  });

  try {
    const response = await fetch(url, { method: 'POST', headers, body });

    // Log status code
    console.log('Perplexity API status:', response.status);

    // Log raw response text
    const text = await response.text();
    console.log('Perplexity raw response:', text);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error('Failed to parse JSON:', err);
      return { error: 'Perplexity returned invalid JSON' };
    }

    if (data.answer) {
      return {
        type: 'text',
        content: data.answer,
        sources: data.sources || [],
      };
    } else {
      return { error: 'No answer found from Perplexity' };
    }
  } catch (error) {
    console.error('Perplexity API error:', error);
    return { error: 'Failed to fetch from Perplexity API' };
  }
}

// ------------------------
// Message handler
// ------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // --- SILENT PERMISSION CHECK ---
  const allowedUserId = "306197826575138816";
  const allowedRoleId = "1410526844318388336";

  const member = message.member;
  if (
    message.author.id !== allowedUserId &&
    !member.roles.cache.has(allowedRoleId)
  ) {
    return; // silently ignore
  }
  // ------------------------

  // Check if message starts with any of the aliases
  const command = COMMANDS.find(cmd => message.content.toLowerCase().startsWith(cmd));
  if (!command) return;

  // Rate limiting
  const now = Date.now();
  if (cooldowns[message.author.id] && now - cooldowns[message.author.id] < COOLDOWN_SECONDS * 1000) {
    return message.reply(`⏱ Please wait ${COOLDOWN_SECONDS} seconds between fact-checks.`);
  }
  cooldowns[message.author.id] = now;

  // Determine statement
  let statement = null;

  // If replying, use replied message content
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

  // If no reply or failed to fetch, use message after command
  if (!statement) {
    statement = message.content.slice(command.length).trim();
  }

  if (!statement) {
    return message.reply("⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`");
  }

  // Initial "thinking..." message
  const sentMessage = await message.reply(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);

  // --- Attempt Google Fact Check first ---
  const { results, error } = await factCheck(statement);

  if (error || !results || results.length === 0) {
    // Fallback to Perplexity Sonar API
    const sonarResponse = await queryPerplexity(statement);

    if (sonarResponse.error) {
      await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${sonarResponse.error}`);
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('Perplexity AI Response')
        .setDescription(sonarResponse.content)
        .addFields(
          { name: 'Sources', value: sonarResponse.sources.join('\n') || 'No sources available' }
        )
        .setTimestamp();

      await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed] });
    }
    return;
  }

  // Split long claims into pages if needed
  const pages = [];
  results.forEach(r => {
    const parts = splitText(r.claim, 1000);
    parts.forEach(p => {
      pages.push({
        claim: p,
        rating: r.rating,
        publisher: r.publisher,
        url: r.url,
        date: r.date
      });
    });
  });

  let index = 0;
  const generateEmbed = (idx) => {
    const r = pages[idx];
    return new EmbedBuilder()
      .setColor(ratingColor(r.rating))
      .setTitle(`Fact-Check Result ${idx + 1}/${pages.length}`)
      .addFields(
        { name: "Claim", value: `> ${r.claim}` },
        { name: "Rating", value: r.rating, inline: true },
        { name: "Publisher", value: r.publisher, inline: true },
        { name: "Source", value: `[Link](${r.url})` },
        { name: "Reviewed Date", value: r.date, inline: true }
      )
      .setTimestamp();
  };

  // Pagination buttons
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId("prev").setLabel("◀️ Previous").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId("next").setLabel("Next ▶️").setStyle(ButtonStyle.Primary).setDisabled(pages.length === 1),
      new ButtonBuilder().setCustomId("quick").setLabel("🔄 Quick Search").setStyle(ButtonStyle.Secondary)
    );

  const msg = await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [generateEmbed(index)], components: [row] });

  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

  collector.on("collect", async i => {
    if (i.customId === "next") index++;
    if (i.customId === "prev") index--;
    if (i.customId === "quick") {
      index = 0;
    }

    row.components[0].setDisabled(index === 0);
    row.components[1].setDisabled(index === pages.length - 1);

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
    activities: [{ name: "👀 Rishi & Sav", type: 3 }],
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
