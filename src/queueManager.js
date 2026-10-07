const {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  StreamType,
  entersState,
} = require('@discordjs/voice');

const play = require('@iamtraction/play-dl');
const GuildQueue = require('./structures/Queue');

const path = require('path');
const { spawn } = require('child_process');

const queues = new Map();

// ============================================================
// EXECUTABLES
// ============================================================

// queueManager.js is inside /src
// yt-dlp.exe is in the project root.

const YTDLP_PATH = path.join(
  __dirname,
  '../yt-dlp.exe'
);

// FFmpeg must be installed and available in PATH.
//
// You can also set:
//   FFMPEG_PATH=C:\path\to\ffmpeg.exe
//
// if ffmpeg is not in PATH.

const FFMPEG_PATH =
  process.env.FFMPEG_PATH || 'ffmpeg';

// ============================================================
// SETTINGS
// ============================================================

const MAX_STREAM_RETRIES = 3;

const STREAM_START_TIMEOUT_MS = 20_000;

const STALL_CHECK_INTERVAL_MS = 10_000;

const STALLED_AFTER_CHECKS = 2;

// ============================================================
// QUEUE ACCESS
// ============================================================

function getQueue(guildId) {
  return queues.get(guildId);
}

// ============================================================
// DURATION HELPERS
// ============================================================

function durationToSeconds(duration) {
  if (typeof duration === 'number') {
    return duration;
  }

  if (typeof duration !== 'string') {
    return null;
  }

  const parts =
    duration.split(':').map(Number);

  if (
    parts.some(
      Number.isNaN
    )
  ) {
    return null;
  }

  return parts.reduce(
    (total, part) =>
      total * 60 + part,
    0
  );
}

// ============================================================
// CREATE QUEUE
// ============================================================

async function createQueue(
  guildId,
  { textChannel, voiceChannel }
) {
  const connection =
    joinVoiceChannel({
      channelId:
        voiceChannel.id,

      guildId,

      adapterCreator:
        voiceChannel.guild
          .voiceAdapterCreator,
    });

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      20_000
    );
  } catch (err) {
    connection.destroy();

    throw new Error(
      "Couldn't establish a voice connection (timed out waiting to become ready). This is usually caused by a firewall, VPN, or network blocking Discord's voice (UDP) traffic."
    );
  }

  const player =
    createAudioPlayer();

  connection.subscribe(player);

  const queue =
    new GuildQueue({
      guildId,
      textChannel,
      voiceChannel,
      connection,
      player,
    });

  queues.set(
    guildId,
    queue
  );

  // ==========================================================
  // AUDIO PLAYER IDLE
  // ==========================================================

  player.on(
    AudioPlayerStatus.Idle,
    () => {
      if (queue.retryPending) {
        queue.retryPending = false;
        return;
      }

      const wasSkipped =
        queue.skipFlag;

      queue.skipFlag = false;

      if (
        queue.current &&
        !wasSkipped
      ) {
        const expectedSec =
          durationToSeconds(
            queue.current.duration
          );

        const actualSec =
          queue.current.startedAt
            ? (
                Date.now() -
                queue.current.startedAt
              ) / 1000
            : null;

        // A stream ended significantly before
        // its expected duration.
        //
        // This is NOT a duration limit.
        // It only detects premature stream termination.

        if (
          expectedSec &&
          actualSec &&
          expectedSec > 15 &&
          actualSec <
            expectedSec * 0.9
        ) {
          handleStreamFailure(
            guildId,
            new Error(
              'Track ended early with no error event — retrying'
            )
          );

          return;
        }
      }

      if (
        queue.loop &&
        queue.current &&
        !wasSkipped
      ) {
        queue.songs.unshift(
          queue.current
        );
      }

      cleanupTrackProcesses(
        queue.current
      );

      queue.current = null;

      playNext(guildId);
    }
  );

  // ==========================================================
  // AUDIO PLAYER ERROR
  // ==========================================================

  player.on(
    'error',
    (error) => {
      handleStreamFailure(
        guildId,
        error
      );
    }
  );

  // ==========================================================
  // VOICE CONNECTION RECOVERY
  // ==========================================================

  connection.on(
    VoiceConnectionStatus.Disconnected,
    async (
      _oldState,
      newState
    ) => {
      if (
        newState.reason ===
          VoiceConnectionDisconnectReason.WebSocketClose &&
        newState.closeCode === 4014
      ) {
        try {
          await entersState(
            connection,
            VoiceConnectionStatus.Connecting,
            5_000
          );
        } catch {
          queue.textChannel
            ?.send(
              '⚠️ Lost the voice connection and could not recover. Leaving the channel.'
            )
            .catch(() => {});

          destroyQueue(guildId);
        }
      } else if (
        connection.rejoinAttempts < 5
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              (
                connection.rejoinAttempts +
                1
              ) * 5_000
            )
        );

        try {
          connection.rejoin();
        } catch {
          queue.textChannel
            ?.send(
              '⚠️ Lost the voice connection and could not recover. Leaving the channel.'
            )
            .catch(() => {});

          destroyQueue(guildId);
        }
      } else {
        queue.textChannel
          ?.send(
            '⚠️ Lost the voice connection after several retries. Leaving the channel.'
          )
          .catch(() => {});

        destroyQueue(guildId);
      }
    }
  );

  return queue;
}

