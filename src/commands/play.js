const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue, createQueue, playNext } = require('../queueManager');
const { resolveQuery } = require('../utils/resolveTrack');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or add it to the queue (YouTube, Spotify, or SoundCloud link/search)')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('URL or search term').setRequired(true)
    ),

  async execute(interaction) {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    const query = interaction.options.getString('query');

    // Join the voice channel up front (if not already connected) so that as
    // soon as the first track(s) resolve we can start playing immediately,
    // rather than waiting for an entire big playlist to finish resolving first.
    let queue = getQueue(interaction.guildId);
    const alreadyPlaying = queue ? queue.playing : false;
    if (!queue) {
      try {
        queue = await createQueue(interaction.guildId, {
          textChannel: interaction.channel,
          voiceChannel,
        });
      } catch (err) {
        console.error(err);
        return interaction.editReply(err.message);
      }
    }

    let total = 0;
    let addedSoFar = 0;
    let lastEdit = 0;
    let startedPlayback = false;

    const updateProgress = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastEdit < 2500) return; // avoid hitting Discord's edit rate limit
      lastEdit = now;
      const suffix = total > addedSoFar ? ` of ~${total}` : '';
      await interaction.editReply(`⏳ Resolving tracks... **${addedSoFar}**${suffix} added so far.`).catch(() => {});
    };

    try {
      const allTracks = await resolveQuery(query, interaction.user.tag, {
        onStart: (count) => {
          total = count;
        },
        onBatch: (tracks) => {
          queue.songs.push(...tracks);
          addedSoFar += tracks.length;

          if (!queue.playing) {
            startedPlayback = true;
            playNext(interaction.guildId);
          }

          // Only bother with progress messages for multi-track resolutions
          // that are slow enough to need them.
          if (total > 1) updateProgress();
        },
      });

      if (addedSoFar === 0) {
        return interaction.editReply('No results found for that query.');
      }

      if (addedSoFar === 1) {
        await interaction.editReply(
          alreadyPlaying || !startedPlayback
            ? `➕ Added to queue: **${allTracks[0].title}**`
            : `➕ Queued: **${allTracks[0].title}**`
        );
      } else {
        await interaction.editReply(
          `➕ Added **${addedSoFar}** tracks to the queue${startedPlayback ? ' — now playing!' : ''}`
        );
      }
    } catch (err) {
      console.error(err);
      if (addedSoFar === 0) {
        return interaction.editReply(`Couldn't resolve that: ${err.message}`);
      }
      // Partial success: some tracks made it in before the error.
      await interaction.editReply(
        `⚠️ Added **${addedSoFar}** track(s) before running into an error: ${err.message}`
      );
    }
  },
};
