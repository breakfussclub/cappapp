const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ComponentType 
} = require("discord.js");
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
const GOOGLE_API_KEY = "AIzaSyC18iQzr_v8xemDMPhZc1UEYxK0reODTSc";
const PERPLEXITY_API_KEY = "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";
const cooldowns = {};
const COOLDOWN_SECONDS = 10;
const COMMANDS = ["!cap", "!fact", "!verify"];

const WATCHED_USER_IDS = ["1236556523522752516"];      // Users to auto-scan
const WATCHED_CHANNEL_IDS = ["1041130370273390603"];   // Channels to monitor
const NOTIFY_CHANNEL_ID = "917154834321408022";        // Channel to notify on false claims

const NEGATION_WORDS = ["no", "not", "never", "none", "cannot", "didn't", "doesn't", "isn't", "wasn't", "aren't", "won't"];

// ------------------------
// Channel & user message buffers.
// Structure: CHANNEL_BUFFERS[channelId][userId] = [messages...]
const CHANNEL_BUFFERS = {};

// ------------------------
// Helpers for text processing (from before)
const STOPWORDS = new Set([
  "the","and","is","in","at","of","a","to","for","on","with","as","by","that","this","from",
  "it","an","be","are","was","were","has","have","had","but","or","not","no","if","then",
  "else","when","which","who","whom","where","how","what","why"
]);

function extractKeywords(text) {
  text = text.toLowerCase();
  text = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
  let words = text.split(/\s+/);
  return words.filter(w => w && !STOPWORDS.has(w));
}

function similarityScore(aKeywords, bKeywords) {
  const setA = new Set(aKeywords);
  const setB = new Set(bKeywords);
  const common = [...setA].filter(x => setB.has(x));
  const avgLen = (setA.size + setB.size) / 2;
  if (avgLen === 0) return 0;
  return common.length / avgLen;
}

const SIMILARITY_THRESHOLD = 0.3;