// ============================================================
// CLEANUP STREAM PROCESSES
// ============================================================

function cleanupTrackProcesses(track) {
  if (!track) {
    return;
  }

  if (track.ffmpegProcess) {
    try {
      track.ffmpegProcess.kill();
    } catch {}

    track.ffmpegProcess = null;
  }

  if (track.ytDlpProcess) {
    try {
      track.ytDlpProcess.kill();
    } catch {}

    track.ytDlpProcess = null;
  }

  track.resource = null;
}

// ============================================================
// GET DIRECT AUDIO URL WITH YT-DLP
// ============================================================

function getYtDlpAudioUrl(
  url,
  track
) {
  return new Promise(
    (resolve, reject) => {
      const args = [
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '-f',
        'bestaudio/best',
        '-g',
        url,
      ];

      console.log(
        `Getting fresh yt-dlp audio URL for "${url}"`
      );

      const process =
        spawn(
          YTDLP_PATH,
          args,
          {
            windowsHide: true,
            stdio: [
              'ignore',
              'pipe',
              'pipe',
            ],
          }
        );

      if (track) {
        track.ytDlpProcess =
          process;
      }

      let stdout = '';
      let stderr = '';

      process.stdout.on(
        'data',
        (data) => {
          stdout +=
            data.toString();
        }
      );

      process.stderr.on(
        'data',
        (data) => {
          stderr +=
            data.toString();
        }
      );

      process.on(
        'error',
        (error) => {
          if (
            track &&
            track.ytDlpProcess ===
              process
          ) {
            track.ytDlpProcess =
              null;
          }

          if (
            error.code ===
            'ENOENT'
          ) {
            reject(
              new Error(
                'yt-dlp.exe was not found in the bot root directory.'
              )
            );
          } else {
            reject(error);
          }
        }
      );

      process.on(
        'close',
        (code) => {
          if (
            track &&
            track.ytDlpProcess ===
              process
          ) {
            track.ytDlpProcess =
              null;
          }

          if (
            code !== 0
          ) {
            reject(
              new Error(
                `yt-dlp failed while getting the audio URL (exit code ${code}): ${
                  stderr.trim() ||
                  'unknown error'
                }`
              )
            );

            return;
          }

          const directUrl =
            stdout
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .pop();

          if (!directUrl) {
            reject(
              new Error(
                'yt-dlp returned no audio URL.'
              )
            );

            return;
          }

          resolve(
            directUrl
          );
        }
      );
    }
  );
}

// ============================================================
// START FFMPEG FOR LONG VIDEO
// ============================================================

async function startLongVideoStream(
  track
) {
  // Get a fresh YouTube CDN URL.
  //
  // This is intentionally done every time the
  // long-video stream starts/restarts because
  // CDN URLs can expire.

  const directUrl =
    await getYtDlpAudioUrl(
      track.url,
      track
    );

  const seek =
    Math.max(
      0,
      Math.floor(
        track.seekOffset || 0
      )
    );

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',

    // Reconnect support for HTTP streams.
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '10',
  ];

  // Resume approximately where the
  // previous attempt stopped.

  if (seek > 0) {
    args.push(
      '-ss',
      String(seek)
    );
  }

  args.push(
    '-i',
    directUrl,

    // Audio only.
    '-vn',

    // Discord-compatible raw PCM.
    '-f',
    's16le',

    '-ar',
    '48000',

    '-ac',
    '2',

    'pipe:1'
  );

  console.log(
    `Starting FFmpeg long-video stream for "${track.title}"${
      seek > 0
        ? ` from ${seek}s`
        : ''
    }`
  );

  const ffmpeg =
    spawn(
      FFMPEG_PATH,
      args,
      {
        windowsHide: true,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      }
    );

  track.ffmpegProcess =
    ffmpeg;

  let stderr = '';

  ffmpeg.stderr.on(
    'data',
    (data) => {
      stderr +=
        data.toString();
    }
  );

  ffmpeg.on(
    'error',
    (error) => {
      if (
        track.ffmpegProcess ===
          ffmpeg
      ) {
        track.ffmpegProcess =
          null;
      }

      console.error(
        'FFmpeg error:',
        error
      );
    }
  );

  ffmpeg.on(
    'close',
    (code) => {
      if (
        track.ffmpegProcess ===
          ffmpeg
      ) {
        track.ffmpegProcess =
          null;
      }

      if (
        code !== 0 &&
        code !== null &&
        stderr.trim()
      ) {
        console.error(
          `FFmpeg exited with code ${code}:`,
          stderr.trim()
        );
      }
    }
  );

  return {
    stream: ffmpeg.stdout,
    process: ffmpeg,
  };
}

