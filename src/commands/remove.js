const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a single song from the queue by position')
    .addIntegerOption((opt) =>
      opt
        .setName('position')
        .setDescription('Position in the queue (see /queue)')
        .setRequired(true)
        .setMinValue(1)
    ),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    const position = interaction.options.getInteger('position');

    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: 'The queue is empty.', flags: MessageFlags.Ephemeral });
    }
    if (position > queue.songs.length) {
      return interaction.reply({ content: `There's no song at position ${position}.`, flags: MessageFlags.Ephemeral });
    }

    const [removed] = queue.songs.splice(position - 1, 1);
    await interaction.reply(`🗑️ Removed **${removed.title}** from the queue.`);
  },
};
