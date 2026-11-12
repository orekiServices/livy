import { buildApp } from './server.js';

/**
 * Livy entry point — persistent server mode (self-hosted / Deplexo).
 * For serverless (Vercel), see /api/index.ts instead.
 */
async function main(): Promise<void> {
  const { app, config, shutdown } = await buildApp();

  const onSignal = (signal: string): void => {
    app.log.info({ signal }, 'Shutting down');
    shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Livy listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('Livy failed to start:', err);
  process.exit(1);
});
