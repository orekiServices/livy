/** Voice-channel guards shared by every playback command. */

/** Returns an error string, or null when the member may control playback. */
export function checkVoiceState(member, guildPlayer) {
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) return 'You must be in a voice channel.';
  if (member.voice.deaf) return 'Undeafen yourself to control playback.';
  if (guildPlayer?.voiceChannelId && voiceChannel.id !== guildPlayer.voiceChannelId) {
    return `Join <#${guildPlayer.voiceChannelId}> — Livy is playing there.`;
  }
  return null;
}

/** True when the bot is the only non-bot member left in its channel. */
export function isVoiceChannelEmpty(voiceChannel) {
  if (!voiceChannel) return true;
  return voiceChannel.members.filter((m) => !m.user.bot).size === 0;
}
