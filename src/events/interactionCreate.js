/** Slash command dispatch. */
import { errorEmbed } from '../utils/embeds.js';
import { error } from '../utils/logger.js';

export function registerInteractionCreate(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.slash(interaction, client);
    } catch (err) {
      error(`Command /${interaction.commandName} failed:`, err);
      const payload = { embeds: [errorEmbed('Livy hit an unexpected error running that command.')], ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });
}
