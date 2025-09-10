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
// Fact-check function (Google API)
// ------------------------
async function factCheck(statement) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(statement)}&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { error: `⚠️ Error contacting Fact Check API: ${response.status}` };
    const data = await response.json();
    const claims = data.claims || [];

    if (claims.length === 0) return { results: [] };

    const results = [];
    const seenURLs = new Set(); // Deduplicate
    claims.forEach(claim => {
      claim.claimReview.forEach(review => {
        if (!seenURLs.has(review.url)) {
          seenURLs.add(review.url);
          results.push({
            claim: claim.text,
            rating: review.textualRating || "Unknown",
            publisher: review.publisher.name,
            url: review.url,
            date: review.publishDate || "Unknown"
          });
        }
      });
    });

    return { results };
  } catch (error) {
    console.error(error);
    return { error: "⚠️ An error occurred while contacting the Fact Check API." };
  }
}

// ------------------------
// Wikipedia helper (fuzzy search)
// ------------------------
async function wikipediaSummaryFuzzy(query) {
  try {
    // Step 1: search for matching pages
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    const results = searchData.query.search;
    if (!results || results.length === 0) return null;

    const bestMatch = results[0].title;

    // Step 2: get summary of best match
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(bestMatch)}`;
    const summaryResp = await fetch(summaryUrl);
    const summaryData = await summaryResp.json();

    if (summaryData.extract) {
      return {
        title: summaryData.title,
        extract: summaryData.extract,
        url: summaryData.content_urls.desktop.page
      };
    }
  } catch (err) {
    console.error("Wikipedia fuzzy fetch error:", err);
  }
  return null;
}

// ------------------------
// Message handler
// ------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

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
      if (repliedMessage) statement = repliedMessage.content.trim();
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

  // Send initial "thinking..." message
  const sentMessage = await message.reply(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);

  // ------------------------
  // Google Fact Check
  // ------------------------
  const { results, error } = await factCheck(statement);

  if (error) {
    await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${error}`);
    return;
  }

  let pages = [];

  if (results && results.length > 0) {
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
  }

  // ------------------------
  // Wikipedia fallback (fuzzy)
  // ------------------------
  if (pages.length === 0) {
    const wiki = await wikipediaSummaryFuzzy(statement);
    if (wiki) {
      const embed = new EmbedBuilder()
        .setColor(0x808080)
        .setTitle(`Wikipedia: ${wiki.title}`)
        .setDescription(wiki.extract)
        .setURL(wiki.url)
        .setTimestamp();

      await sentMessage.edit({ 
        content: `🧐 Fact-checking: "${statement}"\n\nNo official fact-checks found. Showing Wikipedia summary instead:`,
        embeds: [embed] 
      });
      return;
    }

    // Still nothing
    await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n❌ No fact-checks or Wikipedia summary found.`);
    return;
  }

  // ------------------------
  // Pagination for Google results
  // ------------------------
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
    if (i.customId === "quick") index = 0;

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
