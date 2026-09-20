const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    await interaction.reply(`🎶 Now playing: **${queue.current.title}**`);
  },
};
