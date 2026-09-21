const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const { getQueue } = require('../queueManager');

const PAGE_SIZE = 10;
const COLLECTOR_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function buildEmbed(queue, page, totalPages) {
  const start = page * PAGE_SIZE;
  const pageSongs = queue.songs.slice(start, start + PAGE_SIZE);

  const list =
    pageSongs
      .map((s, i) => `**${start + i + 1}.** ${s.title}${s.requestedBy ? ` — _${s.requestedBy}_` : ''}`)
      .join('\n') || '_Nothing queued_';

  const nowPlayingLine = queue.current
    ? `${queue.current.title}${queue.current.requestedBy ? ` — _${queue.current.requestedBy}_` : ''}`
    : '_Nothing_';

  return new EmbedBuilder()
    .setTitle('🎵 Queue')
    .setDescription(
      `**Now Playing:** ${nowPlayingLine}${queue.loop ? ' 🔁' : ''}\n\n**Up Next (${queue.songs.length} total):**\n${list}`
    )
    .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
}

function buildRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('queue_prev')
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId('queue_next')
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

module.exports = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  async execute(interaction) {
    const queue = getQueue(interaction.guildId);
    if (!queue || (!queue.current && queue.songs.length === 0)) {
      return interaction.reply({ content: 'The queue is empty.', flags: MessageFlags.Ephemeral });
    }

    let page = 0;
    const totalPages = Math.max(1, Math.ceil(queue.songs.length / PAGE_SIZE));

    const message = await interaction.reply({
      embeds: [buildEmbed(queue, page, totalPages)],
      components: totalPages > 1 ? [buildRow(page, totalPages)] : [],
      fetchReply: true,
    });

    if (totalPages <= 1) return;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: COLLECTOR_TIMEOUT,
    });

    collector.on('collect', async (btn) => {
      if (btn.user.id !== interaction.user.id) {
        return btn.reply({ content: "This isn't your queue view — run /queue yourself to page through it.", flags: MessageFlags.Ephemeral });
      }

      // Recompute against the live queue in case songs were added/removed while browsing.
      const liveTotalPages = Math.max(1, Math.ceil(queue.songs.length / PAGE_SIZE));
      if (btn.customId === 'queue_prev') page = Math.max(0, page - 1);
      if (btn.customId === 'queue_next') page = Math.min(liveTotalPages - 1, page + 1);
      page = Math.min(page, liveTotalPages - 1);

      await btn.update({
        embeds: [buildEmbed(queue, page, liveTotalPages)],
        components: [buildRow(page, liveTotalPages)],
      });
    });

    collector.on('end', () => {
      message.edit({ components: [] }).catch(() => {});
    });
  },
};
