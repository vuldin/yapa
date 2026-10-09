#!/usr/bin/env node
// Build the Claude Code plugin in plugin/: bundle the MCP server and the hook
// CLI (with @yapa/core inlined) into plugin/dist, and regenerate the files
// derived from source so they can't drift: hooks/hooks.json (from the same
// HOOK_EVENTS table `yapa hooks install` uses) and the plugin's runtime
// package.json (heavy native/WASM deps stay external and are installed by
// Claude Code from plugin/package.json + package-lock.json on plugin install).
//
// Usage: npm run build:plugin   (after `npm run build`)

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugin');
const readJson = p => JSON.parse(readFileSync(join(root, p), 'utf-8'));

const core = readJson('packages/core/package.json');
const mcp = readJson('packages/mcp/package.json');
const version = mcp.version;

// Resolved at runtime from plugin/node_modules (native binaries, WASM, pg).
const EXTERNAL = Object.keys(core.dependencies);

await build({
  entryPoints: {
    'yapa-mcp': join(root, 'packages/mcp/src/index.ts'),
    yapa: join(root, 'packages/mcp/src/cli/index.ts'),
  },
  outdir: join(plugin, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: EXTERNAL,
  alias: { '@yapa/core': join(root, 'packages/core/src/index.ts') },
  // CJS deps bundled into ESM still call require(); give them one.
  banner: { js: "import { createRequire as __yapaCreateRequire } from 'node:module'; const require = __yapaCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

// hooks/hooks.json — generated from the CLI's own table.
const { HOOK_EVENTS } = await import(join(root, 'packages/mcp/dist/cli/install-hooks.js'));
const hooks = {};
for (const { event, sub, async, timeout } of HOOK_EVENTS) {
  const hook = { type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/dist/yapa.mjs" hook ${sub}` };
  if (async) hook.async = true;
  if (timeout) hook.timeout = timeout;
  hooks[event] = [{ hooks: [hook] }];
}
mkdirSync(join(plugin, 'hooks'), { recursive: true });
writeFileSync(
  join(plugin, 'hooks', 'hooks.json'),
  JSON.stringify({ description: 'YAPA: context injection, teammate sync freshening, response/compaction capture', hooks }, null, 2) + '\n',
);

// Runtime package.json: exactly the externals, pinned to core's ranges.
writeFileSync(
  join(plugin, 'package.json'),
  JSON.stringify({
    name: 'yapa-claude-code-plugin',
    version,
    private: true,
    type: 'module',
    description: 'Runtime dependencies for the bundled YAPA plugin (installed by Claude Code)',
    engines: { node: '>=20' },
    dependencies: Object.fromEntries(EXTERNAL.map(d => [d, core.dependencies[d]])),
  }, null, 2) + '\n',
);

// Keep the manifest version in lockstep with the MCP package.
const manifestPath = join(plugin, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`plugin built: plugin/dist (v${version}); externals: ${EXTERNAL.join(', ')}`);
