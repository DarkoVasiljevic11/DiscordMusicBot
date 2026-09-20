const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume the paused song'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    if (queue.player.state.status !== AudioPlayerStatus.Paused) {
      return interaction.reply({ content: 'Playback is not paused.', flags: MessageFlags.Ephemeral });
    }
    queue.player.unpause();
    await interaction.reply('▶️ Resumed.');
  },
};
