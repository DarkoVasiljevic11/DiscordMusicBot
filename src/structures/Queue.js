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
    this.loop = false;     // when true, replay the current track instead of advancing
    this.skipFlag = false; // set briefly by /skip so a manual skip isn't treated as a loop replay
    this.leaveTimeout = null;
  }
}

module.exports = GuildQueue;
