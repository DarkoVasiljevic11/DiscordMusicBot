const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    const skipped = queue.current.title;
    queue.skipFlag = true;
    queue.player.stop(); // triggers Idle -> queueManager plays the next song automatically
    await interaction.reply(`⏭️ Skipped **${skipped}**.`);
  },
};
