/** Informational commands: queue, nowplaying, lyrics, filter, stats, help, ping. */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { errorEmbed, queueEmbed, nowPlayingEmbed, statsEmbed, COLORS } from '../utils/embeds.js';
import { getNodeInfo, getNodeStats } from '../fastlink-compat.js';
import { FILTER_NAMES, resolveFilter } from '../managers/FilterManager.js';
import { formatLyrics } from '../managers/LyricsManager.js';
import { config } from '../config.js';

export const queueCommand = {
  name: 'queue',
  aliases: ['q'],
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  async slash(interaction, client) {
    const guildPlayer = client.playerManager.get(interaction.guild.id);
    if (!guildPlayer || guildPlayer.queue.isEmpty) {
      return interaction.reply({ embeds: [errorEmbed('Queue is empty.')], ephemeral: true });
    }
    const page = interaction.options.getInteger('page') ?? 1;
    return interaction.reply({
      embeds: [queueEmbed(guildPlayer.queue.all(), { page, current: guildPlayer.queue.current })],
    });
  },
  async prefix(message, args, client) {
    const guildPlayer = client.playerManager.get(message.guild.id);
    if (!guildPlayer || guildPlayer.queue.isEmpty) {
      return message.reply({ embeds: [errorEmbed('Queue is empty.')] });
    }
    const page = Number.parseInt(args[0], 10) || 1;
    return message.reply({
      embeds: [queueEmbed(guildPlayer.queue.all(), { page, current: guildPlayer.queue.current })],
    });
  },
};

export const nowPlayingCommand = {
  name: 'nowplaying',
  aliases: ['np'],
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current track'),
  async slash(interaction, client) {
    const guildPlayer = client.playerManager.get(interaction.guild.id);
    if (!guildPlayer?.queue.current) {
      return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    }
    return interaction.reply({
      embeds: [nowPlayingEmbed(guildPlayer.queue.current, {
        positionMs: guildPlayer.positionMs,
        requesterTag: guildPlayer.queue.current.requesterTag,
      })],
    });
  },
  async prefix(message, _args, client) {
    const guildPlayer = client.playerManager.get(message.guild.id);
    if (!guildPlayer?.queue.current) {
      return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
    }
    return message.reply({
      embeds: [nowPlayingEmbed(guildPlayer.queue.current, {
        positionMs: guildPlayer.positionMs,
        requesterTag: guildPlayer.queue.current.requesterTag,
      })],
    });
  },
};

export const lyricsCommand = {
  name: 'lyrics',
  aliases: ['ly'],
  data: new SlashCommandBuilder().setName('lyrics').setDescription('Show lyrics for the current track'),
  async slash(interaction, client) {
    const guildPlayer = client.playerManager.get(interaction.guild.id);
    if (!guildPlayer?.queue.current) {
      return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    }
    await interaction.deferReply();
    try {
      const result = await client.lyricsManager.getLyrics(guildPlayer.player, guildPlayer.queue.current.encoded);
      if (!result) return interaction.editReply({ embeds: [errorEmbed('No lyrics found for this track.')] });
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🎤 ${guildPlayer.queue.current.title}`.slice(0, 256))
        .setDescription(formatLyrics(result.lyrics))
        .setFooter({ text: result.synced ? 'Synced lyrics via NodeLink' : 'Lyrics via NodeLink' });
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply({ embeds: [errorEmbed(`Lyrics unavailable: ${err.message}`)] });
    }
  },
  async prefix(message, _args, client) {
    const guildPlayer = client.playerManager.get(message.guild.id);
    if (!guildPlayer?.queue.current) {
      return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
    }
    try {
      const result = await client.lyricsManager.getLyrics(guildPlayer.player, guildPlayer.queue.current.encoded);
      if (!result) return message.reply({ embeds: [errorEmbed('No lyrics found for this track.')] });
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🎤 ${guildPlayer.queue.current.title}`.slice(0, 256))
        .setDescription(formatLyrics(result.lyrics))
        .setFooter({ text: result.synced ? 'Synced lyrics via NodeLink' : 'Lyrics via NodeLink' });
      return message.reply({ embeds: [embed] });
    } catch (err) {
      return message.reply({ embeds: [errorEmbed(`Lyrics unavailable: ${err.message}`)] });
    }
  },
};

