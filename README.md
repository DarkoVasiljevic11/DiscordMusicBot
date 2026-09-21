 Discord Music Bot

A self-hosted Discord music bot built with Node.js and `discord.js` v14. Plays audio from **YouTube**, **Spotify**, and **SoundCloud** links or plain-text search, with a full queue system, pagination, shuffle, and repeat.

Built for personal/single-server use — no dashboard, no premium tiers, just a bot you run yourself.

Features

- 🎧 **Multi-source playback** — YouTube and SoundCloud stream directly; Spotify links (track/album/playlist) are resolved to real metadata via the Spotify Web API and matched to YouTube audio, since Spotify doesn't allow third-party apps to stream full tracks.
- 📃 **Full queue management** — add, skip, pause/resume, shuffle, remove a single song by position, or clear the whole queue.
- 🔁 **Repeat mode** — toggle looping the current song on/off.
- 📄 **Paginated `/queue` view** — browse long queues with ◀ Prev / Next ▶ buttons instead of one giant wall of text.
- ⚡ **Fast large-playlist loading** — Spotify playlists/albums (up to 500 tracks) resolve in concurrent batches and start playing as soon as the first few tracks are ready, instead of blocking until the entire playlist is resolved.
- 🔊 **SoundCloud support out of the box** — the bot automatically fetches a public SoundCloud API client ID on startup, no SoundCloud account required.
- 🚪 **Auto-leave** — disconnects after 5 minutes of an empty queue.

Commands

| Command | Description |
|---|---|
| `/play query:<url or search>` | Plays or queues a track/playlist. Accepts YouTube links, Spotify track/album/playlist links, SoundCloud links, or plain search text (defaults to YouTube search). |
| `/pause` | Pauses the current track. |
| `/resume` | Resumes playback. |
| `/skip` | Skips to the next track in the queue. |
| `/shuffle` | Randomly shuffles the upcoming queue (current track is untouched). |
| `/repeat mode:<on\|off>` | Toggles repeat of the current track. |
| `/queue` | Shows the queue as a paginated embed (10 tracks/page) with Prev/Next buttons. |
| `/remove position:<n>` | Removes a single track from the queue by position. |
| `/clear` | Clears every upcoming track at once (current track keeps playing). |
| `/nowplaying` | Shows what's currently playing. |
| `/stop` | Stops playback, clears the queue, and disconnects. |
| `/volume` | internal volume control

 Tech stack

