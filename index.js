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

// ------------------------
// HELPERS
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
// GOOGLE FACT CHECK
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
    return { error: "⚠️ An error occurred while contacting the Fact Check API." };
  }
}

// ------------------------
// PERPLEXITY FALLBACK
// ------------------------
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
      headers: {
        "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;

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

// ------------------------
// PERPLEXITY FALLBACK EDIT
// ------------------------
async function handlePerplexityFallback(statement, messageOrInteraction, sentMessage, isInteraction) {
  const res = await queryPerplexity(statement);
  if (!res) {
    const content = `❌ Could not get a response from Perplexity.`;
    return isInteraction ? await messageOrInteraction.editReply({ content }) : await sentMessage.edit({ content });
  }

  const embed = new EmbedBuilder()
    .setColor(res.color)
    .setTitle("Fact-Check Result (Perplexity)")
    .addFields(
      { name: "Claim", value: `> ${statement}` },
      { name: "Verdict", value: res.verdict },
      { name: "Reasoning", value: res.reason.slice(0, 1000) }
    )
    .setTimestamp();

  if (res.sources.length) embed.addFields({ name: "Sources", value: res.sources.slice(0, 6).join("\n") });

  if (isInteraction) {
    await messageOrInteraction.editReply({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed], components: [] });
  } else {
    await sentMessage.edit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [embed], components: [] });
  }
}

// ------------------------
// RUN FACT CHECK
// ------------------------
async function runFactCheck(messageOrInteraction, statement) {
  const isInteraction = messageOrInteraction.isChatInputCommand?.() || false;
  let sentMessage;

  if (isInteraction) {
    await messageOrInteraction.deferReply({ flags: 64 }); // ephemeral
    sentMessage = await messageOrInteraction.fetchReply();
  } else {
    sentMessage = await messageOrInteraction.reply({ content: `🧐 Fact-checking: "${statement}"\n\n⏳ Checking...` });
  }

  const { results, error } = await factCheck(statement);

  if (error) return isInteraction ? await messageOrInteraction.editReply({ content: error }) : await sentMessage.edit({ content: error });
  if (!results.length) return handlePerplexityFallback(statement, messageOrInteraction, sentMessage, isInteraction);

  const pages = [];
  results.forEach(r => splitText(r.claim, 1000).forEach(p => {
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
  }));

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

  const safeEdit = async (options) => isInteraction ? await messageOrInteraction.editReply(options) : await sentMessage.edit(options);

  await safeEdit({ content: `🧐 Fact-checking: "${statement}"`, embeds: [generateEmbed(index)], components: [row] });

  const msg = isInteraction ? await messageOrInteraction.fetchReply() : sentMessage;
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
    row.components.forEach(b => b.setDisabled(true));
    await safeEdit({ components: [row] });
  });
}

// ------------------------
// MESSAGE HANDLER
// ------------------------
client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const allowedUserId = "306197826575138816";
  const allowedRoleId = "1410526844318388336";
  const member = message.member;
  if (message.author.id !== allowedUserId && !member.roles.cache.has(allowedRoleId)) return;

  const command = COMMANDS.find(cmd => message.content.toLowerCase().startsWith(cmd));
  if (!command) return;

  const now = Date.now();
  if (cooldowns[message.author.id] && now - cooldowns[message.author.id] < COOLDOWN_SECONDS * 1000)
    return message.reply(`⏱ Please wait ${COOLDOWN_SECONDS} seconds between fact-checks.`);
  cooldowns[message.author.id] = now;

  let statement = null;
  if (message.reference) {
    try {
      const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedMessage) statement = repliedMessage.content.trim();
    } catch {}
  }
  if (!statement) statement = message.content.slice(command.length).trim();
  if (!statement) return message.reply("⚠️ Please provide a statement to fact-check. Example: `!cap The sky is green`");

  await runFactCheck(message, statement);
});

// ------------------------
// GLOBAL SLASH COMMANDS
// ------------------------
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  const slashCommands = COMMANDS.map(cmd =>
    new SlashCommandBuilder()
      .setName(cmd.replace("!", ""))
      .setDescription(`Fact-check a statement using ${cmd}`)
      .addStringOption(opt => opt.setName("statement").setDescription("Statement to fact-check").setRequired(true))
  );

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log("✅ Global slash commands registered");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }

  client.user.setPresence({
    activities: [{ name: "👀 Rishi & Sav", type: 3 }],
    status: "online",
  });
});

// ------------------------
// SLASH COMMAND HANDLER
// ------------------------
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const allowedUserId = "306197826575138816";
  const allowedRoleId = "1410526844318388336";
  const member = interaction.member;
  if (interaction.user.id !== allowedUserId && !member.roles.cache.has(allowedRoleId))
    return interaction.reply({ content: "❌ You are not allowed to use this command.", flags: 64 });

  const statement = interaction.options.getString("statement");
  const now = Date.now();
  if (cooldowns[interaction.user.id] && now - cooldowns[interaction.user.id] < COOLDOWN_SECONDS * 1000)
    return interaction.reply({ content: `⏱ Please wait ${COOLDOWN_SECONDS} seconds between fact-checks.`, flags: 64 });
  cooldowns[interaction.user.id] = now;

  await runFactCheck(interaction, statement);
});

// ------------------------
// LOGIN + HTTP SERVER
// ------------------------
client.login(process.env.DISCORD_TOKEN);
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!");
}).listen(PORT, () => console.log(`Listening on port ${PORT}`));
