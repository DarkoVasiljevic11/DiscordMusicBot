const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getQueue } = require('../queueManager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('repeat')
    .setDescription('Turn repeat of the current song on or off')
    .addStringOption((opt) =>
      opt
        .setName('mode')
        .setDescription('on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })
    ),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }

    const mode = interaction.options.getString('mode');
    queue.loop = mode === 'on';

    await interaction.reply(
      queue.loop ? '🔁 Repeat is now **on** — the current song will replay.' : '➡️ Repeat is now **off**.'
    );
  },
};