// Function to split long text into chunks
function splitText(text, maxLength = 1000) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.slice(i, i + maxLength));
  }
  return parts;
}
function normalizeGoogleRating(rating) {
  if (!rating) return { verdict: "Other", color: 0xffff00 };
  const r = rating.toLowerCase();
  if (r.includes("true") || r.includes("correct") || r.includes("accurate")) return { verdict: "True", color: 0x00ff00 };
  if (r.includes("false") || r.includes("incorrect") || r.includes("pants on fire") || r.includes("hoax")) return { verdict: "False", color: 0xff0000 };
  return { verdict: "Other", color: 0xffff00 };
}
// ------------------------
// Google Fact Check query
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
// Perplexity Fallback (unchanged)
async function queryPerplexity(statement) {
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar",
    messages: [
      { role: "system", content: "Classify the following statement as one of: 'True', 'False', 'Misleading', or 'Other'. Always provide a short reasoning and sources. Format:\nVerdict: True/False/Misleading/Other\nReason: <text>\nSources: <list>" },
      { role: "user", content: statement }
    ]
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
    const content = data?.choices?.[0]?.message?.content || "";
    const verdictMatch = content.match(/Verdict:\s*(True|False|Misleading|Other)/i);
    const verdict = verdictMatch ? verdictMatch[1] : "Other";
    const color = verdict.toLowerCase() === "true" ? 0x00ff00 :
                  verdict.toLowerCase() === "false" ? 0xff0000 :
                  0xffff00;
    const reasonMatch = content.match(/Reason:\s*([\s\S]*?)(?:Sources:|$)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : "No reasoning provided.";
    const sourcesMatch = content.match(/Sources:\s*([\s\S]*)/i);
    const sourcesText = sourcesMatch ? sourcesMatch[1].trim() : "";
    const sources = sourcesText.split("\n").filter(s => s.trim().length > 0);
    return { verdict, color, reason, sources, raw: content };
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
  const embed = new EmbedBuilder()
    .setColor(perplexityResult.color)
    .setTitle(`Fact-Check Result`)
    .addFields(
      { name: "Claim", value: `> ${statement}` },
      { name: "Verdict", value: perplexityResult.verdict },
      { name: "Reasoning", value: perplexityResult.reason.slice(0, 1000) }
    )
    .setTimestamp();
  if (perplexityResult.sources.length > 0) {
    embed.addFields({ name: "Sources", value: perplexityResult.sources.slice(0, 6).join("\n") });
  }
  await sentMessage.edit({
    content: `🧐 Fact-checking: "${statement}"`,
    embeds: [embed],
    components: []
  });
}

// ------------------------
// Compose embed for fact-check result similar to manual checks
function composeFactCheckEmbed(statement, results) {
  // Collect pages of results for pagination and embeds
  const pages = [];
  results.forEach(r => {
    const parts = splitText(r.claim, 1000);
    parts.forEach(p => {
      const norm = normalizeGoogleRating(r.rating);
      pages.push({
        claim: p,
        verdict: norm.verdict,
        color: norm.color,
        rating: r.rating,
        publisher: r.publisher,
        url: r.url,
        date: r.date
      });
    });
  });
  return pages;
}

// ------------------------
// Batch fact-check buffered messages per user/channel every period
const FACT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute interval (testing)

setInterval(async () => {
  for (const [channelId, users] of Object.entries(CHANNEL_BUFFERS)) {
    for (const [userId, messages] of Object.entries(users)) {
      if (!messages || messages.length === 0) continue;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      // Try fetching member to get username
      const member = await channel.guild.members.fetch(userId).catch(() => null);
      const username = member ? member.user.username : `User ID: ${userId}`;

      // Combine buffered user messages into a single statement block
      const combinedStatement = messages.join("\n");

      // Run fact check via Google API
      const { results, error } = await factCheck(combinedStatement);
      if (error) {
        console.error(`Fact-check error for user ${userId} in channel ${channelId}:`, error);
        continue;
      }

      if (!results || results.length === 0) {
        // No Google fact-check results; fallback to Perplexity AI
        const perplexityResult = await queryPerplexity(combinedStatement);
        if (perplexityResult && perplexityResult.verdict.toLowerCase() === "false") {
          // Send embed alert in original channel (generic title and no source mention)
          const embed = new EmbedBuilder()
            .setColor(perplexityResult.color)
            .setTitle(`Fact-Check Alert for ${username}`)
            .addFields(
              { name: "Claim", value: `> ${combinedStatement}` },
              { name: "Verdict", value: perplexityResult.verdict },
              { name: "Reasoning", value: perplexityResult.reason.slice(0, 1000) }
            )
            .setTimestamp();
          if (perplexityResult.sources.length > 0) {
            embed.addFields({ name: "Sources", value: perplexityResult.sources.slice(0, 6).join("\n") });
          }
          await channel.send({
            content: `⚠️ Fact-check alert: False claim detected from <@${userId}> in recent messages.`,
            embeds: [embed]
          });
          // Notify summary channel with generic wording
          const notifyChannel = await client.channels.fetch(NOTIFY_CHANNEL_ID).catch(() => null);
          if (notifyChannel) {
            await notifyChannel.send(`⚠️ Fact-check: Detected a false claim from <@${userId}> in <#${channelId}>.`);
          }
        }
      } else {
        // Google fact-check results present; filter for false claims
        const falseClaims = results.filter(r => normalizeGoogleRating(r.rating).verdict === "False");

        if (falseClaims.length > 0) {
          // Compose embeds for false claims
          const pages = composeFactCheckEmbed(combinedStatement, falseClaims);
          const r = pages[0];
          const embed = new EmbedBuilder()
            .setColor(r.color)
            .setTitle(`Fact-Check Alert for ${username}`)
            .addFields(
              { name: "Claim", value: `> ${r.claim}` },
              { name: "Verdict", value: r.verdict, inline: true },
              { name: "Original Rating", value: r.rating, inline: true },
              { name: "Publisher", value: r.publisher, inline: true },
              { name: "Source", value: `[Link](${r.url})` },
              { name: "Reviewed Date", value: r.date, inline: true }
            )
            .setTimestamp();

          await channel.send({
            content: `⚠️ Fact-check alert: False claims detected from <@${userId}> in recent messages.`,
            embeds: [embed]
          });

          // Notify summary channel
          const notifyChannel = await client.channels.fetch(NOTIFY_CHANNEL_ID).catch(() => null);
          if (notifyChannel) {
            await notifyChannel.send(`⚠️ Fact-check: Detected ${falseClaims.length} false claim(s) from <@${userId}> in <#${channelId}>.`);
          }
        }
      }

      // Clear buffered messages for this user and channel
      CHANNEL_BUFFERS[channelId][userId] = [];
    }
  }
}, FACT_CHECK_INTERVAL_MS);

// ------------------------
// Message Handler: buffer watched user messages without immediate fact-check
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const member = message.member;
  const isAuthorized = message.author.id === "306197826575138816" || member.roles.cache.has("1410526844318388336");
  const isWatchedUser = WATCHED_USER_IDS.includes(message.author.id);
  const isWatchedChannel = WATCHED_CHANNEL_IDS.includes(message.channel.id);
  const command = COMMANDS.find(cmd => message.content.toLowerCase().startsWith(cmd));
  // Manual commands behave as before
  if (command && isAuthorized) {
    const now = Date.now();
    if (cooldowns[message.author.id] && now - cooldowns[message.author.id] < COOLDOWN_SECONDS * 1000) {
      return message.reply(`⏱ Please wait ${COOLDOWN_SECONDS} seconds between fact-checks.`);
    }
    cooldowns[message.author.id] = now;
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
    await runFactCheck(statement, message.channel);
    return;
  }
  // Buffer messages from watched users in watched channels
  if (isWatchedUser && isWatchedChannel) {
    if (!CHANNEL_BUFFERS[message.channel.id]) CHANNEL_BUFFERS[message.channel.id] = {};
    if (!CHANNEL_BUFFERS[message.channel.id][message.author.id]) CHANNEL_BUFFERS[message.channel.id][message.author.id] = [];
    CHANNEL_BUFFERS[message.channel.id][message.author.id].push(message.content.trim());
  }
});

