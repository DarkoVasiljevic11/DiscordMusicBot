// ============================================================
// SPOTIFY PUBLIC PAGE READER
//
// Fallback for when the Spotify Web API can't read something. Spotify
// removed API access to its own algorithmic/editorial playlists (Discover
// Weekly, Daily Mix, "This Is ...", etc.) for every app, so the API answers
// 404 for those. The public embed page of a playlist still lists its
// songs, and the `spotify-url-info` package reads that page without any
// API key.
//
// Limits (all inherent to this approach):
//   - Only the first 100 tracks of a playlist/album are exposed.
//   - It depends on Spotify's page format, so it can break if Spotify
//     changes it (update `spotify-url-info` if that happens).
//   - Private playlists and personalised mixes may not be readable at all.
//
// Returns the same shape as ./spotify.js: [{ title, artists }].
// ============================================================

const createSpotifyUrlInfo = require('spotify-url-info');

// Per attempt. spotify-url-info retries a failed page fetch up to 3 times.
const FETCH_TIMEOUT_MS = 10_000;

// Spotify's embed page documents a hard cap of 100 tracks.
const EMBED_TRACK_LIMIT = 100;

const REQUEST_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

// spotify-url-info takes the fetch implementation as a parameter. This
// wrapper adds a fresh timeout to every attempt (a single shared signal
// would be used up by the first one) and turns HTTP errors into real
// errors, so a 404 page isn't mistaken for a page with no songs.
async function checkedFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Spotify's public page answered HTTP ${response.status}`
    );
  }

  return response;
}

const { getTracks } = createSpotifyUrlInfo(checkedFetch);

// Spotify separates artists with non-breaking spaces and the like.
function clean(value) {
  return String(value ?? '')
    .replace(/[\u00a0\u2000-\u200b]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {'track'|'album'|'playlist'} type
 * @param {string} id Spotify ID
 * @returns {Promise<{title: string, artists: string}[]>}
 */
async function getPublicSpotifyTrackInfos(type, id) {
  const url = `https://open.spotify.com/${type}/${id}`;

  const tracks = await getTracks(url, { headers: REQUEST_HEADERS });

  const infos = (Array.isArray(tracks) ? tracks : [])
    .map((track) => ({
      title: clean(track.name),
      artists: clean(track.artist),
    }))
    .filter((info) => info.title);

  if (infos.length === 0) {
    throw new Error(
      "Spotify's public page didn't list any songs (the playlist may be private or personalised)"
    );
  }

  if (type !== 'track' && infos.length >= EMBED_TRACK_LIMIT) {
    console.warn(
      `Spotify's public page only exposes the first ${EMBED_TRACK_LIMIT} tracks, so this ${type} may be longer than what was loaded.`
    );
  }

  return infos;
}

module.exports = {
  getPublicSpotifyTrackInfos,
  EMBED_TRACK_LIMIT,
};
