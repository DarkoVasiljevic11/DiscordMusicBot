const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear the entire upcoming queue (keeps the current song playing)'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || queue.songs.length === 0) {
      return interaction.reply({ content: 'The queue is already empty.', flags: MessageFlags.Ephemeral });
    }
    const count = queue.songs.length;
    queue.songs = [];
    await interaction.reply(`🧹 Cleared **${count}** song(s) from the queue.`);
  },
};
