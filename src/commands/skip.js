const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue, skipCurrent } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }

    const track = queue.current;

    // Reply BEFORE skipping. Skipping starts the next track immediately,
    // which can launch yt-dlp.exe; on Windows (especially with antivirus
    // scanning the exe) that can stall the bot for several seconds, and
    // Discord shows "The application did not respond" if there's no reply
    // within 3 seconds.
    await interaction.reply(`⏭️ Skipped **${track.title}**.`);

    skipCurrent(interaction.guildId, track);
  },
};
