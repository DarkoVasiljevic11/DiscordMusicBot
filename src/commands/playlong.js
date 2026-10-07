const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
  getQueue,
  createQueue,
  playNext,
} = require('../queueManager');
const { resolveQuery } = require('../utils/resolveTrack');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playlong')
    .setDescription('Play a long YouTube video or music compilation')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('YouTube URL, playlist URL, or search term')
        .setRequired(true)
    ),

  async execute(interaction) {
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      await interaction.reply({
        content: 'Join a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    const query = interaction.options.getString('query');

    let queue = getQueue(interaction.guildId);

    if (!queue) {
      try {
        queue = await createQueue(interaction.guildId, {
          textChannel: interaction.channel,
          voiceChannel,
        });
      } catch (err) {
        console.error(err);
        await interaction.editReply(err.message);
        return;
      }
    }

    let addedSoFar = 0;
    let startedPlayback = false;

    try {
      const tracks = await resolveQuery(
        query,
        interaction.user.tag,
        {
          longMode: true,

          onStart: () => {},

          onBatch: (batch) => {
            if (!batch || batch.length === 0) {
              return;
            }

            queue.songs.push(...batch);
            addedSoFar += batch.length;

            if (!queue.playing) {
              startedPlayback = true;
              playNext(interaction.guildId);
            }
          },
        }
      );

      if (!tracks || tracks.length === 0) {
        await interaction.editReply(
          'No playable YouTube videos were found.'
        );
        return;
      }

      if (addedSoFar === 1) {
        await interaction.editReply(
          `➕ Added to queue: **${tracks[0].title}**`
        );
        return;
      }

      await interaction.editReply(
        `➕ Added **${addedSoFar}** long-video tracks to the queue${
          startedPlayback ? ' — now playing!' : ''
        }`
      );
    } catch (err) {
      console.error('playlong error:', err);

      if (addedSoFar === 0) {
        await interaction.editReply(
          `Couldn't resolve that YouTube video: ${err.message}`
        );
        return;
      }

      await interaction.editReply(
        `⚠️ Added **${addedSoFar}** track(s) before running into an error: ${err.message}`
      );
    }
  },
};