// ============================================================
// HANDLE STREAM FAILURE
// ============================================================

function handleStreamFailure(
  guildId,
  error
) {
  const queue =
    queues.get(guildId);

  if (
    !queue ||
    !queue.current
  ) {
    return;
  }

  if (
    queue.retryPending
  ) {
    return;
  }

  const track =
    queue.current;

  const elapsedThisAttempt =
    track.attemptStartedAt
      ? (
          Date.now() -
          track.attemptStartedAt
        ) / 1000
      : 0;

  const totalPlayed =
    (
      track.seekOffset || 0
    ) +
    elapsedThisAttempt;

  const expectedSec =
    durationToSeconds(
      track.duration
    );

  // If we're effectively at the end,
  // treat it as a normal completion.

  if (
    expectedSec &&
    totalPlayed >=
      expectedSec - 3
  ) {
    cleanupTrackProcesses(
      track
    );

    queue.current = null;

    playNext(guildId);

    return;
  }

  console.error(
    `Playback error on "${track.title}" (attempt ${
      (track.streamAttempt || 0) + 1
    }):`,
    error
  );

  const resumeFrom =
    Math.max(
      0,
      totalPlayed - 1
    );

  if (
    track.streamAttempt <
    MAX_STREAM_RETRIES
  ) {
    track.streamAttempt += 1;

    // For both normal and long mode,
    // remember approximately where we were.

    track.seekOffset =
      resumeFrom;

    queue.retryPending =
      true;

    cleanupTrackProcesses(
      track
    );

    if (
      track.streamAttempt ===
      1
    ) {
      queue.textChannel
        ?.send(
          `⚠️ Connection hiccup on **${track.title}**, resuming...`
        )
        .catch(() => {});
    }

    playCurrentTrack(
      guildId
    );
  } else {
    queue.textChannel
      ?.send(
        `⚠️ Couldn't recover **${track.title}** after ${MAX_STREAM_RETRIES} attempts, skipping.`
      )
      .catch(() => {});

    cleanupTrackProcesses(
      track
    );

    queue.current = null;

    playNext(guildId);
  }
}

// ============================================================
// PLAY CURRENT TRACK
// ============================================================

async function playCurrentTrack(
  guildId
) {
  const queue =
    queues.get(guildId);

  if (
    !queue ||
    !queue.current
  ) {
    return;
  }

  const track =
    queue.current;

  try {
    let stream;
    let inputType;

    // ========================================================
    // LONG MODE
    //
    // yt-dlp -> direct CDN URL
    // FFmpeg -> Discord-compatible PCM
    // ========================================================

    if (
      track.longMode
    ) {
      const result =
        await Promise.race([
          startLongVideoStream(
            track
          ),

          new Promise(
            (_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      'Timed out starting yt-dlp/FFmpeg stream.'
                    )
                  ),
                STREAM_START_TIMEOUT_MS
              )
          ),
        ]);

      stream =
        result.stream;

      inputType =
        StreamType.Raw;

      stream.on(
        'error',
        (err) => {
          handleStreamFailure(
            guildId,
            err
          );
        }
      );
    }

    // ========================================================
    // NORMAL MODE
    //
    // Existing play-dl behavior.
    // ========================================================

    else {
      const streamOptions =
        {};

      if (
        track.seekOffset >
        0
      ) {
        streamOptions.seek =
          Math.floor(
            track.seekOffset
          );
      }

      const streamInfo =
        await Promise.race([
          play.stream(
            track.url,
            streamOptions
          ),

          new Promise(
            (_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      'Timed out starting stream (play.stream took over 20s)'
                    )
                  ),
                STREAM_START_TIMEOUT_MS
              )
          ),
        ]);

      stream =
        streamInfo.stream;

      inputType =
        streamInfo.type;

      stream.on(
        'error',
        (err) => {
          handleStreamFailure(
            guildId,
            err
          );
        }
      );
    }

    // ========================================================
    // CREATE DISCORD AUDIO RESOURCE
    // ========================================================

    const resource =
      createAudioResource(
        stream,
        {
          inputType,
          inlineVolume: true,
        }
      );

    resource.volume?.setVolume(
      queue.volume
    );

    track.resource =
      resource;

    queue.player.play(
      resource
    );

    track.attemptStartedAt =
      Date.now();

    if (
      track.streamAttempt ===
      0
    ) {
      track.startedAt =
        Date.now();

      queue.textChannel
        ?.send(
          `🎶 Now playing: **${track.title}**`
        )
        .catch(() => {});
    }

    startStallWatchdog(
      guildId,
      track,
      resource
    );
  } catch (err) {
    console.error(
      'Error starting stream:',
      err
    );

    cleanupTrackProcesses(
      track
    );

    queue.textChannel
      ?.send(
        `⚠️ Couldn't play **${track.title}**, skipping.`
      )
      .catch(() => {});

    queue.current = null;

    playNext(guildId);
  }
}

