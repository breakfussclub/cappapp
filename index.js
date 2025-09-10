const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ComponentType, 
  REST, 
  Routes, 
  InteractionType 
} = require("discord.js");
const fetch = require("node-fetch");
const http = require("http");

// ---------------- CONFIG ----------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Hard-coded API keys
const GOOGLE_API_KEY = "YOUR_GOOGLE_API_KEY";
const PERPLEXITY_API_KEY = "YOUR_PERPLEXITY_API_KEY";

// Rate limiting
const cooldowns = {};
const COOLDOWN_SECONDS = 10;

// Command aliases
const COMMANDS = ["cap", "fact", "verify"];

// ---------------- CLIENT ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ---------------- GLOBAL SLASH REGISTRATION ----------------
async function registerGlobalSlashCommands() {
  const commands = COMMANDS.map(name => ({
    name,
    description: `Fact-check a statement with /${name}`,
    options: [
      {
        name: "statement",
        type: 3, // STRING
        description: "The claim to fact-check",
        required: false
      }
    ]
  }));

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("Registering global slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Global slash commands registered!");
  } catch (err) {
    console.error("❌ Error registering commands:", err);
  }
}

// ---------------- HELPERS ----------------
function splitText(text, maxLength = 1000) {
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) parts.push(text.slice(i, i + maxLength));
  return parts;
}

function normalizeRating(rating) {
  if (!rating) return { verdict: "Other", color: 0xffff00 };
  const r = rating.toLowerCase();
  if (r.includes("true") || r.includes("correct") || r.includes("accurate")) return { verdict: "True", color: 0x00ff00 };
  if (r.includes("false") || r.includes("incorrect") || r.includes("pants on fire") || r.includes("hoax")) return { verdict: "False", color: 0xff0000 };
  return { verdict: "Other", color: 0xffff00 };
}

// ---------------- GOOGLE FACT-CHECK ----------------
async function googleFactCheck(statement) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(statement)}&key=${GOOGLE_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `⚠️ Google Fact Check API error: ${res.status}` };
    const data = await res.json();
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
  } catch (err) {
    console.error(err);
    return { error: "⚠️ Error contacting Google Fact Check API." };
  }
}

// ---------------- PERPLEXITY FALLBACK ----------------
async function queryPerplexity(statement) {
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar",
    messages: [
      { role: "system", content: "Classify the following statement strictly as True or False. Format: Verdict: True/False\nReason: ...\nSources: ..." },
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

    const verdictMatch = content.match(/Verdict:\s*(True|False)/i);
    const verdict = verdictMatch ? verdictMatch[1] : "Other";
    const color = verdict.toLowerCase() === "true" ? 0x00ff00 : verdict.toLowerCase() === "false" ? 0xff0000 : 0xffff00;

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
  const result = await queryPerplexity(statement);
  if (!result) {
    await sentMessage.edit(`❌ Could not get a response from Perplexity.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(result.color)
    .setTitle(`Fact-Check Result (Perplexity)`)
    .addFields(
      { name: "Claim", value: `> ${statement}` },
      { name: "Verdict", value: result.verdict },
      { name: "Reasoning", value: result.reason.slice(0, 1000) }
    );

  if (result.sources.length > 0) {
    embed.addFields({ name: "Sources", value: result.sources.slice(0, 6).join("\n") });
  }

  await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed], components: [] });
}

// ---------------- SHARED FACT-CHECK FUNCTION ----------------
async function performFactCheck(statement, sentMessage) {
  const { results, error } = await googleFactCheck(statement);

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
      const norm = normalizeRating(r.rating);
      pages.push({ claim: p, verdict: norm.verdict, color: norm.color, rating: r.rating, publisher: r.publisher, url: r.url, date: r.date });
    });
  });

  let index = 0;
  const generateEmbed = (idx) => {
    const r = pages[idx];
    return new EmbedBuilder()
      .setColor(r.color)
      .setTitle(`Fact-Check Result ${idx+1}/${pages.length}`)
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
    new ButtonBuilder().setCustomId("next").setLabel("Next ▶️").setStyle(ButtonStyle.Primary).setDisabled(pages.length === 1)
  );

  const msg = await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [generateEmbed(index)], components: [row] });

  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

  collector.on("collect", async i => {
    if (i.customId === "next" && index < pages.length-1) index++;
    if (i.customId === "prev" && index > 0) index--;
    row.components[0].setDisabled(index === 0);
    row.components[1].setDisabled(index === pages.length-1);
    await i.update({ embeds: [generateEmbed(index)], components: [row] });
  });

  collector.on("end", async () => {
    row.components.forEach(btn => btn.setDisabled(true));
    await msg.edit({ components: [row] });
  });
}

// ---------------- TEXT COMMAND HANDLER ----------------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  const [cmd, ...args] = msg.content.trim().split(/\s+/);
  const base = cmd.slice(1).toLowerCase();
  if (!COMMANDS.includes(base)) return;

  // Rate limiting
  const now = Date.now();
  if (cooldowns[msg.author.id] && now - cooldowns[msg.author.id] < COOLDOWN_SECONDS * 1000) {
    return msg.reply(`⏱ Please wait ${COOLDOWN_SECONDS} seconds between fact-checks.`);
  }
  cooldowns[msg.author.id] = now;

  let statement = args.join(" ");
  if (!statement && msg.reference) {
    try {
      const refMsg = await msg.channel.messages.fetch(msg.reference.messageId);
      statement = refMsg.content;
    } catch {}
  }
  if (!statement) return msg.reply("⚠️ Please provide a statement or reply to a message.");

  const sentMsg = await msg.reply(`🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`);
  performFactCheck(statement, sentMsg);
});

// ---------------- SLASH COMMAND HANDLER ----------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!COMMANDS.includes(interaction.commandName)) return;

  let statement = interaction.options.getString("statement");

  // If no input, check if replying
  if (!statement && interaction.type === InteractionType.ApplicationCommand) {
    const ref = interaction.targetMessage;
    if (ref) statement = ref.content;
  }

  if (!statement) {
    return interaction.reply({ content: "⚠️ Please provide a statement or reply to a message.", ephemeral: true });
  }

  const sentMsg = await interaction.reply({ content: `🧐 Fact-checking: "${statement}"\n\n⏳ Checking...`, fetchReply: true });
  performFactCheck(statement, sentMsg);
});

// ---------------- STARTUP ----------------
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: "Fact-Checking", type: 3 }], status: "online" });
});

registerGlobalSlashCommands();
client.login(DISCORD_TOKEN);

// ---------------- HTTP SERVER FOR RENDER ----------------
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!");
}).listen(PORT, () => console.log(`Listening on port ${PORT}`));
