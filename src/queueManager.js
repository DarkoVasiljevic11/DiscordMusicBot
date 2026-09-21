const {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
} = require('@discordjs/voice');
const play = require('@iamtraction/play-dl');
const GuildQueue = require('./structures/Queue');

const queues = new Map();

// How many times to try resuming a track (via seek) after a mid-playback
// stream error (e.g. YouTube's CDN dropping the connection on longer videos)
// before giving up and moving on to the next song.
const MAX_STREAM_RETRIES = 3;

function getQueue(guildId) {
  return queues.get(guildId);
}

// Track durations come from different sources in different shapes: a
// formatted string like "3:45" (or "1:02:03") from YouTube, or a plain
// number of seconds from SoundCloud. Normalize both to seconds.
function durationToSeconds(duration) {
  if (typeof duration === 'number') return duration;
  if (typeof duration !== 'string') return null;
  const parts = duration.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
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
    // A retry-in-progress (see playCurrentTrack's error handling) causes its
    // own Idle transition as a side effect of restarting playback — that one
    // should NOT advance the queue, it's handled entirely by the retry logic.
    if (queue.retryPending) {
      queue.retryPending = false;
      return;
    }

    const wasSkipped = queue.skipFlag;
    queue.skipFlag = false;

    if (queue.current && !wasSkipped) {
      const expectedSec = durationToSeconds(queue.current.duration);
      const actualSec = queue.current.startedAt ? (Date.now() - queue.current.startedAt) / 1000 : null;

      // The stream sometimes ends cleanly — no 'error' event at all — well
      // before the track is actually done. This has been confirmed to happen
      // alongside the ERR_STREAM_PREMATURE_CLOSE cases, just without an
      // error being thrown, so it needs to go through the same retry-with-
      // seek logic rather than being silently treated as a normal finish.
      if (expectedSec && actualSec && expectedSec > 15 && actualSec < expectedSec * 0.9) {
        handleStreamFailure(guildId, new Error('Track ended early with no error event — retrying'));
        return;
      }
    }

    if (queue.loop && queue.current && !wasSkipped) {
      // Put the just-finished track back at the front so playNext replays it.
      queue.songs.unshift(queue.current);
    }

    queue.current = null;
    playNext(guildId);
  });

  player.on('error', (error) => {
    handleStreamFailure(guildId, error);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
    if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
      // Code 4014 covers two very different cases: the bot was moved to another
      // channel (recoverable, connection often heals itself), or the bot was
      // kicked/disconnected/lost channel permissions (not recoverable). Give it
      // a few seconds to see which one this is before giving up.
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        // Was moved channel — connection is recovering on its own.
      } catch {
        queue.textChannel?.send('⚠️ Lost the voice connection and could not recover. Leaving the channel.').catch(() => {});
        destroyQueue(guildId);
      }
    } else if (connection.rejoinAttempts < 5) {
      // A recoverable disconnect (brief network blip, Discord rebalancing the
      // voice server, etc.) — back off a little longer each time and retry.
      await new Promise((resolve) => setTimeout(resolve, (connection.rejoinAttempts + 1) * 5_000));
      try {
        connection.rejoin();
      } catch {
        queue.textChannel?.send('⚠️ Lost the voice connection and could not recover. Leaving the channel.').catch(() => {});
        destroyQueue(guildId);
      }
    } else {
      // Repeated failures — stop trying and clean up.
      queue.textChannel?.send('⚠️ Lost the voice connection after several retries. Leaving the channel.').catch(() => {});
      destroyQueue(guildId);
    }
  });

  return queue;
}

/**
 * Handles a mid-playback stream failure (network drop, premature close,
 * etc.) for whatever track is currently playing in this guild. Retries by
 * resuming from the elapsed position (via play-dl's `seek` option) up to
 * MAX_STREAM_RETRIES times before giving up and skipping to the next track.
 */
function handleStreamFailure(guildId, error) {
  const queue = queues.get(guildId);
  if (!queue || !queue.current) return;
  if (queue.retryPending) return; // a retry for this exact failure is already in flight

  const track = queue.current;
  const elapsedThisAttempt = track.attemptStartedAt ? (Date.now() - track.attemptStartedAt) / 1000 : 0;
  const totalPlayed = track.seekOffset + elapsedThisAttempt;
  const expectedSec = durationToSeconds(track.duration);

  // A stream 'error' firing right as a track reaches its natural end is a
  // known benign artifact (Node's pipeline can flag the teardown as a
  // "premature" close even though every byte was already delivered) — treat
  // that as a normal finish rather than a failure worth retrying/announcing.
  if (expectedSec && totalPlayed >= expectedSec - 3) {
    queue.current = null;
    playNext(guildId);
    return;
  }

  console.error(`Playback error on "${track.title}" (attempt ${track.streamAttempt + 1}):`, error);

  const resumeFrom = Math.max(0, totalPlayed - 1); // rewind 1s to avoid a tiny gap

  if (track.streamAttempt < MAX_STREAM_RETRIES) {
    track.streamAttempt += 1;
    track.seekOffset = resumeFrom;
    queue.retryPending = true; // suppress the Idle handler's normal advance-to-next-song logic
    if (track.streamAttempt === 1) {
      queue.textChannel?.send(`⚠️ Connection hiccup on **${track.title}**, resuming...`).catch(() => {});
    }
    playCurrentTrack(guildId);
  } else {
    queue.textChannel
      ?.send(`⚠️ Couldn't recover **${track.title}** after ${MAX_STREAM_RETRIES} attempts, skipping.`)
      .catch(() => {});
    queue.current = null;
    playNext(guildId);
  }
}

