
const play = require('@iamtraction/play-dl');
const ytSearch = require('yt-search');
const path = require('path');
const { spawn } = require('child_process');

const {
  parseSpotifyUrl,
  getSpotifyTrackInfo,
  getSpotifyAlbumTrackInfos,
  getSpotifyPlaylistTrackInfos,
} = require('./spotify');

// How many YouTube searches run at once when resolving a big Spotify
// playlist/album. Higher = faster, but more likely to hit rate limits.
const SPOTIFY_SEARCH_CONCURRENCY = 4;

// yt-dlp executable.
// We keep it in the root of the Discord bot project.
const YTDLP_PATH = path.join(
  __dirname,
  '../../yt-dlp.exe'
);

function detectSource(query) {
  if (
    /open\.spotify\.com\/(track|album|playlist)\//i.test(
      query
    )
  ) {
    return 'spotify';
  }

  if (/soundcloud\.com\//i.test(query)) {
    return 'soundcloud';
  }

  if (
    /(youtube\.com|youtu\.be)\//i.test(query)
  ) {
    return 'youtube';
  }

  return 'search';
}

// ============================================================
// YOUTUBE SEARCH
// ============================================================

async function findYoutubeMatch(title, artists) {
  const searchTerm = artists
    ? `${artists} - ${title}`
    : title;

  try {
    const result = await ytSearch(searchTerm);

    if (
      !result ||
      !result.videos ||
      result.videos.length === 0
    ) {
      console.log(
        `No YouTube result found for: ${searchTerm}`
      );

      return null;
    }

    const video = result.videos[0];

    return {
      title: video.title,
      url: video.url,
      durationRaw: video.timestamp,
      durationInSec: video.seconds,
    };
  } catch (error) {
    console.error(
      `YouTube search failed for: ${searchTerm}`,
      error
    );

    return null;
  }
}

// ============================================================
// YT-DLP PLAYLIST EXTRACTION
// ============================================================

function getYoutubePlaylistVideos(query) {
  return new Promise((resolve, reject) => {
    console.log(
      `Reading YouTube playlist with yt-dlp...`
    );

    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--ignore-errors',
      query,
    ];

    const process = spawn(YTDLP_PATH, args, {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            'yt-dlp.exe was not found. Put yt-dlp.exe in the root folder of your Discord bot.'
          )
        );
      } else {
        reject(error);
      }
    });

    process.on('close', (code) => {
      if (!stdout.trim()) {
        console.error(
          'yt-dlp stderr:',
          stderr
        );

        reject(
          new Error(
            `yt-dlp could not read the YouTube playlist. Exit code: ${code}`
          )
        );

        return;
      }

      try {
        const data = JSON.parse(stdout);

        if (
          !data ||
          !Array.isArray(data.entries)
        ) {
          reject(
            new Error(
              'yt-dlp returned no playlist entries.'
            )
          );

          return;
        }

        const videos = data.entries
          .filter((entry) => {
            return (
              entry &&
              entry.id
            );
          })
          .map((entry) => {
            const url =
              entry.url &&
              /^https?:\/\//i.test(entry.url)
                ? entry.url
                : `https://www.youtube.com/watch?v=${entry.id}`;

            return {
              id: entry.id,
              title:
                entry.title ||
                `YouTube video ${entry.id}`,
              url,
              duration:
                entry.duration_string ||
                null,
            };
          });

        resolve(videos);
      } catch (error) {
        console.error(
          'Could not parse yt-dlp output:',
          error
        );

        console.error(
          'yt-dlp output:',
          stdout.substring(0, 2000)
        );

        reject(
          new Error(
            'yt-dlp returned invalid playlist data.'
          )
        );
      }
    });
  });
}

// ============================================================
// MAIN QUERY RESOLVER
// ============================================================

/**
 * Resolves a query (a YouTube/Spotify/SoundCloud URL,
 * or plain search text) into one or more playable track objects.
 *
 * @param {string} query
 * @param {string} requestedBy
 * @param {object} [options]
 * @param {(tracks: object[]) => void} [options.onBatch]
 * @param {(total: number) => void} [options.onStart]
 * @returns {Promise<object[]>}
 */

