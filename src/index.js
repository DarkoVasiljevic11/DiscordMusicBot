const path = require('node:path');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const play = require('@iamtraction/play-dl');
const config = require('./config');
const { queues, destroyQueue } = require('./queueManager');

// --- ffmpeg path resolution ---
// Respect an FFMPEG_PATH already set via .env (lets you point at a manual
// install on any OS). Otherwise try the bundled ffmpeg-static binary, but
// only if it actually exists — a corrupted/blocked download of it has been
// a real issue before, and silently pointing at a broken file is worse than
// not setting FFMPEG_PATH at all (prism-media falls back to the system PATH
// on its own). If neither works out, leave it unset.
if (!process.env.FFMPEG_PATH) {
  try {
    const ffmpegStaticPath = require('ffmpeg-static');
    if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
      process.env.FFMPEG_PATH = ffmpegStaticPath;
    }
  } catch {
    // ffmpeg-static not installed/resolvable — fine, rely on system PATH.
  }
}

// --- startup config validation ---
const missing = [];
if (!config.token) missing.push('DISCORD_TOKEN');
if (!config.clientId) missing.push('CLIENT_ID');
if (missing.length > 0) {
  console.error(`Missing required .env value(s): ${missing.join(', ')}. Copy .env.example to .env and fill these in.`);
  process.exit(1);
}
if (!config.spotify.clientId || !config.spotify.clientSecret) {
  console.warn('SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET are not set — Spotify links will fail until these are configured in .env.');
}

// --- crash protection ---
// Without these, a single unrelated bug anywhere (a rejected promise that
// nothing awaited, an unexpected throw in an event handler) takes down the
// entire bot with no recovery. Log it and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (bot is still running):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (bot is still running):', reason);
});

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

// --- graceful shutdown ---
// Cleanly disconnect from every active voice channel instead of just killing
// the process mid-connection when the bot is stopped (Ctrl+C, service
// restart, etc.).
async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  for (const guildId of queues.keys()) {
    destroyQueue(guildId);
  }
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token);