export const filterCommand = {
  name: 'filter',
  aliases: ['fx'],
  data: new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Apply an audio filter preset')
    .addStringOption((o) =>
      o.setName('preset').setDescription('Filter preset').setRequired(true)
        .addChoices(...FILTER_NAMES.map((n) => ({ name: n, value: n }))),
    ),
  async slash(interaction, client) {
    const guildPlayer = client.playerManager.get(interaction.guild.id);
    if (!guildPlayer?.queue.current) {
      return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    }
    const preset = interaction.options.getString('preset', true);
    guildPlayer.filters = resolveFilter(preset) ?? {};
    guildPlayer.player.update({ filters: guildPlayer.filters });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setDescription(`🎛 Filter applied: **${preset}**.`)] });
  },
  async prefix(message, args, client) {
    const guildPlayer = client.playerManager.get(message.guild.id);
    if (!guildPlayer?.queue.current) {
      return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
    }
    const preset = String(args[0] ?? '').toLowerCase();
    const filters = resolveFilter(preset);
    if (!filters && preset !== 'off') {
      return message.reply({ embeds: [errorEmbed(`Unknown filter. Available: ${FILTER_NAMES.join(', ')}.`)] });
    }
    guildPlayer.filters = filters ?? {};
    guildPlayer.player.update({ filters: guildPlayer.filters });
    return message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setDescription(`🎛 Filter applied: **${preset}**.`)] });
  },
};

export const statsCommand = {
  name: 'stats',
  aliases: [],
  data: new SlashCommandBuilder().setName('stats').setDescription('Show NodeLink node status'),
  async slash(interaction, client) {
    await interaction.deferReply();
    const hostname = config.nodes[0].hostname;
    const [info, stats] = await Promise.allSettled([
      getNodeInfo(hostname),
      getNodeStats(hostname),
    ]);
    return interaction.editReply({
      embeds: [statsEmbed(
        info.status === 'fulfilled' ? info.value : null,
        stats.status === 'fulfilled' ? stats.value : null,
      )],
    });
  },
  async prefix(message, _args, client) {
    const hostname = config.nodes[0].hostname;
    const [info, stats] = await Promise.allSettled([
      getNodeInfo(hostname),
      getNodeStats(hostname),
    ]);
    return message.reply({
      embeds: [statsEmbed(
        info.status === 'fulfilled' ? info.value : null,
        stats.status === 'fulfilled' ? stats.value : null,
      )],
    });
  },
};

export const pingCommand = {
  name: 'ping',
  aliases: [],
  data: new SlashCommandBuilder().setName('ping').setDescription('Check Livy is alive'),
  async slash(interaction, client) {
    return interaction.reply(`🏓 Pong! WebSocket latency: **${client.ws.ping}ms**`);
  },
  async prefix(message, _args, client) {
    return message.reply(`🏓 Pong! WebSocket latency: **${client.ws.ping}ms**`);
  },
};

export const helpCommand = {
  name: 'help',
  aliases: ['h'],
  data: new SlashCommandBuilder().setName('help').setDescription('List Livy commands'),
  async slash(interaction, client) {
    return interaction.reply({ embeds: [helpEmbed(client)] });
  },
  async prefix(message, _args, client) {
    return message.reply({ embeds: [helpEmbed(client)] });
  },
};

function helpEmbed(client) {
  const lines = [...client.commands.values()].map((c) => `\`${config.prefix}${c.name}\` — ${c.data?.description ?? ''}`);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🎵 Livy — commands')
    .setDescription(lines.join('\n') || 'No commands registered.')
    .setFooter({ text: 'Slash commands work too: /play, /queue, /skip …' });
}
