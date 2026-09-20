const {
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the songs currently waiting in the queue.'),

  async execute(interaction) {
    try {
      const queue = getQueue(interaction.guildId);

      if (!queue) {
        return interaction.reply({
          content: '❌ There is no active music queue.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!queue.songs || queue.songs.length < 2) {
        return interaction.reply({
          content: '❌ There are not enough songs in the queue to shuffle.',
          flags: MessageFlags.Ephemeral,
        });
      }

      /*
       * queue.songs only ever holds UPCOMING tracks — the currently playing
       * track lives separately in queue.current and is untouched here, so
       * every entry in queue.songs is safe to shuffle.
       */
      const shuffled = [...queue.songs];

      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [shuffled[i], shuffled[j]] = [
          shuffled[j],
          shuffled[i],
        ];
      }

      queue.songs = shuffled;

      console.log(
        'Songs after shuffle:',
        queue.songs.map((song, index) => `${index + 1}. ${song.title}`)
      );

      await interaction.reply({
        content: `🔀 Shuffled **${shuffled.length}** songs in the queue.`,
      });
    } catch (err) {
      console.error('❌ Shuffle error:', err);

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(
          '❌ Something went wrong while shuffling the queue.'
        );
      } else {
        await interaction.reply({
          content: '❌ Something went wrong while shuffling the queue.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

