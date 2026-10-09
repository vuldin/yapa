import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Hook events YAPA wires into Claude Code, and the `yapa hook <name>`
 * subcommand each runs. Kept in one table so the plugin's hooks/hooks.json
 * and `yapa hooks install` (for `claude mcp add` users) cannot drift apart;
 * a test asserts the plugin file matches.
 */
export const HOOK_EVENTS: Array<{ event: string; sub: string; async?: boolean; timeout?: number }> = [
  { event: 'SessionStart', sub: 'session-start', timeout: 30 },
  { event: 'UserPromptSubmit', sub: 'user-prompt-submit', timeout: 15 },
  // Response capture calls an aux LLM; never make the user wait on it.
  { event: 'Stop', sub: 'stop', async: true },
  { event: 'PostCompact', sub: 'post-compact', async: true },
  { event: 'SessionEnd', sub: 'session-end' },
];

/** Marker that identifies a hook entry as YAPA's (for idempotent re-install/uninstall). */
const MARKER = 'yapa';

function isYapaHook(h: any): boolean {
  return typeof h?.command === 'string' && /\bhook\s+[a-z-]+$/.test(h.command) && h.command.includes(MARKER);
}

/** Return `settings` with YAPA's hook entries replaced by fresh ones running `command`. */
export function mergeHooks(settings: Record<string, any>, command: string): Record<string, any> {
  const next = removeHooks(settings);
  next.hooks ??= {};
  for (const { event, sub, async, timeout } of HOOK_EVENTS) {
    const hook: Record<string, any> = { type: 'command', command: `${command} hook ${sub}` };
    if (async) hook.async = true;
    if (timeout) hook.timeout = timeout;
    next.hooks[event] = [...(next.hooks[event] ?? []), { hooks: [hook] }];
  }
  return next;
}

/** Return `settings` with every YAPA hook entry removed (other hooks untouched). */
export function removeHooks(settings: Record<string, any>): Record<string, any> {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  for (const [event, groups] of Object.entries<any[]>(next.hooks)) {
    const kept = (groups ?? [])
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isYapaHook(h)) }))
      .filter(g => g.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export function defaultSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
}

/** The command that runs this CLI, as an absolute path (survives cwd changes). */
export function selfCommand(): string {
  return `node ${process.argv[1]}`;
}

function readSettings(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`Refusing to edit ${path}: ${e?.message ?? e}`);
  }
}

export function installHooks(path = defaultSettingsPath(), command = selfCommand()): string {
  const merged = mergeHooks(readSettings(path), command);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
  return path;
}

export function uninstallHooks(path = defaultSettingsPath()): string {
  writeFileSync(path, JSON.stringify(removeHooks(readSettings(path)), null, 2) + '\n');
  return path;
}
