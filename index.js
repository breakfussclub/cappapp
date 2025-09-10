// index.js - Discord.js v14 compatible full bot
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
  SlashCommandBuilder
} = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2
const http = require("http");

// ------------------------
// CONFIG - update / set env vars as appropriate
// ------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // required
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_GOOGLE_API_KEY";
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || "YOUR_PERPLEXITY_API_KEY";

// If true, slash replies are ephemeral (hidden). NOTE: ephemeral messages + components can be tricky.
// Default false so pagination buttons reliably work.
const SLASH_REPLIES_EPHEMERAL = false;

const COOLDOWN_SECONDS = 10;
const COMMAND_ALIASES = ["!cap", "!fact", "!verify"]; // prefix aliases
const SLASH_NAMES = COMMAND_ALIASES.map(c => c.replace("!", "")); // 'cap','fact','verify'

// Access control (same as your original)
const ALLOWED_USER_ID = "306197826575138816";
const ALLOWED_ROLE_ID = "1410526844318388336";

// Rate limiting map: userId -> timestamp (ms)
const cooldowns = {};

// ------------------------
// Client
// ------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

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
  return { verdict: "Other", color: 0xffff00 };
}

// ------------------------
// Google Fact Check
// ------------------------
async function factCheck(statement) {
  const url = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(statement)}&key=${GOOGLE_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `⚠️ Error contacting Fact Check API: ${res.status}` };
    const data = await res.json();
    const claims = data.claims || [];
    if (!claims.length) return { results: [] };

    const results = [];
    claims.forEach(claim => {
      (claim.claimReview || []).forEach(review => {
        results.push({
          claim: claim.text || "",
          rating: review.textualRating || "Unknown",
          publisher: review.publisher?.name || "Unknown",
          url: review.url || "",
          date: review.publishDate || "Unknown"
        });
      });
    });
    return { results };
  } catch (err) {
    console.error("factCheck error:", err);
    return { error: "⚠️ An error occurred while contacting the Fact Check API." };
  }
}

// ------------------------
// Perplexity fallback (simple classifier prompt)
// ------------------------
async function queryPerplexity(statement) {
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar",
    messages: [
      { role: "system", content: "Classify strictly as 'True' or 'False'. Provide a short reason and sources if available. Use format:\\nVerdict: True/False\\nReason: <text>\\nSources: <list>" },
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
      console.error(`Perplexity HTTP ${res.status}`);
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
    const sources = sourcesText ? sourcesText.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];

    return { verdict, color, reason, sources, raw: content };
  } catch (err) {
    console.error("queryPerplexity error:", err);
    return null;
  }
}

// ------------------------
// Perplexity fallback handlers (message vs interaction)
// ------------------------
async function handlePerplexityFallbackForMessage(messageObj, statement) {
  const res = await queryPerplexity(statement);
  if (!res) {
    return messageObj.edit("❌ Could not get a response from Perplexity.");
  }

  const embed = new EmbedBuilder()
    .setColor(res.color)
    .setTitle("Fact-Check Result (Perplexity)")
    .addFields(
      { name: "Claim", value: `> ${statement}` },
      { name: "Verdict", value: res.verdict },
      { name: "Reasoning", value: res.reason.slice(0, 1000) }
    );

  if (res.sources.length) embed.addFields({ name: "Sources", value: res.sources.slice(0, 6).join("\n") });

  await messageObj.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed], components: [] });
}

async function handlePerplexityFallbackForInteraction(interaction, statement) {
  const res = await queryPerplexity(statement);
  if (!res) {
    return interaction.editReply({ content: "❌ Could not get a response from Perplexity." });
  }

  const embed = new EmbedBuilder()
    .setColor(res.color)
    .setTitle("Fact-Check Result (Perplexity)")
    .addFields(
      { name: "Claim", value: `> ${statement}` },
      { name: "Verdict", value: res.verdict },
      { name: "Reasoning", value: res.reason.slice(0, 1000) }
    );

  if (res.sources.length) embed.addFields({ name: "Sources", value: res.sources.slice(0, 6).join("\n") });

  await interaction.editReply({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed], components: [] });
}

