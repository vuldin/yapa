import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_OPTION_PREFIX = 'CLAUDE_PLUGIN_OPTION_';

/**
 * Hook commands run as plain subprocesses of Claude Code, so they don't see
 * the env the yapa MCP server was configured with. Resolve the same settings
 * the server gets, in priority order:
 *
 *   1. explicit YAPA_* env (the user's shell, or a hook's own env)
 *   2. plugin options — Claude Code exports userConfig to plugin hooks as
 *      CLAUDE_PLUGIN_OPTION_<KEY>; key `sync_service_url` -> YAPA_SYNC_SERVICE_URL
 *   3. the `yapa` server's env block in ~/.claude.json (a `claude mcp add`
 *      install), project-scoped entry for `cwd` first, then user scope —
 *      only when NOT running as a plugin hook
 *
 * Returns only the variables to add; never overrides what's already set.
 */
export function resolveHostEnv(
  env: Record<string, string | undefined>,
  claudeConfig: any,
  cwd?: string,
): Record<string, string> {
  const add: Record<string, string> = {};
  const offer = (key: string, value: unknown) => {
    if (typeof value !== 'string' || value === '') return;
    if (env[key] !== undefined || add[key] !== undefined) return;
    add[key] = value;
  };

  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(PLUGIN_OPTION_PREFIX)) {
      offer(`YAPA_${key.slice(PLUGIN_OPTION_PREFIX.length)}`, value);
    }
  }

  // Running as a plugin hook: the plugin replaces the CLAUDE.md rules block
  // with SessionStart injection, and shares the model cache with its server.
  // Plugin options are then the ONLY source — falling through to a legacy
  // `claude mcp add` entry would mix two installs' settings (e.g. hooks
  // syncing as one user while the plugin's server runs as another).
  if (env.CLAUDE_PLUGIN_ROOT) {
    offer('YAPA_HOOK_INJECT_RULES', 'true');
    if (env.CLAUDE_PLUGIN_DATA) offer('YAPA_MODEL_CACHE_DIR', join(env.CLAUDE_PLUGIN_DATA, 'models'));
    return add;
  }

  const projectEnv = cwd ? claudeConfig?.projects?.[cwd]?.mcpServers?.yapa?.env : undefined;
  for (const block of [projectEnv, claudeConfig?.mcpServers?.yapa?.env]) {
    if (!block || typeof block !== 'object') continue;
    for (const [key, value] of Object.entries(block)) offer(key, value);
  }
  return add;
}

/** Apply resolveHostEnv to process.env (reads ~/.claude.json if present). */
export function adoptHostEnv(cwd?: string): void {
  let claudeConfig: any;
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? homedir();
    claudeConfig = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf-8'));
  } catch {
    claudeConfig = undefined; // other harness, or Claude Code not installed
  }
  Object.assign(process.env, resolveHostEnv(process.env, claudeConfig, cwd));
}
