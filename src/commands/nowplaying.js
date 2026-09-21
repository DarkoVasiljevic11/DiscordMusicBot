const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getQueue, durationToSeconds } = require('../queueManager');

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function buildProgressBar(elapsedSec, totalSec, length = 20) {
  const ratio = totalSec > 0 ? Math.min(1, elapsedSec / totalSec) : 0;
  const filled = Math.round(ratio * length);
  return '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, length - filled));
}

module.exports = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || !queue.current) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }

    const track = queue.current;
    const totalSec = durationToSeconds(track.duration);
    // Actual played time so far, including any resumed segments from a retry.
    const elapsedSec =
      (track.seekOffset || 0) + (track.attemptStartedAt ? (Date.now() - track.attemptStartedAt) / 1000 : 0);

    const embed = new EmbedBuilder()
      .setTitle('🎶 Now Playing')
      .setDescription(`**${track.title}**${queue.loop ? ' 🔁' : ''}`);

    if (totalSec) {
      embed.addFields({
        name: '\u200b',
        value: `${buildProgressBar(elapsedSec, totalSec)}\n${formatTime(elapsedSec)} / ${formatTime(totalSec)}`,
      });
    }

    if (track.requestedBy) {
      embed.setFooter({ text: `Requested by ${track.requestedBy}` });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
