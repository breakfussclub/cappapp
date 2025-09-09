const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const fetch = require("node-fetch");
const http = require("http");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const API_KEY = "AIzaSyC18iQzr_v8xemDMPhZc1UEYxK0reODTSc";

// ------------------------
// Register slash command
// ------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("factcheck")
    .setDescription("Fact-check a statement using Google Fact Check Tools")
    .addStringOption(option =>
      option.setName("statement")
        .setDescription("The statement to fact-check")
        .setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error("Error registering slash commands:", error);
  }
})();

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
// Slash command handler with pagination
// ------------------------
client.on("interactionCreate", async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== "factcheck") return;

  const statement = interaction.options.getString("statement");
  await interaction.deferReply();

  const { results, error } = await factCheck(statement);

  if (error) return interaction.editReply(error);

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

  const message = await interaction.editReply({ embeds: [generateEmbed(index)], components: [row] });

  const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120000 });

  collector.on("collect", async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: "You cannot interact with this button.", ephemeral: true });
    }

    if (i.customId === "next") index++;
    if (i.customId === "prev") index--;

    // update buttons
    row.components[0].setDisabled(index === 0);
    row.components[1].setDisabled(index === results.length - 1);

    await i.update({ embeds: [generateEmbed(index)], components: [row] });
  });

  collector.on("end", async () => {
    row.components.forEach(button => button.setDisabled(true));
    await message.edit({ components: [row] });
  });
});

// ------------------------
// Bot ready
// ------------------------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: "👀 Rishi & Poit", type: 3 }],
    status: "dnd",
  });
});

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