- [discord.js](https://discord.js.org/) v14 — Discord API wrapper
- [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) — voice connections and audio playback
- [@iamtraction/play-dl](https://www.npmjs.com/package/@iamtraction/play-dl) — YouTube/SoundCloud audio extraction (maintained fork of the original, now-abandoned `play-dl`)
- [yt-search](https://www.npmjs.com/package/yt-search) — YouTube search (used to match Spotify tracks to YouTube audio)
- Spotify Web API (direct REST calls, OAuth authorization-code flow) — track/album/playlist metadata
- `ffmpeg` — audio transcoding for Discord voice

Prerequisites

- **Node.js 18+** (20+ recommended)
- A **Discord bot application** ([developer portal](https://discord.com/developers/applications))
- A **Spotify app** ([developer dashboard](https://developer.spotify.com/dashboard)) — only needed for Spotify link support
- **ffmpeg** available on your system (or bundled via `ffmpeg-static`, see [Troubleshooting](#troubleshooting))

 Setup

 1. Clone and install

```bash
git clone https://github.com/DarkoVasiljevic11/DiscordMusicBot.git
cd discord-music-bot
npm install
```

 2. Create a Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Add Bot** → copy the **Token**. No privileged intents (Message Content, Presence, etc.) are needed — this bot is slash-commands only.
3. **OAuth2 → URL Generator** → check scopes `bot` and `applications.commands`, and permissions `Send Messages`, `Connect`, `Speak`, `Use Voice Activity`. Open the generated URL to invite the bot to your server.
4. Copy your **Application ID** from the **General Information** page.

 3. Create and authorize a Spotify app

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → **Create app**.
2. Add a **Redirect URI** of exactly `http://127.0.0.1:8888/callback` (or your own choice — it must match `SPOTIFY_REDIRECT_URI` in step 4 exactly).
3. Copy the **Client ID** and **Client Secret**.
4. After completing step 4 below, run:
   ```bash
   node src/utils/spotify-auth.js
   ```
   Open the printed URL, log in with the Spotify account whose playlists you want the bot to read (required for private/collaborative playlists), and authorize. This creates `spotify-token.json` in the project root, which is refreshed automatically afterward — you only need to do this once, unless you revoke access.

 4. Configure environment variables

```bash
cp .env.example .env
```

```env
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-discord-application-id
GUILD_ID=your-test-server-id        # optional — instant command sync while testing
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
FFMPEG_PATH=
```

`GUILD_ID` is optional: with it set, slash commands sync to that server instantly; without it, they sync globally, which can take up to an hour to propagate.

### 5. Register slash commands

```bash
npm run deploy
```

Re-run this any time a command is added or changed.

### 6. Run the bot

```bash
npm start
```

You should see `Logged in as <bot>#0000` and `SoundCloud client ID acquired` in the console.

## Project structure

```
src/
├── index.js              # Bot entry point, command loading, SoundCloud auto-auth
├── config.js              # Environment variable loading
├── deploy-commands.js      # Registers slash commands with Discord
├── queueManager.js          # Per-guild playback state machine (join/play/skip/loop)
├── structures/
│   └── Queue.js              # Per-guild queue data structure
├── utils/
│   ├── resolveTrack.js        # Turns a URL/search query into playable track(s)
│   ├── spotify.js              # Spotify Web API client (metadata, pagination, shuffle helpers)
│   └── spotify-auth.js          # One-time interactive Spotify OAuth flow
└── commands/                 # One file per slash command
```

## Configuration knobs

| Setting | Location | Default | Notes |
|---|---|---|---|
| `SPOTIFY_SEARCH_CONCURRENCY` | `src/utils/resolveTrack.js` | `5` | Concurrent YouTube searches when resolving a Spotify playlist/album. Raise for faster loading, lower if you hit rate limits. |
| `MAX_PLAYLIST_TRACKS` / `MAX_ALBUM_TRACKS` | `src/utils/spotify.js` | `500` | Cap on how many tracks are pulled from a single Spotify playlist/album. |
| Auto-leave timeout | `src/queueManager.js` | `5 min` | How long the bot waits in an empty queue before disconnecting. |
| Queue page size | `src/commands/queue.js` | `10` | Tracks shown per page in `/queue`. |

## Troubleshooting

**Bot connects but no audio plays / `FFmpeg/avconv not found`**
`ffmpeg-static`'s bundled binary can fail to download correctly on some networks (corporate proxies, antivirus interception). Either:
- Delete `node_modules/ffmpeg-static` and reinstall (`npm install`) on a network without that interference, or
- Install ffmpeg manually and point `process.env.FFMPEG_PATH` in `src/index.js` at your `ffmpeg.exe`/`ffmpeg` binary, or add its folder to your system `PATH`.

**Voice connection times out**
Usually a firewall, VPN, or router blocking the UDP traffic Discord voice needs. Allow Node.js through your firewall, try disabling any VPN, and make sure UPnP is enabled on your router.

**`Missing Access` when running `npm run deploy`**
The bot hasn't actually been invited to that server yet, or was invited without the `applications.commands` scope. Re-generate the invite URL with both `bot` and `applications.commands` checked and re-authorize.

**SoundCloud links fail with "SoundCloud Data is missing"**
The automatic client ID fetch on startup failed (check the console output). This can happen if SoundCloud changes their public bundle format; check for an updated `@iamtraction/play-dl` version.

**Spotify API returns 403 for a playlist**
The Spotify account you authorized via `spotify-auth.js` must own or collaborate on that playlist — Spotify doesn't allow reading arbitrary private playlists via the API.

## Limitations

- In-memory queue — restarting the bot clears all active queues.
- Single-process, single-instance — not designed to be sharded across multiple servers at scale.
- Spotify playback is YouTube audio matched by title/artist, not the original Spotify master — occasional mismatches are possible for obscure tracks or unusual remixes.

## License

Personal project — use and modify freely.
