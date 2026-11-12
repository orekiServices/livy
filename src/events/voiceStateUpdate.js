/**
 * Voice state tracking:
 *  - bot disconnected / moved externally -> keep Livy state in sync
 *  - voice channel becomes empty -> start the auto-leave timer
 *  - someone rejoins -> cancel the timer
 */
import { isVoiceChannelEmpty } from '../utils/permissions.js';

export function registerVoiceStateUpdate(client) {
  client.on('voiceStateUpdate', (oldState, newState) => {
    const guildPlayer = client.playerManager.get(newState.guild.id);
    if (!guildPlayer) return;

    const isBot = newState.id === client.user.id;

    if (isBot) {
      if (!newState.channelId) {
        // Kicked / disconnected externally.
        guildPlayer.voiceChannelId = null;
        guildPlayer.playing = false;
        guildPlayer.scheduleEmptyLeave(client, (gid) => client.playerManager.delete(gid));
      } else {
        guildPlayer.voiceChannelId = newState.channelId;
      }
      return;
    }

    const channel = newState.channel ?? oldState.channel;
    if (!channel || channel.id !== guildPlayer.voiceChannelId) return;

    if (isVoiceChannelEmpty(channel)) {
      guildPlayer.scheduleEmptyLeave(client, (gid) => client.playerManager.delete(gid));
    } else {
      guildPlayer.cancelEmptyTimer();
    }
  });
}
