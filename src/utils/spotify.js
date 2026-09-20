
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MAX_PLAYLIST_TRACKS = 500;
const MAX_ALBUM_TRACKS = 500;

// Token file is stored in the project root.
const TOKEN_FILE = path.join(__dirname, '../../spotify-token.json');

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Reads the saved Spotify OAuth token.
 */
function loadSavedToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');

    return JSON.parse(raw);
  } catch (error) {
    console.error('Failed to read Spotify token file:', error);
    return null;
  }
}

/**
 * Saves Spotify OAuth token data.
 */
function saveToken(tokenData) {
  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify(tokenData, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Failed to save Spotify token:', error);
  }
}

/**
 * Gets a Spotify OAuth access token.
 *
 * The first time this runs, spotify-auth.js must have been
 * executed to authorize the Spotify account.
 *
 * After that, the refresh token is automatically used whenever
 * the access token expires.
 */
async function getAccessToken() {
  // Use cached access token if it hasn't expired.
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const { clientId, clientSecret } = config.spotify;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env file.'
    );
  }

  const savedToken = loadSavedToken();

  if (!savedToken || !savedToken.refresh_token) {
    throw new Error(
      'Spotify is not authorized yet. Run: node src/utils/spotify-auth.js'
    );
  }

  const basic = Buffer
    .from(`${clientId}:${clientSecret}`)
    .toString('base64');

  const res = await fetch(
    'https://accounts.spotify.com/api/token',
    {
      method: 'POST',

      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },

      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: savedToken.refresh_token,
      }).toString(),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();

    throw new Error(
      `Spotify token refresh failed (${res.status}): ${errorText}`
    );
  }

  const data = await res.json();

  cachedToken = data.access_token;

  /*
   * Refresh one minute before expiration.
   */
  tokenExpiry =
    Date.now() +
    Math.max((data.expires_in || 3600) - 60, 60) * 1000;

  /*
   * Spotify may return a new refresh token.
   * If it doesn't, keep the old one.
   */
  const updatedToken = {
    ...savedToken,
    access_token: data.access_token,
    expires_in: data.expires_in,
    token_type: data.token_type,
    scope: data.scope || savedToken.scope,
    obtained_at: Date.now(),
  };

  if (data.refresh_token) {
    updatedToken.refresh_token = data.refresh_token;
  }

  saveToken(updatedToken);

  return cachedToken;
}

/**
 * Makes an authenticated Spotify API request.
 */
async function spotifyFetch(endpoint) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://api.spotify.com/v1${endpoint}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!res.ok) {
    const errorText = await res.text();

    if (res.status === 404) {
      throw new Error(
        `Spotify returned 404 for ${endpoint}. This usually means it's one of Spotify's own algorithmic or ` +
        `editorial playlists (Discover Weekly, Daily Mix, Release Radar, official charts, etc.) — Spotify removed ` +
        `API access to those entirely, for every app, regardless of authorization. Regular user-created or ` +
        `followed playlists aren't affected. If this is a personal playlist, double-check the link is correct.`
      );
    }

    if (res.status === 403) {
      throw new Error(
        `Spotify API returned 403 for ${endpoint}. ` +
        `The authenticated Spotify account must own or collaborate on this playlist. ` +
        `Spotify response: ${errorText}`
      );
    }

    if (res.status === 401) {
      /*
       * The refresh token may have expired/revoked.
       */
      cachedToken = null;
      tokenExpiry = 0;

      throw new Error(
        'Spotify authorization expired or was revoked. ' +
        'Run: node src/utils/spotify-auth.js'
      );
    }

    throw new Error(
      `Spotify API error (${res.status}) for ${endpoint}: ${errorText}`
    );
  }

  return res.json();
}

/**
 * Parses a Spotify URL.
 *
 * Supported:
 * - track
 * - album
 * - playlist
 */
function parseSpotifyUrl(url) {
  const match = url.match(
    /open\.spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/
  );

  if (!match) {
    return null;
  }

  return {
    type: match[1],
    id: match[2],
  };
}

/**
 * Gets information for a single Spotify track.
 */
