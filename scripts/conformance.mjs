#!/usr/bin/env node
// Conformance check of a remote that implements YAPA Sync API v1
// (docs/sync-api.md): runs the opt-in live suite in packages/core
// (src/sync/live.test.ts) against <url>, signed in with your Google ID token.
//
// Usage: npm run conformance -- https://<host>[/<path-prefix>]
//        npm run conformance -- --mcp https://<gateway>/<mcp path>
//
// The suite writes only to a throwaway collection project-yapa-it-<run> and
// deletes what it created; it uses temporary local stores, never your YAPA
// data. Sign in first (`gcloud auth login`) or set YAPA_SYNC_ID_TOKEN_CMD.
// With --mcp, the remote serves the API as an MCP tool: set
// YAPA_SYNC_MCP_TOKEN_CMD to a command that prints your bearer token for it.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mcp = args[0] === '--mcp';
const url = mcp
  ? (args[1] ?? process.env.YAPA_LIVE_MCP_URL ?? '').trim()
  : (args[0] ?? process.env.YAPA_LIVE_SERVICE_URL ?? '').replace(/\/+$/, '');

if (!/^https?:\/\/[^/\s]+/.test(url)) {
  process.stderr.write('usage: npm run conformance -- https://<host>[/<path-prefix>]\n       npm run conformance -- --mcp https://<gateway>/<mcp path>\n');
  process.exit(2);
}
if (mcp && !process.env.YAPA_SYNC_MCP_TOKEN_CMD) {
  process.stderr.write('--mcp needs YAPA_SYNC_MCP_TOKEN_CMD: a command that prints your bearer token for the MCP gateway\n');
  process.exit(2);
}

const r = spawnSync('npx', ['vitest', 'run', 'src/sync/live.test.ts'], {
  cwd: join(root, 'packages/core'),
  stdio: 'inherit',
  env: { ...process.env, ...(mcp ? { YAPA_LIVE_MCP_URL: url, YAPA_LIVE_SERVICE_URL: '' } : { YAPA_LIVE_SERVICE_URL: url, YAPA_LIVE_MCP_URL: '' }) },
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