// ------------------------
// Unified runFactCheck
// - target: Message (prefix) OR Interaction (slash)
// - isInteraction boolean
// ------------------------
async function runFactCheck(target, statement, isInteraction = false) {
  // Access control already done by caller
  try {
    let messageObject; // the Message instance we can edit/create collectors on

    // Defer interaction or send initial message for prefix
    if (isInteraction) {
      // Defer immediately so interaction doesn't expire
      if (SLASH_REPLIES_EPHEMERAL) {
        await target.deferReply({ flags: 64 }); // ephemeral
      } else {
        await target.deferReply(); // public reply
      }
      // fetchReply returns the message object (so we can create collectors on it)
      messageObject = await target.fetchReply();
    } else {
      messageObject = await target.reply({ content: `🧐 Fact-checking: "${statement}"\n\n⏳ Checking...` });
    }

    // Query Google Fact Check
    const { results, error } = await factCheck(statement);

    if (error) {
      const content = `🧐 Fact-checking: "${statement}"\n\n${error}`;
      if (isInteraction) await target.editReply({ content });
      else await messageObject.edit({ content });
      return;
    }

    // No results -> Perplexity fallback
    if (!results || results.length === 0) {
      if (isInteraction) return handlePerplexityFallbackForInteraction(target, statement);
      else return handlePerplexityFallbackForMessage(messageObject, statement);
    }

    // Build pages from Google results
    const pages = [];
    results.forEach(r => {
      splitText(r.claim || "", 1000).forEach(part => {
        const norm = normalizeGoogleRating(r.rating);
        pages.push({
          claim: part,
          verdict: norm.verdict,
          color: norm.color,
          rating: r.rating,
          publisher: r.publisher,
          url: r.url,
          date: r.date
        });
      });
    });

    // pagination state
    let index = 0;
    const generateEmbed = (i) => {
      const r = pages[i];
      return new EmbedBuilder()
        .setColor(r.color)
        .setTitle(`Fact-Check Result ${i + 1}/${pages.length}`)
        .addFields(
          { name: "Claim", value: `> ${r.claim}` },
          { name: "Verdict", value: r.verdict, inline: true },
          { name: "Original Rating", value: r.rating, inline: true },
          { name: "Publisher", value: r.publisher, inline: true },
          { name: "Source", value: r.url ? `[Link](${r.url})` : "N/A" },
          { name: "Reviewed Date", value: r.date, inline: true }
        )
        .setTimestamp();
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("prev").setLabel("◀️ Previous").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId("next").setLabel("Next ▶️").setStyle(ButtonStyle.Primary).setDisabled(pages.length === 1),
      new ButtonBuilder().setCustomId("quick").setLabel("🔄 Quick Search").setStyle(ButtonStyle.Secondary)
    );

    // helper to safely edit the interaction or message
    const safeEdit = async (opts) => {
      if (isInteraction) return target.editReply(opts);
      return messageObject.edit(opts);
    };

    // update the reply with the first page and components
    await safeEdit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [generateEmbed(index)], components: [row] });

    // get the message we can attach collectors to
    const msg = isInteraction ? await target.fetchReply() : messageObject;

    // collector listens only for button clicks on this message
    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

    collector.on("collect", async (interactionButton) => {
      try {
        // Only allow the user who invoked the command to page (optional) OR allow anyone — choose here.
        // Example: restrict to command user:
        // if (interactionButton.user.id !== (isInteraction ? target.user.id : target.author.id)) {
        //   return interactionButton.reply({ content: "This is not your pagination.", ephemeral: true });
        // }

        if (interactionButton.customId === "next") index = Math.min(index + 1, pages.length - 1);
        if (interactionButton.customId === "prev") index = Math.max(index - 1, 0);
        if (interactionButton.customId === "quick") index = 0;

        row.components[0].setDisabled(index === 0);
        row.components[1].setDisabled(index === pages.length - 1);

        await interactionButton.update({ embeds: [generateEmbed(index)], components: [row] });
      } catch (err) {
        console.error("collector collect err:", err);
      }
    });

    collector.on("end", async () => {
      try {
        row.components.forEach(b => b.setDisabled(true));
        await safeEdit({ components: [row] });
      } catch (err) {
        console.error("collector end err:", err);
      }
    });
  } catch (err) {
    console.error("runFactCheck error:", err);
    // best-effort error response
    try {
      if (isInteraction) await target.editReply({ content: "⚠️ An error occurred while processing your request." });
      else await target.reply({ content: "⚠️ An error occurred while processing your request." });
    } catch (e) {
      console.error("failed to send error reply:", e);
    }
  }
}

// ------------------------
// Prefix message handler
// ------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // only allowed user or role may use
  const member = message.member;
  if (message.author.id !== ALLOWED_USER_ID && !(member && member.roles.cache.has(ALLOWED_ROLE_ID))) return;

  const content = message.content || "";
  const lower = content.toLowerCase();
  const alias = COMMAND_ALIASES.find(a => lower.startsWith(a));
  if (!alias) return;

  // cooldown
  const now = Date.now();
  if (cooldowns[message.author.id] && now - cooldowns[message.author.id] < COOLDOWN_SECONDS * 1000) {
    return message.reply("⏱ Please wait 10 seconds between fact-checks.");
  }
  cooldowns[message.author.id] = now;

  // determine statement: either replied message or after the alias text
  let statement = null;
  if (message.reference) {
    try {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      if (replied) statement = replied.content.trim();
    } catch (err) { /* ignore */ }
  }

  if (!statement) statement = content.slice(alias.length).trim();
  if (!statement) return message.reply('⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`');

  await runFactCheck(message, statement, false);
});

// ------------------------
// Slash command registration (global)
// ------------------------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  const slashDefinitions = SLASH_NAMES.map(name =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(`Fact-check a statement (alias: ${name})`)
      .addStringOption(opt => opt.setName("statement").setDescription("Statement to fact-check").setRequired(true))
      .toJSON()
  );

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashDefinitions });
    console.log("✅ Global slash commands registered");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }

  client.user.setPresence({
    activities: [{ name: "👀 Rishi & Sav", type: 3 }],
    status: "online"
  });
});

// ------------------------
// Slash (interaction) handler
// ------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // only allowed user or role may use
  const member = interaction.member;
  if (interaction.user.id !== ALLOWED_USER_ID && !(member && member.roles && member.roles.cache.has(ALLOWED_ROLE_ID))) {
    return interaction.reply({ content: "❌ You are not allowed to use this command.", flags: 64 });
  }

  // cooldown
  const now = Date.now();
  if (cooldowns[interaction.user.id] && now - cooldowns[interaction.user.id] < COOLDOWN_SECONDS * 1000) {
    return interaction.reply({ content: `⏱ Please wait ${COOLDOWN_SECONDS} seconds between fact-checks.`, flags: 64 });
  }
  cooldowns[interaction.user.id] = now;

  const statement = interaction.options.getString("statement");
  if (!statement) return interaction.reply({ content: "⚠️ Please provide a statement to fact-check.", flags: 64 });

  // run
  await runFactCheck(interaction, statement, true);
});

// ------------------------
// Login + simple HTTP server (for Render)
// ------------------------
client.login(DISCORD_TOKEN).catch(err => console.error("Failed to login:", err));

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!");
}).listen(PORT, () => console.log(`Listening on port ${PORT}`));


