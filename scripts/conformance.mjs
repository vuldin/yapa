#!/usr/bin/env node
// Conformance check of a remote that implements YAPA Sync API v1
// (docs/sync-api.md): runs the opt-in live suite in packages/core
// (src/sync/live.test.ts) against <url>, signed in with your Google ID token.
//
// Usage: npm run conformance -- https://<host>[/<path-prefix>]
//
// The suite writes only to a throwaway collection project-yapa-it-<run> and
// deletes what it created; it uses temporary local stores, never your YAPA
// data. Sign in first (`gcloud auth login`) or set YAPA_SYNC_ID_TOKEN_CMD.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.argv[2] ?? process.env.YAPA_LIVE_SERVICE_URL ?? '').replace(/\/+$/, '');

if (!/^https?:\/\/[^/\s]+/.test(url)) {
  process.stderr.write('usage: npm run conformance -- https://<host>[/<path-prefix>]\n');
  process.exit(2);
}

const r = spawnSync('npx', ['vitest', 'run', 'src/sync/live.test.ts'], {
  cwd: join(root, 'packages/core'),
  stdio: 'inherit',
  env: { ...process.env, YAPA_LIVE_SERVICE_URL: url },
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
