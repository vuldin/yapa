/** Entry point: `node dist/server.js`. Listens on PORT (default 8080). */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createVerifier } from './auth.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db.js';
import { log } from './log.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log('ERROR', `refusing to start: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const db = await createDb(config);
  const app = createApp({ pool: db.pool, config, verifier: createVerifier(config) });
  db.pool.on('error', err => log('ERROR', 'idle database client error', { error: err.message }));

  const server = serve({ fetch: app.fetch, port: config.port }, info => {
    log('INFO', 'yapa-service listening', { port: info.port, auth_mode: config.authMode });
  });

  // Cloud Run sends SIGTERM before stopping an instance.
  const shutdown = (signal: string) => {
    log('INFO', 'shutting down', { signal });
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 9_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(e => {
  log('ERROR', 'fatal startup error', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