async function getSpotifyTrackInfo(id) {
  const data = await spotifyFetch(`/tracks/${id}`);

  return [
    {
      title: data.name,

      artists: data.artists
        .map((artist) => artist.name)
        .join(', '),
    },
  ];
}

/**
 * Gets all tracks from a Spotify album.
 *
 * Spotify currently allows a maximum of 50 items per request,
 * so this function paginates until there are no more tracks
 * or MAX_ALBUM_TRACKS is reached.
 */
async function getSpotifyAlbumTrackInfos(id) {
  const tracks = [];

  let offset = 0;

  const limit = 50;

  while (tracks.length < MAX_ALBUM_TRACKS) {
    const remaining =
      MAX_ALBUM_TRACKS - tracks.length;

    const requestLimit = Math.min(
      limit,
      remaining
    );

    const data = await spotifyFetch(
      `/albums/${id}/tracks?limit=${requestLimit}&offset=${offset}`
    );

    if (!data.items || data.items.length === 0) {
      break;
    }

    const pageTracks = data.items
      .filter((track) => track)
      .map((track) => ({
        title: track.name,

        artists: track.artists
          .map((artist) => artist.name)
          .join(', '),
      }));

    tracks.push(...pageTracks);

    if (!data.next) {
      break;
    }

    offset += data.items.length;
  }

  return tracks;
}

/**
 * Gets all tracks from a Spotify playlist.
 *
 * IMPORTANT:
 * Spotify changed the endpoint from:
 *
 * /playlists/{id}/tracks
 *
 * to:
 *
 * /playlists/{id}/items
 *
 * The current endpoint allows a maximum of 50 items per request.
 *
 * We paginate until:
 *
 * - Spotify has no more items
 * - MAX_PLAYLIST_TRACKS is reached
 */
async function getSpotifyPlaylistTrackInfos(id) {
  const tracks = [];

  let offset = 0;

  const limit = 50;

  while (tracks.length < MAX_PLAYLIST_TRACKS) {
    const remaining =
      MAX_PLAYLIST_TRACKS - tracks.length;

    const requestLimit = Math.min(
      limit,
      remaining
    );

    const data = await spotifyFetch(
      `/playlists/${id}/items?limit=${requestLimit}&offset=${offset}`
    );

    if (!data.items || data.items.length === 0) {
      break;
    }

    const pageTracks = data.items
      .filter((item) => {
        /*
         * Only accept actual Spotify tracks.
         *
         * Playlists can contain episodes or unavailable items.
         */
        return (
          item &&
          item.item &&
          item.item.type === 'track'
        );
      })
      .map((item) => ({
        title: item.item.name,

        artists: item.item.artists
          .map((artist) => artist.name)
          .join(', '),
      }));

    tracks.push(...pageTracks);

    if (!data.next) {
      break;
    }

    offset += data.items.length;
  }

  return tracks;
}

/**
 * Fisher-Yates shuffle.
 *
 * Returns a new array and does not modify the original.
 */
function shuffleTracks(tracks) {
  const shuffled = [...tracks];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [shuffled[i], shuffled[j]] = [
      shuffled[j],
      shuffled[i],
    ];
  }

  return shuffled;
}

/**
 * Shuffles everything after the currently playing track.
 *
 * Example:
 *
 * [
 *   Current Song,
 *   Song A,
 *   Song B,
 *   Song C
 * ]
 *
 * becomes:
 *
 * [
 *   Current Song,
 *   Song C,
 *   Song A,
 *   Song B
 * ]
 */
function shuffleRemainingTracks(tracks) {
  if (
    !Array.isArray(tracks) ||
    tracks.length <= 1
  ) {
    return [...tracks];
  }

  const currentTrack = tracks[0];

  const remainingTracks = tracks.slice(1);

  const shuffledRemaining =
    shuffleTracks(remainingTracks);

  return [
    currentTrack,
    ...shuffledRemaining,
  ];
}

module.exports = {
  parseSpotifyUrl,

  getSpotifyTrackInfo,

  getSpotifyAlbumTrackInfos,

  getSpotifyPlaylistTrackInfos,

  shuffleTracks,

  shuffleRemainingTracks,

  MAX_PLAYLIST_TRACKS,

  MAX_ALBUM_TRACKS,
};