// ============================================================
// STALL WATCHDOG
// ============================================================

function startStallWatchdog(
  guildId,
  track,
  resource
) {
  const queue =
    queues.get(guildId);

  if (!queue) {
    return;
  }

  if (
    queue.stallCheckInterval
  ) {
    clearInterval(
      queue.stallCheckInterval
    );
  }

  let lastPlaybackDuration =
    -1;

  let stalledChecks =
    0;

  queue.stallCheckInterval =
    setInterval(
      () => {
        if (
          !queue.current ||
          queue.current !==
            track
        ) {
          clearInterval(
            queue.stallCheckInterval
          );

          return;
        }

        if (
          queue.player.state
            .status ===
          AudioPlayerStatus.Paused
        ) {
          stalledChecks = 0;
          return;
        }

        const currentDuration =
          resource.playbackDuration;

        if (
          currentDuration ===
          lastPlaybackDuration
        ) {
          stalledChecks += 1;
        } else {
          stalledChecks = 0;
          lastPlaybackDuration =
            currentDuration;
        }

        if (
          stalledChecks >=
          STALLED_AFTER_CHECKS
        ) {
          clearInterval(
            queue.stallCheckInterval
          );

          console.warn(
            `Watchdog: "${track.title}" appears stalled (no playback progress for ~20s).`
          );

          handleStreamFailure(
            guildId,
            new Error(
              'Playback stalled — no audio progress detected'
            )
          );
        }
      },
      STALL_CHECK_INTERVAL_MS
    );
}

// ============================================================
// PLAY NEXT
// ============================================================

async function playNext(
  guildId
) {
  const queue =
    queues.get(guildId);

  if (!queue) {
    return;
  }

  if (
    queue.leaveTimeout
  ) {
    clearTimeout(
      queue.leaveTimeout
    );

    queue.leaveTimeout =
      null;
  }

  if (
    queue.songs.length ===
    0
  ) {
    queue.playing =
      false;

    queue.leaveTimeout =
      setTimeout(
        () =>
          destroyQueue(
            guildId
          ),
        5 * 60 * 1000
      );

    return;
  }

  const nextSong =
    queue.songs.shift();

  if (
    !nextSong ||
    !nextSong.url
  ) {
    console.warn(
      'Skipping a queued track with no playable URL:',
      nextSong
    );

    queue.textChannel
      ?.send(
        `⚠️ Skipped **${
          nextSong?.title ||
          'a track'
        }** — no playable source found.`
      )
      .catch(() => {});

    playNext(guildId);

    return;
  }

  nextSong.streamAttempt =
    0;

  nextSong.seekOffset =
    0;

  nextSong.attemptStartedAt =
    null;

  nextSong.startedAt =
    null;

  nextSong.resource =
    null;

  nextSong.ffmpegProcess =
    null;

  nextSong.ytDlpProcess =
    null;

  queue.current =
    nextSong;

  queue.playing =
    true;

  await playCurrentTrack(
    guildId
  );
}

// ============================================================
// DESTROY QUEUE
// ============================================================

function destroyQueue(
  guildId
) {
  const queue =
    queues.get(guildId);

  if (!queue) {
    return;
  }

  queue.songs = [];

  cleanupTrackProcesses(
    queue.current
  );

  queue.current =
    null;

  if (
    queue.stallCheckInterval
  ) {
    clearInterval(
      queue.stallCheckInterval
    );

    queue.stallCheckInterval =
      null;
  }

  try {
    queue.player.stop(
      true
    );
  } catch {}

  try {
    queue.connection.destroy();
  } catch {}

  queues.delete(
    guildId
  );
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  queues,
  getQueue,
  createQueue,
  playNext,
  destroyQueue,
  durationToSeconds,
};