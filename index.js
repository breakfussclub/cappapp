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

// Hard-coded API keys
const GOOGLE_API_KEY = "AIzaSyC18iQzr_v8xemDMPhZc1UEYxK0reODTSc";
const PERPLEXITY_API_KEY = "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";

// Rate limiting: userId -> timestamp
const cooldowns = {};
const COOLDOWN_SECONDS = 10;

// Command aliases
const COMMANDS = ["!cap", "!fact", "!verify"];

// ------------------------
// Helpers
// ------------------------
function splitText(text, maxLength = 1000) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.slice(i, i + maxLength));
  }
  return parts;
}

function ratingColor(rating) {
  if (!rating) return 0x808080; // gray
  const r = rating.toLowerCase();
  if (r.includes("true")) return 0x00ff00; // green
  if (r.includes("false")) return 0xff0000; // red
  return 0xffff00; // yellow for partially true/misleading
}

// ------------------------
// Google Fact Check
// ------------------------
async function factCheck(statement) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(statement)}&key=${GOOGLE_API_KEY}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { error: `⚠️ Error contacting Fact Check API: ${response.status}` };
    const data = await response.json();
    const claims = data.claims || [];

    if (claims.length === 0) return { results: [] };

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
// Perplexity Fallback
// ------------------------
async function queryPerplexity(statement) {
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar",
    messages: [{ role: "user", content: statement }]
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error(`Perplexity API error: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    // Assuming response format: data.choices[0].message.content
    return {
      content: data?.choices?.[0]?.message?.content || "",
      sources: data?.choices?.[0]?.message?.sources || []
    };
  } catch (err) {
    console.error("Perplexity API error:", err);
    return null;
  }
}

async function handlePerplexityFallback(statement, sentMessage) {
  const perplexityResult = await queryPerplexity(statement);
  if (!perplexityResult) {
    await sentMessage.edit(`❌ Could not get a response from Perplexity.`);
    return;
  }

  const pages = splitText(perplexityResult.content || "No response from Perplexity.");
  let pageIndex = 0;

  const buildEmbed = () => {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`Fact-Check Result ${pageIndex + 1}/${pages.length}`)
      .addFields({ name: "Claim", value: `> ${pages[pageIndex]}` })
      .setTimestamp();

    if (Array.isArray(perplexityResult.sources) && perplexityResult.sources.length > 0) {
      const srcLines = perplexityResult.sources.slice(0, 6).map(s => {
        if (typeof s === "string") return s;
        return s.url || s.link || s.title || JSON.stringify(s);
      }).filter(Boolean);

      if (srcLines.length > 0) {
        embed.addFields({ name: "Source", value: srcLines.join("\n") });
      }
    }

    return embed;
  };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("prev").setLabel("◀️ Previous").setStyle(ButtonStyle.Primary).setDisabled(pageIndex === 0),
    new ButtonBuilder().setCustomId("next").setLabel("Next ▶️").setStyle(ButtonStyle.Primary).setDisabled(pageIndex === pages.length - 1)
  );

  await sentMessage.edit({
    content: `🧐 Fact-checking: "${statement}"`,
    embeds: [buildEmbed()],
    components: pages.length > 1 ? [row] : []
  });

  if (pages.length > 1) {
    const collector = sentMessage.createMessageComponentCollector({ time: 60000 });

    collector.on("collect", async i => {
      if (i.customId === "prev" && pageIndex > 0) pageIndex--;
      else if (i.customId === "next" && pageIndex < pages.length - 1) pageIndex++;

      row.components[0].setDisabled(pageIndex === 0);
      row.components[1].setDisabled(pageIndex === pages.length - 1);

      await i.update({ embeds: [buildEmbed()], components: [row] });
    });

    collector.on("end", async () => {
      await sentMessage.edit({ components: [] });
    });
  }
}

// ------------------------
// Message Handler
// ------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const allowedUserId = "306197826575138816";
  const allowedRoleId = "1410526844318388336";

  const member = message.member;
  if (message.author.id !== allowedUserId && !member.roles.cache.has(allowedRoleId)) {
    return;
  }

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

  if (message.reference) {
    try {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedMessage) statement = repliedMessage.content.trim();
    } catch (err) {
      console.error("Failed to fetch replied-to message:", err);
    }
  }

  if (!statement) statement = message.content.slice(command.length).trim();
  if (!statement) return message.reply("⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`");

  const sentMessage = await message.reply(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);

  const { results, error } = await factCheck(statement);

  if (error) {
    await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${error}`);
    return;
  }

  if (!results || results.length === 0) {
    // Trigger Perplexity fallback ONLY if Google returns no results
    return handlePerplexityFallback(statement, sentMessage);
  }

  // ------------------------
  // Google results embed
  // ------------------------
  const pages = [];
  results.forEach(r => {
    const parts = splitText(r.claim, 1000);
    parts.forEach(p => {
      pages.push({ claim: p, rating: r.rating, publisher: r.publisher, url: r.url, date: r.date });
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

  const row = new ActionRowBuilder().addComponents(
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
