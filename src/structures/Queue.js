class GuildQueue {
  constructor({ guildId, textChannel, voiceChannel, connection, player }) {
    this.guildId = guildId;
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.connection = connection;
    this.player = player;

    this.songs = [];       // upcoming tracks, in order
    this.current = null;   // currently playing track (or null)
    this.playing = false;
    this.volume = 1.0;        // 1.0 = 100%, controlled via /volume
    this.loop = false;        // when true, replay the current track instead of advancing
    this.skipFlag = false;    // set briefly by /skip so a manual skip isn't treated as a loop replay
    this.retryPending = false; // set briefly during a mid-track stream-failure retry (see queueManager.js)
    this.stallCheckInterval = null; // watchdog timer detecting a silently stalled stream (see queueManager.js)
    this.leaveTimeout = null;
  }
}

module.exports = GuildQueue;
