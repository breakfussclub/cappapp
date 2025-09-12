const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ComponentType 
} = require("discord.js");
const fetch = require("node-fetch");
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

const COOLDOWN_MS = 30000; // 30 seconds per user
const COMMANDS = ["!cap", "!fact", "!verify"];
const WATCHED_USER_IDS = ["306197826575138816"];
const WATCHED_CHANNEL_IDS = ["1410526844318388336"];

// Extended negation words list
const NEGATION_WORDS = [
  "no", "not", "didn't", "never", "wrong", "false", 
  "lies", "incorrect", "untrue", "never happened", 
  "nah", "nonsense", "liar", "deny", "denies"
];

// ------------------------
// Buffers & cooldowns
// ------------------------
const cooldowns = {};
const channelBuffers = {}; // per-channel for context

// ------------------------
// Helpers
// ------------------------
function splitText(text, maxLength = 1000) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) parts.push(text.slice(i, i + maxLength));
  return parts;
}

function normalizeGoogleRating(rating) {
  if (!rating) return { verdict: "Other", color: 0xffff00 };
  const r = rating.toLowerCase();
  if (r.includes("true") || r.includes("correct") || r.includes("accurate")) return { verdict: "True", color: 0x00ff00 };
  if (r.includes("false") || r.includes("incorrect") || r.includes("pants on fire") || r.includes("hoax")) return { verdict: "False", color: 0xff0000 };
  if (r.includes("partly") || r.includes("misleading") || r.includes("half")) return { verdict: "Misleading", color: 0xffff00 };
  return { verdict: "Other", color: 0xffff00 };
}

function extractKeywords(text) {
  return text.toLowerCase().match(/\b\w+\b/g) || [];
}

// ------------------------
// Fact-check functions
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

async function queryPerplexity(statement) {
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar",
    messages: [
      { role: "system", content: "Classify the following statement strictly as either 'True' or 'False'. Provide a short reasoning and include sources if possible. Use the format: \nVerdict: True/False\nReason: <text>\nSources: <list>" },
      { role: "user", content: statement }
    ]
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) { console.error(`Perplexity API error: HTTP ${res.status}`); return null; }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const verdictMatch = content.match(/Verdict:\s*(True|False)/i);
    const verdict = verdictMatch ? verdictMatch[1] : "Other";
    const color = verdict.toLowerCase() === "true" ? 0x00ff00 :
                  verdict.toLowerCase() === "false" ? 0xff0000 : 0xffff00;
    const reasonMatch = content.match(/Reason:\s*([\s\S]*?)(?:Sources:|$)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : "No reasoning provided.";
    const sourcesMatch = content.match(/Sources:\s*([\s\S]*)/i);
    const sourcesText = sourcesMatch ? sourcesMatch[1].trim() : "";
    const sources = sourcesText.split("\n").filter(s => s.trim().length > 0);
    return { verdict, color, reason, sources, raw: content };
  } catch (err) { console.error("Perplexity API error:", err); return null; }
}

async function handlePerplexityFallback(statement, sentMessage) {
  const perplexityResult = await queryPerplexity(statement);
  if (!perplexityResult) { await sentMessage.edit(`❌ Could not get a response from Perplexity.`); return; }
  const embed = new EmbedBuilder()
    .setColor(perplexityResult.color)
    .setTitle(`Fact-Check Result`)
    .addFields(
      { name: "Claim", value: `> ${statement}` },
      { name: "Verdict", value: perplexityResult.verdict },
      { name: "Reasoning", value: perplexityResult.reason.slice(0, 1000) }
    )
    .setTimestamp();
  if (perplexityResult.sources.length > 0) embed.addFields({ name: "Sources", value: perplexityResult.sources.slice(0, 6).join("\n") });
  await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed], components: [] });
}

// ------------------------
// Run fact-check (shared)
async function runFactCheck(statement, channel) {
  const sentMessage = await channel.send(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);
  const { results, error } = await factCheck(statement);
  if (error) { await sentMessage.edit(`🧐 Fact-checking: "${statement}"\n\n${error}`); return; }
  if (!results || results.length === 0) return handlePerplexityFallback(statement, sentMessage);

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
// Message Handler
// ------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const allowedUserId = "306197826575138816";
  const allowedRoleId = "1410526844318388336";
  const member = message.member;

  if (message.author.id !== allowedUserId && !member.roles.cache.has(allowedRoleId)) return;

  const command = COMMANDS.find(cmd => message.content.toLowerCase().startsWith(cmd));
  const now = Date.now();
  if (cooldowns[message.author.id] && now - cooldowns[message.author.id] < COOLDOWN_MS) {
    return message.reply(`⏱ Please wait ${COOLDOWN_MS / 1000} seconds between fact-checks.`);
  }
  cooldowns[message.author.id] = now;

  let statement = null;

  // Manual command
  if (command) {
    statement = message.content.slice(command.length).trim();
  }
  // Auto-scan for negation/short messages
  else if (NEGATION_WORDS.some(w => message.content.toLowerCase().includes(w)) || message.content.length < 30) {
    statement = message.content.trim();
  }

  if (!statement) return; // skip normal messages

  // Initialize channel buffer
  if (!channelBuffers[message.channel.id]) channelBuffers[message.channel.id] = [];
  const keywords = extractKeywords(statement);

  // Store statement in channel buffer for context
  channelBuffers[message.channel.id].push({ content: statement, keywords });
  if (channelBuffers[message.channel.id].length > 5) channelBuffers[message.channel.id].shift();

  // Negation context handling
  if (NEGATION_WORDS.some(w => statement.toLowerCase().includes(w))) {
    let relevantMsg = null;
    let maxOverlap = 0;
    const buffer = channelBuffers[message.channel.id];
    for (const m of buffer) {
      const overlap = m.keywords.filter(k => keywords.includes(k)).length;
      if (overlap > maxOverlap) { maxOverlap = overlap; relevantMsg = m.content; }
    }
    if (relevantMsg) statement = relevantMsg + "\nReply: " + statement;
  }

  await runFactCheck(statement, message.channel);
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