// ------------------------
// Manual runFactCheck function from your original code (unchanged)
async function runFactCheck(statement, channel) {
  const sentMessage = await channel.send(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);
  const { results, error } = await factCheck(statement);
  if (error) {
    await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${error}`);
    return;
  }
  if (!results || results.length === 0) {
    return handlePerplexityFallback(statement, sentMessage);
  }
  const pages = [];
  results.forEach(r => {
    const parts = splitText(r.claim, 1000);
    parts.forEach(p => {
      const norm = normalizeGoogleRating(r.rating);
      pages.push({
        claim: p,
        verdict: norm.verdict,
        color: norm.color,
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
      .setColor(r.color)
      .setTitle(`Fact-Check Result ${idx + 1}/${pages.length}`)
      .addFields(
        { name: "Claim", value: `> ${r.claim}` },
        { name: "Verdict", value: r.verdict, inline: true },
        { name: "Original Rating", value: r.rating, inline: true },
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
}

// ------------------------
// Bot Startup
// ------------------------
(async () => {
  try {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error("DISCORD_TOKEN environment variable is not set!");
    await client.login(token);
    client.once("ready", () => {
      console.log(`Logged in as ${client.user.tag}`);
      client.user.setPresence({
        activities: [{ name: "👀 Rishi & Sav", type: 3 }],
        status: "online",
      });
    });
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Bot is running!");
    }).listen(PORT, () => {
      console.log(`Listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();
