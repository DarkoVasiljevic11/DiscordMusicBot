// Make sure @discordjs/voice can find ffmpeg without a system install
process.env.FFMPEG_PATH = 'C:\\ffmpeg\\bin\\ffmpeg.exe';

const path = require('node:path');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const play = require('@iamtraction/play-dl');
const config = require('./config');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // SoundCloud requests fail with "SoundCloud Data is missing" unless a
  // client_id is set first. getFreeClientID() scrapes a public one from
  // soundcloud.com the same way the old play-dl used to do automatically.
  try {
    const scClientId = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: scClientId } });
    console.log('SoundCloud client ID acquired — SoundCloud links/search are ready.');
  } catch (err) {
    console.error('Could not acquire a SoundCloud client ID. SoundCloud links will fail until this succeeds:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const payload = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
  // Button interactions (e.g. queue pagination) are handled by their own
  // per-message collectors set up in the command that created them.
});

client.login(config.token);
