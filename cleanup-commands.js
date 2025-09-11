const { REST, Routes } = require('discord.js');
require('dotenv').config();

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const appId = '1407254273925845073'; // Replace with your bot's application/client ID

    // Wipe global commands
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log('✅ All global slash commands removed.');

    // (Optional) Wipe from a specific guild (if you had test guild commands)
    const guildId = '917154833750978562'; // Replace with your test server ID if needed
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
    console.log(`✅ All slash commands removed from guild ${guildId}`);
  } catch (err) {
    console.error(err);
  }
})();