/**
 * Starts (or resumes, via track.seekOffset) streaming queue.current.
 */
async function playCurrentTrack(guildId) {
  const queue = queues.get(guildId);
  if (!queue || !queue.current) return;

  const track = queue.current;

  try {
    // NOTE: previously forced quality: 2 (highest bitrate) here, on the theory
    // that lower-quality formats under-report their length. That wasn't
    // actually the cause of tracks cutting short (a mid-download CDN drop
    // was — see handleStreamFailure), and forcing quality: 2 turned out to
    // make play.stream() hang indefinitely for at least one video instead of
    // resolving or rejecting. Left at the default (play-dl picks a sensible
    // format itself) and wrapped in a timeout so a hang can never go unnoticed.
    const streamOptions = {};
    if (track.seekOffset > 0) streamOptions.seek = Math.floor(track.seekOffset);

    const streamInfo = await Promise.race([
      play.stream(track.url, streamOptions),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out starting stream (play.stream took over 15s)')), 15_000)
      ),
    ]);

    // Confirmed by testing: a mid-download connection drop (e.g. YouTube's
    // CDN closing the connection on longer videos) surfaces here, on the raw
    // stream, as an 'error' event — NOT as the AudioPlayer's own 'error'
    // event. This is the listener that actually catches it.
    streamInfo.stream.on('error', (err) => {
      handleStreamFailure(guildId, err);
    });

    const resource = createAudioResource(streamInfo.stream, {
      inputType: streamInfo.type,
      inlineVolume: true,
    });
    resource.volume?.setVolume(queue.volume);
    track.resource = resource;

    queue.player.play(resource);
    track.attemptStartedAt = Date.now();
    if (track.streamAttempt === 0) {
      track.startedAt = Date.now(); // only for the "did this end early" diagnostic
      queue.textChannel?.send(`🎶 Now playing: **${track.title}**`).catch(() => {});
    }

    startStallWatchdog(guildId, track, resource);
  } catch (err) {
    console.error('Error starting stream:', err);
    queue.textChannel?.send(`⚠️ Couldn't play **${track.title}**, skipping.`).catch(() => {});
    queue.current = null;
    playNext(guildId);
  }
}

/**
 * Periodically checks that actual audio playback is still making progress.
 * A silent stall (no more data arrives, but also no 'error' and no natural
 * end) produces neither an error nor an Idle transition, so without this the
 * queue can get stuck on one track forever — blocking everything queued
 * after it — with nothing to indicate why. Long videos (an hour+) seem
 * especially prone to this on YouTube's end.
 */
function startStallWatchdog(guildId, track, resource) {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.stallCheckInterval) clearInterval(queue.stallCheckInterval);

  let lastPlaybackDuration = -1;
  let stalledChecks = 0;
  const CHECK_INTERVAL_MS = 10_000;
  const STALLED_AFTER_CHECKS = 2; // ~20s with zero progress

  queue.stallCheckInterval = setInterval(() => {
    // Track already moved on (finished, skipped, retried, queue destroyed) —
    // stop watching this one.
    if (!queue.current || queue.current !== track) {
      clearInterval(queue.stallCheckInterval);
      return;
    }
    // Don't flag an intentional /pause as a stall.
    if (queue.player.state.status === AudioPlayerStatus.Paused) {
      stalledChecks = 0;
      return;
    }

    const currentDuration = resource.playbackDuration;
    if (currentDuration === lastPlaybackDuration) {
      stalledChecks += 1;
    } else {
      stalledChecks = 0;
      lastPlaybackDuration = currentDuration;
    }

    if (stalledChecks >= STALLED_AFTER_CHECKS) {
      clearInterval(queue.stallCheckInterval);
      console.warn(`Watchdog: "${track.title}" appears stalled (no playback progress for ~20s).`);
      handleStreamFailure(guildId, new Error('Playback stalled — no audio progress detected'));
    }
  }, CHECK_INTERVAL_MS);
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

  nextSong.streamAttempt = 0;
  nextSong.seekOffset = 0;
  queue.current = nextSong;
  queue.playing = true;

  await playCurrentTrack(guildId);
}

function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.songs = [];
  queue.current = null;
  if (queue.stallCheckInterval) clearInterval(queue.stallCheckInterval);
  try {
    queue.player.stop(true);
  } catch {}
  try {
    queue.connection.destroy();
  } catch {}
  queues.delete(guildId);
}

module.exports = { queues, getQueue, createQueue, playNext, destroyQueue, durationToSeconds };
