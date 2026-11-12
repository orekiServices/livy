/** Prefix command dispatch (NodeCast compatibility). */
import { config } from '../config.js';
import { errorEmbed } from '../utils/embeds.js';
import { error } from '../utils/logger.js';

export function registerMessageCreate(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(config.prefix)) return;

    const withoutPrefix = message.content.slice(config.prefix.length).trim();
    if (!withoutPrefix) return;

    const [name, ...args] = withoutPrefix.split(/\s+/);
    const command = client.commands.get(name.toLowerCase());
    if (!command) return;

    try {
      await command.prefix(message, args, client);
    } catch (err) {
      error(`Prefix command "${name}" failed:`, err);
      await message.reply({ embeds: [errorEmbed('Livy hit an unexpected error running that command.')] }).catch(() => {});
    }
  });
}
