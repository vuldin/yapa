/** Entry point: `node dist/server.js`. Listens on PORT (default 8080). */
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { ConfigError, createDb, findOrCreateUser, findUserByEmail, log } from '@yapa/service/lib';
import { createApp } from './app.js';
import { createAuthenticator } from './auth.js';
import { loadMcpConfig } from './config.js';
import { createQueryEmbedder } from './embedder.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function main(): Promise<void> {
  let config;
  try {
    config = loadMcpConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log('ERROR', `refusing to start: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  if (config.authMode === 'insecure-test') {
    log('WARNING', 'YAPA_AUTH_MODE=insecure-test: test: tokens are NOT verified; never use outside local tests');
  }
  if (config.writesEnabled) {
    log('WARNING', 'YAPA_MCP_WRITES=true has no effect yet: this release has no write tools');
  }

  const db = await createDb(config, 'yapa-mcp');
  db.pool.on('error', err => log('ERROR', 'idle database client error', { error: err.message }));
  const lookupUser = (email: string) => (config.autoProvision
    ? findOrCreateUser(db.pool, email, config.allowedHd)
    : findUserByEmail(db.pool, email));
  const embedder = createQueryEmbedder({ cacheDir: config.modelDir, allowRemote: config.allowRemoteModels });
  const app = createApp({
    pool: db.pool,
    config,
    authenticator: createAuthenticator(config, lookupUser),
    embedder,
    version: VERSION,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, info => {
    log('INFO', 'yapa-mcp listening', {
      port: info.port, auth_mode: config.authMode, static_keys: config.staticKeys.size, oauth_clients: config.oauthClientIds.length, tools: [...config.tools].join(','),
    });
  });

  // Load the model while the startup probe waits on /health (503 until ready).
  const t0 = performance.now();
  embedder.warm().then(
    () => log('INFO', 'embedding model ready', { load_ms: Math.round(performance.now() - t0) }),
    e => {
      log('ERROR', 'embedding model failed to load', { error: e instanceof Error ? e.message : String(e) });
      process.exit(1);
    },
  );

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
