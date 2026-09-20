require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
  try {
    const route = config.guildId
      ? Routes.applicationGuildCommands(config.clientId, config.guildId)
      : Routes.applicationCommands(config.clientId);

    await rest.put(route, { body: commands });
    console.log(
      `Deployed ${commands.length} slash commands${config.guildId ? ` to guild ${config.guildId}` : ' globally'}.`
    );
  } catch (err) {
    console.error(err);
  }
})();
