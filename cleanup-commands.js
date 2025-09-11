// cleanup-commands.js
const { REST, Routes } = require("discord.js");

// 🔑 Replace these with your bot’s info
const TOKEN = "1407254273925845073";
const CLIENT_ID = "MTQwNzI1NDI3MzkyNTg0NTA3Mw.G1uPgT.MBJf-1ykSBokkZtuBo9M3mySw0hlpseZP7zc9o";

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("🧹 Clearing ALL global application (slash) commands...");

    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

    console.log("✅ Successfully cleared all global commands.");
  } catch (err) {
    console.error("❌ Error clearing commands:", err);
  }
})();
