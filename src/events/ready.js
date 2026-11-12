/** Startup: register slash commands, connect to NodeLink, log readiness. */
import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { slashPayloads } from '../commands/index.js';
import { log, warn } from '../utils/logger.js';

export function registerReady(client) {
  client.once('ready', async () => {
    log(`Logged in as ${client.user.tag} (id ${client.user.id})`);

    if (config.registerCommands) {
      try {
        const rest = new REST({ version: '10' }).setToken(config.token);
        const route = config.commandsGuildId
          ? Routes.applicationGuildCommands(client.user.id, config.commandsGuildId)
          : Routes.applicationCommands(client.user.id);
        await rest.put(route, { body: slashPayloads() });
        log(`Registered ${slashPayloads().length} slash commands${config.commandsGuildId ? ` (guild ${config.commandsGuildId})` : ' (global)'}.`);
      } catch (err) {
        warn(`Slash command registration failed: ${err.message}`);
      }
    }

    client.connectNodes();
    log('Livy is ready. 🎵');
  });
}