async function resolveQuery(
  query,
  requestedBy,
  { onBatch, onStart } = {}
) {
  const source = detectSource(query);

  const emit = (tracks) => {
    if (
      onBatch &&
      tracks &&
      tracks.length > 0
    ) {
      onBatch(tracks);
    }
  };

  // ==========================================================
  // SPOTIFY
  // ==========================================================

  if (source === 'spotify') {
    const parsed = parseSpotifyUrl(query);

    if (!parsed) {
      throw new Error(
        'Could not parse that Spotify link.'
      );
    }

    let infos;

    if (parsed.type === 'track') {
      infos =
        await getSpotifyTrackInfo(
          parsed.id
        );
    } else if (
      parsed.type === 'album'
    ) {
      infos =
        await getSpotifyAlbumTrackInfos(
          parsed.id
        );
    } else {
      infos =
        await getSpotifyPlaylistTrackInfos(
          parsed.id
        );
    }

    if (onStart) {
      onStart(infos.length);
    }

    const allTracks = [];

    // Resolve Spotify tracks in small
    // concurrent chunks.
    for (
      let i = 0;
      i < infos.length;
      i += SPOTIFY_SEARCH_CONCURRENCY
    ) {
      const chunk = infos.slice(
        i,
        i + SPOTIFY_SEARCH_CONCURRENCY
      );

      const matches =
        await Promise.all(
          chunk.map((info) =>
            findYoutubeMatch(
              info.title,
              info.artists
            )
          )
        );

      const chunkTracks =
        matches
          .map((match, idx) => {
            if (!match) {
              return null;
            }

            const info = chunk[idx];

            return {
              title: `${info.title} - ${info.artists}`,
              url: match.url,
              duration:
                match.durationRaw,
              source: 'spotify',
              requestedBy,
            };
          })
          .filter(Boolean);

      allTracks.push(
        ...chunkTracks
      );

      emit(chunkTracks);
    }

    if (allTracks.length === 0) {
      throw new Error(
        'Could not find a playable match on YouTube for that Spotify content.'
      );
    }

    return allTracks;
  }

  // ==========================================================
  // SOUNDCLOUD
  // ==========================================================

  if (source === 'soundcloud') {
    const info =
      await play.soundcloud(query);

    // SoundCloud playlist
    if (info.type === 'playlist') {
      const tracksData =
        await info.all_tracks();

      const tracks =
        tracksData
          .filter(
            (t) =>
              t &&
              t.url
          )
          .map((t) => ({
            title: t.name,
            url: t.url,
            duration:
              t.durationInSec,
            source: 'soundcloud',
            requestedBy,
          }));

      if (onStart) {
        onStart(tracks.length);
      }

      emit(tracks);

      return tracks;
    }

    // SoundCloud single track
    if (!info.url) {
      throw new Error(
        'That SoundCloud track is not playable (no stream URL returned).'
      );
    }

    const track = {
      title: info.name,
      url: info.url,
      duration: info.durationInSec,
      source: 'soundcloud',
      requestedBy,
    };

    if (onStart) {
      onStart(1);
    }

    emit([track]);

    return [track];
  }

  // ==========================================================
  // YOUTUBE
  // ==========================================================

  if (source === 'youtube') {
    let type;

    try {
      type =
        await play.validate(query);
    } catch (error) {
      console.error(
        'YouTube URL validation failed:',
        error
      );

      throw new Error(
        'Could not validate that YouTube URL.'
      );
    }

    // ========================================================
    // YOUTUBE PLAYLIST
    //
    // IMPORTANT:
    // We DO NOT use play.playlist_info().
    //
    // play-dl is currently failing inside its playlist parser
    // with:
    //
    // Cannot read properties of undefined (reading 'contents')
    //
    // Instead, yt-dlp gets the playlist entries.
    // ========================================================

    if (type === 'yt_playlist') {
      console.log(
        'YouTube playlist detected.'
      );

      let videos;

      try {
        videos =
          await getYoutubePlaylistVideos(
            query
          );
      } catch (error) {
        console.error(
          'YouTube playlist extraction failed:',
          error
        );

        throw error;
      }

      if (
        !videos ||
        videos.length === 0
      ) {
        throw new Error(
          'This YouTube playlist contains no playable videos.'
        );
      }

      console.log(
        `Found ${videos.length} videos in the YouTube playlist.`
      );

      const tracks =
        videos
          .filter(
            (video) =>
              video &&
              video.url
          )
          .map((video) => ({
            title: video.title,
            url: video.url,
            duration:
              video.duration,
            source: 'youtube',
            requestedBy,
          }));

      if (tracks.length === 0) {
        throw new Error(
          'No playable videos were found in this YouTube playlist.'
        );
      }

      if (onStart) {
        onStart(tracks.length);
      }

      emit(tracks);

      return tracks;
    }

    // ========================================================
    // YOUTUBE SINGLE VIDEO
    // ========================================================

    let info;

    try {
      info =
        await play.video_basic_info(
          query
        );
    } catch (error) {
      console.error(
        'YouTube video_basic_info() failed:',
        error
      );

      throw new Error(
        'Could not retrieve information for that YouTube video.'
      );
    }

    const details =
      info.video_details;

    if (
      !details ||
      !details.url
    ) {
      throw new Error(
        'That YouTube video is not playable (no stream URL returned).'
      );
    }

    const track = {
      title: details.title,
      url: details.url,
      duration: details.durationRaw,
      source: 'youtube',
      requestedBy,
    };

    if (onStart) {
      onStart(1);
    }

    emit([track]);

    return [track];
  }

  // ==========================================================
  // PLAIN TEXT SEARCH -> YOUTUBE
  // ==========================================================

  const match =
    await findYoutubeMatch(query);

  if (!match) {
    throw new Error(
      'No results found.'
    );
  }

  const track = {
    title: match.title,
    url: match.url,
    duration: match.durationRaw,
    source: 'youtube',
    requestedBy,
  };

  if (onStart) {
    onStart(1);
  }

  emit([track]);

  return [track];
}

module.exports = {
  resolveQuery,
};
