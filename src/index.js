/**
 * Livy — Discord music bot powered by NodeLink.
 * (formerly NodeCast — rebranded to Livy)
 *
 * Entry point: validate config, build the client, register commands
 * and events, log in. NodeLink is connected on `ready`.
 */
import { LivyClient } from './client.js';
import { assertConfig } from './config.js';
import { registerCommands } from './commands/index.js';
import { registerReady } from './events/ready.js';
import { registerInteractionCreate } from './events/interactionCreate.js';
import { registerMessageCreate } from './events/messageCreate.js';
import { registerVoiceStateUpdate } from './events/voiceStateUpdate.js';
import { log, error } from './utils/logger.js';

async function main() {
  assertConfig();

  const client = new LivyClient();
  registerCommands(client);
  registerReady(client);
  registerInteractionCreate(client);
  registerMessageCreate(client);
  registerVoiceStateUpdate(client);

  client.on('error', (err) => error('Client error:', err.message));
  client.on('warn', (msg) => log('[warn]', msg));

  process.on('unhandledRejection', (reason) => error('Unhandled rejection:', reason));
  process.on('uncaughtException', (err) => error('Uncaught exception:', err));

  const shutdown = async (signal) => {
    log(`${signal} received — shutting down…`);
    try {
      for (const guildId of [...client.playerManager.players.keys()]) {
        client.playerManager.leave(guildId);
      }
      client.destroy();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((err) => {
  error('Failed to start Livy:', err.message);
  process.exit(1);
});
