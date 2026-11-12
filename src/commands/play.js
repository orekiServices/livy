/** /play <query> — resolve via NodeLink and enqueue (or play now). */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { checkVoiceState } from '../utils/permissions.js';
import { errorEmbed, nowPlayingEmbed, COLORS } from '../utils/embeds.js';
import { truncate } from '../utils/format.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a track or playlist from a URL or search query')
  .addStringOption((o) => o.setName('query').setDescription('URL or search query').setRequired(true));

async function run({ client, guild, member, user, channel, query, reply, defer }) {
  const guildPlayer = client.playerManager.getOrCreate(guild.id);
  const voiceError = checkVoiceState(member, guildPlayer);
  if (voiceError) return reply({ embeds: [errorEmbed(voiceError)], ephemeral: true });

  await defer();
  try {
    const result = await client.playerManager.enqueue(guild.id, query, {
      id: user.id,
      tag: user.tag ?? user.username,
      channelId: channel.id,
    });

    // Join the voice channel (idempotent — FastLink re-sends the payload).
    guildPlayer.connect(member.voice.channel.id, client);
    guildPlayer.stayConnected = false;
    guildPlayer.cancelEmptyTimer();

    if (result.status === 'playing') {
      return reply({
        embeds: [nowPlayingEmbed(result.track, { requesterTag: result.track.requesterTag })],
      });
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setDescription(
        result.playlistName
          ? `Added **${result.added}** tracks from *${truncate(result.playlistName, 100)}* to the queue.`
          : `Added **[${truncate(result.track.title, 150)}](${result.track.uri || ''})** to the queue at position **#${result.position}**.`,
      );
    return reply({ embeds: [embed] });
  } catch (err) {
    return reply({ embeds: [errorEmbed(err.message)], ephemeral: true });
  }
}

export const command = {
  name: 'play',
  aliases: ['p'],
  data,
  async slash(interaction, client) {
    await run({
      client,
      guild: interaction.guild,
      member: interaction.member,
      user: interaction.user,
      channel: interaction.channel,
      query: interaction.options.getString('query', true),
      reply: (payload) => interaction.editReply(payload),
      defer: () => interaction.deferReply(),
    });
  },
  async prefix(message, args, client) {
    const query = args.join(' ').trim();
    if (!query) return message.reply({ embeds: [errorEmbed('Please provide a search query or URL.')] });
    await run({
      client,
      guild: message.guild,
      member: message.member,
      user: message.author,
      channel: message.channel,
      query,
      reply: (payload) => message.reply(payload),
      defer: () => message.channel.sendTyping().catch(() => {}),
    });
  },
};
