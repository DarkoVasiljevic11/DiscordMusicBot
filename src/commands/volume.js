const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('View or set the playback volume')
    .addIntegerOption((opt) =>
      opt
        .setName('percent')
        .setDescription('0-200, where 100 is normal volume')
        .setMinValue(0)
        .setMaxValue(200)
    ),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }

    const percent = interaction.options.getInteger('percent');

    if (percent === null) {
      return interaction.reply(`🔊 Current volume: **${Math.round(queue.volume * 100)}%**`);
    }

    queue.volume = percent / 100;
    // Applies instantly to whatever's currently playing, not just future tracks.
    queue.current?.resource?.volume?.setVolume(queue.volume);

    await interaction.reply(`🔊 Volume set to **${percent}%**.`);
  },
};
