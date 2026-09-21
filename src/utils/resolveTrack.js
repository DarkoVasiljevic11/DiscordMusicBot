const play = require('@iamtraction/play-dl');
const ytSearch = require('yt-search');
const {
  parseSpotifyUrl,
  getSpotifyTrackInfo,
  getSpotifyAlbumTrackInfos,
  getSpotifyPlaylistTrackInfos,
} = require('./spotify');

// How many YouTube searches run at once when resolving a big Spotify
// playlist/album. Higher = faster, but more likely to hit rate limits.
const SPOTIFY_SEARCH_CONCURRENCY = 4;

function detectSource(query) {
  if (/open\.spotify\.com\/(track|album|playlist)\//i.test(query)) return 'spotify';
  if (/soundcloud\.com\//i.test(query)) return 'soundcloud';
  if (/(youtube\.com|youtu\.be)\//i.test(query)) return 'youtube';
  return 'search';
}

async function findYoutubeMatch(title, artists) {
  const searchTerm = artists ? `${artists} - ${title}` : title;

  try {
    const result = await ytSearch(searchTerm);

    if (!result || !result.videos || result.videos.length === 0) {
      console.log(`No YouTube result found for: ${searchTerm}`);
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
    console.error(`YouTube search failed for: ${searchTerm}`, error);
    return null;
  }
}

/**
 * Resolves a query (a YouTube/Spotify/SoundCloud URL, or plain search text)
 * into one or more playable track objects.
 *
 * @param {string} query
 * @param {string} requestedBy
 * @param {object} [options]
 * @param {(tracks: object[]) => void} [options.onBatch] Called as tracks
 *   become available, so callers can start playback and update progress
 *   before the whole query (e.g. a 500-track Spotify playlist) has finished
 *   resolving. Always called at least once for a successful resolution.
 * @param {(total: number) => void} [options.onStart] Called once the total
 *   number of tracks to resolve is known (useful for progress messages).
 * @returns {Promise<object[]>} every track that was resolved, in order.
 */
async function resolveQuery(query, requestedBy, { onBatch, onStart } = {}) {
  const source = detectSource(query);
  const emit = (tracks) => {
    if (onBatch && tracks.length > 0) onBatch(tracks);
  };

  // --- Spotify: fetch real metadata, then find + stream matching YouTube audio ---
  if (source === 'spotify') {
    const parsed = parseSpotifyUrl(query);
    if (!parsed) throw new Error('Could not parse that Spotify link.');

    let infos;
    if (parsed.type === 'track') infos = await getSpotifyTrackInfo(parsed.id);
    else if (parsed.type === 'album') infos = await getSpotifyAlbumTrackInfos(parsed.id);
    else infos = await getSpotifyPlaylistTrackInfos(parsed.id);

    if (onStart) onStart(infos.length);

    const allTracks = [];
    // Resolve in small concurrent chunks (rather than one-at-a-time) so large
    // playlists don't take forever, and emit each chunk as soon as it's ready
    // so playback can start almost immediately instead of waiting on everything.
    for (let i = 0; i < infos.length; i += SPOTIFY_SEARCH_CONCURRENCY) {
      const chunk = infos.slice(i, i + SPOTIFY_SEARCH_CONCURRENCY);
      const matches = await Promise.all(
        chunk.map((info) => findYoutubeMatch(info.title, info.artists))
      );

      const chunkTracks = matches
        .map((match, idx) => {
          if (!match) return null;
          const info = chunk[idx];
          return {
            title: `${info.title} - ${info.artists}`,
            url: match.url,
            duration: match.durationRaw,
            source: 'spotify',
            requestedBy,
          };
        })
        .filter(Boolean);

      allTracks.push(...chunkTracks);
      emit(chunkTracks);
    }

    if (allTracks.length === 0) {
      throw new Error('Could not find a playable match on YouTube for that Spotify content.');
    }
    return allTracks;
  }

  // --- SoundCloud ---
  if (source === 'soundcloud') {
    const info = await play.soundcloud(query);

    if (info.type === 'playlist') {
      const tracksData = await info.all_tracks();
      const tracks = tracksData
        .filter((t) => t && t.url)
        .map((t) => ({
          title: t.name,
          url: t.url,
          duration: t.durationInSec,
          source: 'soundcloud',
          requestedBy,
        }));
      if (onStart) onStart(tracks.length);
      emit(tracks);
      return tracks;
    }

    if (!info.url) throw new Error('That SoundCloud track is not playable (no stream URL returned).');
    const track = {
      title: info.name,
      url: info.url,
      duration: info.durationInSec,
      source: 'soundcloud',
      requestedBy,
    };
    if (onStart) onStart(1);
    emit([track]);
    return [track];
  }

  // --- YouTube link (video or playlist) ---
  if (source === 'youtube') {
    const type = await play.validate(query);
    if (type === 'yt_playlist') {
      const playlist = await play.playlist_info(query, { incomplete: true });
      const videos = await playlist.all_videos();
      const tracks = videos
        .filter((v) => v && v.url)
        .map((v) => ({
          title: v.title,
          url: v.url,
          duration: v.durationRaw,
          source: 'youtube',
          requestedBy,
        }));
      if (onStart) onStart(tracks.length);
      emit(tracks);
      return tracks;
    }

    const info = await play.video_basic_info(query);
    const details = info.video_details;
    if (!details.url) throw new Error('That YouTube video is not playable (no stream URL returned).');
    const track = {
      title: details.title,
      url: details.url,
      duration: details.durationRaw,
      source: 'youtube',
      requestedBy,
    };
    if (onStart) onStart(1);
    emit([track]);
    return [track];
  }

  // --- Plain text search -> default to YouTube ---
  const match = await findYoutubeMatch(query);
  if (!match) throw new Error('No results found.');
  const track = {
    title: match.title,
    url: match.url,
    duration: match.durationRaw,
    source: 'youtube',
    requestedBy,
  };
  if (onStart) onStart(1);
  emit([track]);
  return [track];
}

module.exports = { resolveQuery };
