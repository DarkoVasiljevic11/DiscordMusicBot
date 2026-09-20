const {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const play = require('@iamtraction/play-dl');
const GuildQueue = require('./structures/Queue');

const queues = new Map();

function getQueue(guildId) {
  return queues.get(guildId);
}

async function createQueue(guildId, { textChannel, voiceChannel }) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    throw new Error(
      "Couldn't establish a voice connection (timed out waiting to become ready). This is usually caused by a firewall, VPN, or network blocking Discord's voice (UDP) traffic."
    );
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  const queue = new GuildQueue({ guildId, textChannel, voiceChannel, connection, player });
  queues.set(guildId, queue);

  player.on(AudioPlayerStatus.Idle, () => {
    const wasSkipped = queue.skipFlag;
    queue.skipFlag = false;

    if (queue.loop && queue.current && !wasSkipped) {
      // Put the just-finished track back at the front so playNext replays it.
      queue.songs.unshift(queue.current);
    }

    queue.current = null;
    playNext(guildId);
  });

  player.on('error', (error) => {
    console.error(`Playback error in guild ${guildId}:`, error);
    queue.textChannel?.send(`⚠️ Playback error: ${error.message}. Skipping.`).catch(() => {});
    queue.current = null;
    playNext(guildId);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(guildId);
    }
  });

  return queue;
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.leaveTimeout) {
    clearTimeout(queue.leaveTimeout);
    queue.leaveTimeout = null;
  }

  if (queue.songs.length === 0) {
    queue.playing = false;
    // Auto-leave after 5 minutes of inactivity
    queue.leaveTimeout = setTimeout(() => destroyQueue(guildId), 5 * 60 * 1000);
    return;
  }

  const nextSong = queue.songs.shift();

  if (!nextSong || !nextSong.url) {
    console.warn('Skipping a queued track with no playable URL:', nextSong);
    queue.textChannel?.send(`⚠️ Skipped **${nextSong?.title || 'a track'}** — no playable source found.`).catch(() => {});
    playNext(guildId);
    return;
  }

  queue.current = nextSong;
  queue.playing = true;

  try {
    const streamInfo = await play.stream(nextSong.url);
    const resource = createAudioResource(streamInfo.stream, {
      inputType: streamInfo.type,
      inlineVolume: true,
    });
    queue.player.play(resource);
    queue.textChannel?.send(`🎶 Now playing: **${nextSong.title}**`).catch(() => {});
  } catch (err) {
    console.error('Error starting stream:', err);
    queue.textChannel?.send(`⚠️ Couldn't play **${nextSong.title}**, skipping.`).catch(() => {});
    playNext(guildId);
  }
}

function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.songs = [];
  queue.current = null;
  try {
    queue.player.stop(true);
  } catch {}
  try {
    queue.connection.destroy();
  } catch {}
  queues.delete(guildId);
}

module.exports = { queues, getQueue, createQueue, playNext, destroyQueue };
