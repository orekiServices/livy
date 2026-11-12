/** Discord embed builders — one place for Livy's look & feel. */
import { EmbedBuilder } from 'discord.js';
import { formatDuration, progressBar, truncate, trackTitle } from './format.js';

export const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
};

export function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('Something went wrong')
    .setDescription(truncate(message, 1000));
}

export function successEmbed(message) {
  return new EmbedBuilder().setColor(COLORS.success).setDescription(truncate(message, 1000));
}

export function nowPlayingEmbed(track, { positionMs = 0, requesterTag = '' } = {}) {
  const info = track?.info ?? {};
  const duration = info.length ?? track?.duration ?? 0;
  const isStream = info.isStream ?? track?.isStream ?? false;

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('▶ Now Playing')
    .setDescription(
      [
        `**[${truncate(trackTitle(track), 200)}](${info.uri || track?.uri || ''})**`,
        '',
        isStream ? '🔴 LIVE' : `${progressBar(positionMs, duration)} \`${formatDuration(positionMs)} / ${formatDuration(duration)}\``,
        '',
        `👤 Requested by ${requesterTag || 'unknown'}`,
      ].join('\n'),
    )
    .setFooter({ text: `Source: ${info.sourceName || track?.sourceName || 'unknown'}` });

  const ytId = info.uri ? extractYouTubeId(info.uri) : '';
  if (ytId) embed.setThumbnail(`https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`);
  return embed;
}

function extractYouTubeId(uri) {
  try {
    const url = new URL(uri);
    return url.searchParams.get('v') || url.pathname.split('/').pop() || '';
  } catch {
    return '';
  }
}

export function queueEmbed(tracks, { page = 1, perPage = 10, current = null } = {}) {
  const totalPages = Math.max(1, Math.ceil(tracks.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const slice = tracks.slice((safePage - 1) * perPage, safePage * perPage);

  const lines = slice.map((track, i) => {
    const index = (safePage - 1) * perPage + i + 1;
    const info = track?.info ?? {};
    const duration = info.length ?? track?.duration ?? 0;
    const title = truncate(trackTitle(track), 80);
    const link = info.uri || track?.uri;
    return `${index}. ${link ? `[${title}](${link})` : title} \`[${formatDuration(duration)}]\``;
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📋 Queue — ${tracks.length} track${tracks.length === 1 ? '' : 's'}`)
    .setDescription(lines.length ? lines.join('\n') : 'Queue is empty.')
    .setFooter({ text: `Page ${safePage}/${totalPages}` });

  if (current) {
    embed.addFields({
      name: 'Now playing',
      value: truncate(trackTitle(current), 200),
      inline: false,
    });
  }
  return embed;
}

export function statsEmbed(nodeInfo, nodeStats) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🌿 NodeLink node status');

  if (nodeInfo) {
    const version = nodeInfo.version?.semver || nodeInfo.version || 'unknown';
    embed.addFields(
      { name: 'Engine', value: nodeInfo.isNodelink ? `NodeLink v${version}` : `Lavalink v${version}`, inline: true },
      { name: 'Sources', value: Array.isArray(nodeInfo.sourceManagers) ? nodeInfo.sourceManagers.join(', ') || '—' : '—', inline: false },
    );
  }
  if (nodeStats) {
    embed.addFields(
      { name: 'Players', value: String(nodeStats.players ?? '—'), inline: true },
      { name: 'Playing', value: String(nodeStats.playingPlayers ?? '—'), inline: true },
      { name: 'Uptime', value: nodeStats.uptime ? `${Math.floor(nodeStats.uptime / 60)}m ${nodeStats.uptime % 60}s` : '—', inline: true },
    );
  }
  if (!nodeInfo && !nodeStats) embed.setDescription('No node data available yet — is NodeLink running?');
  return embed;
}
