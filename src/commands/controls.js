/**
 * Playback controls: pause, resume, skip, stop, leave, volume, loop,
 * shuffle, seek. Each is a separate slash command (and prefix alias).
 */
import { SlashCommandBuilder } from 'discord.js';
import { checkVoiceState } from '../utils/permissions.js';
import { errorEmbed, successEmbed } from '../utils/embeds.js';
import { parseDuration, formatDuration } from '../utils/format.js';
import { LOOP_MODES } from '../managers/QueueManager.js';

function needPlayer(client, guild) {
  const guildPlayer = client.playerManager.get(guild.id);
  if (!guildPlayer || !guildPlayer.queue.current) return null;
  return guildPlayer;
}

function makeSimple(name, description, aliases, handler) {
  return {
    name,
    aliases,
    data: new SlashCommandBuilder().setName(name).setDescription(description),
    async slash(interaction, client) {
      const guildPlayer = needPlayer(client, interaction.guild);
      if (!guildPlayer) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
      const voiceError = checkVoiceState(interaction.member, guildPlayer);
      if (voiceError) return interaction.reply({ embeds: [errorEmbed(voiceError)], ephemeral: true });
      return handler({ client, guildPlayer, interaction, reply: (p) => interaction.reply(p) });
    },
    async prefix(message, args, client) {
      const guildPlayer = needPlayer(client, message.guild);
      if (!guildPlayer) return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
      const voiceError = checkVoiceState(message.member, guildPlayer);
      if (voiceError) return message.reply({ embeds: [errorEmbed(voiceError)] });
      return handler({ client, guildPlayer, message, args, reply: (p) => message.reply(p) });
    },
  };
}

export const pauseCommand = makeSimple('pause', 'Pause playback', ['ps'], ({ guildPlayer, reply }) => {
  guildPlayer.player.update({ paused: true });
  guildPlayer.paused = true;
  return reply({ embeds: [successEmbed('⏸ Paused.')] });
});

export const resumeCommand = makeSimple('resume', 'Resume playback', [], ({ guildPlayer, reply }) => {
  guildPlayer.player.update({ paused: false });
  guildPlayer.paused = false;
  return reply({ embeds: [successEmbed('▶ Resumed.')] });
});

export const skipCommand = makeSimple('skip', 'Skip the current track', ['s', 'next'], ({ client, guildPlayer, reply }) => {
  const skipped = client.playerManager.skip(guildPlayer.guildId);
  if (!skipped) return reply({ embeds: [errorEmbed('Nothing to skip.')] });
  const next = guildPlayer.queue.current;
  return reply({
    embeds: [successEmbed(next ? `⏭ Skipped **${skipped.title}**. Now playing **${next.title}**.` : `⏭ Skipped **${skipped.title}**. Queue is empty.`)],
  });
});

export const stopCommand = makeSimple('stop', 'Stop playback and clear the queue (stays in channel)', [], ({ client, guildPlayer, reply }) => {
  client.playerManager.stop(guildPlayer.guildId);
  return reply({ embeds: [successEmbed('⏹ Stopped and cleared the queue.')] });
});

export const leaveCommand = makeSimple('leave', 'Stop playback and leave the voice channel', ['disconnect', 'dc'], ({ client, guildPlayer, reply }) => {
  client.playerManager.leave(guildPlayer.guildId);
  return reply({ embeds: [successEmbed('👋 Left the voice channel.')] });
});

export const shuffleCommand = makeSimple('shuffle', 'Shuffle upcoming tracks', [], ({ guildPlayer, reply }) => {
  if (guildPlayer.queue.tracks.length < 2) return reply({ embeds: [errorEmbed('Not enough tracks to shuffle.')] });
  guildPlayer.queue.shuffle();
  return reply({ embeds: [successEmbed('🔀 Queue shuffled.')] });
});

export const volumeCommand = {
  name: 'volume',
  aliases: ['vol'],
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume (0–200)')
    .addIntegerOption((o) => o.setName('level').setDescription('Volume level').setRequired(true).setMinValue(0).setMaxValue(200)),
  async slash(interaction, client) {
    const guildPlayer = needPlayer(client, interaction.guild);
    if (!guildPlayer) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    const level = interaction.options.getInteger('level', true);
    guildPlayer.volume = level;
    guildPlayer.player.update({ volume: level });
    return interaction.reply({ embeds: [successEmbed(`🔊 Volume set to **${level}%**.`)] });
  },
  async prefix(message, args, client) {
    const guildPlayer = needPlayer(client, message.guild);
    if (!guildPlayer) return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
    const level = Number.parseInt(args[0], 10);
    if (Number.isNaN(level) || level < 0 || level > 200) {
      return message.reply({ embeds: [errorEmbed('Volume must be between 0 and 200.')] });
    }
    guildPlayer.volume = level;
    guildPlayer.player.update({ volume: level });
    return message.reply({ embeds: [successEmbed(`🔊 Volume set to **${level}%**.`)] });
  },
};

export const loopCommand = {
  name: 'loop',
  aliases: ['repeat'],
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption((o) =>
      o.setName('mode').setDescription('Loop mode').setRequired(true)
        .addChoices(...LOOP_MODES.map((m) => ({ name: m, value: m }))),
    ),
  async slash(interaction, client) {
    const guildPlayer = needPlayer(client, interaction.guild);
    if (!guildPlayer) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    const mode = interaction.options.getString('mode', true);
    guildPlayer.queue.setLoop(mode);
    return interaction.reply({ embeds: [successEmbed(`🔁 Loop mode: **${mode}**.`)] });
  },
  async prefix(message, args, client) {
    const guildPlayer = needPlayer(client, message.guild);
    if (!guildPlayer) return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
    const mode = String(args[0] ?? '').toLowerCase();
    if (!LOOP_MODES.includes(mode)) {
      return message.reply({ embeds: [errorEmbed(`Loop mode must be one of: ${LOOP_MODES.join(', ')}.`)] });
    }
    guildPlayer.queue.setLoop(mode);
    return message.reply({ embeds: [successEmbed(`🔁 Loop mode: **${mode}**.`)] });
  },
};

export const seekCommand = {
  name: 'seek',
  aliases: [],
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Seek to a position in the current track')
    .addStringOption((o) => o.setName('time').setDescription('e.g. 1:30, 90s, 2m').setRequired(true)),
  async slash(interaction, client) {
    const guildPlayer = needPlayer(client, interaction.guild);
    if (!guildPlayer) return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    const ms = parseDuration(interaction.options.getString('time', true));
    if (ms === null) return interaction.reply({ embeds: [errorEmbed('Invalid time. Try 1:30, 90s or 2m.')], ephemeral: true });
    guildPlayer.player.update({ position: ms });
    guildPlayer.positionMs = ms;
    return interaction.reply({ embeds: [successEmbed(`⏩ Seeked to **${formatDuration(ms)}**.`)] });
  },
  async prefix(message, args, client) {
    const guildPlayer = needPlayer(client, message.guild);
    if (!guildPlayer) return message.reply({ embeds: [errorEmbed('Nothing is playing.')] });
    const ms = parseDuration(args.join(' '));
    if (ms === null) return message.reply({ embeds: [errorEmbed('Invalid time. Try 1:30, 90s or 2m.')] });
    guildPlayer.player.update({ position: ms });
    guildPlayer.positionMs = ms;
    return message.reply({ embeds: [successEmbed(`⏩ Seeked to **${formatDuration(ms)}**.`)] });
  },
};
