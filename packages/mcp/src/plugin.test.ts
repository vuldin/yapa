import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConfig } from '@yapa/core';
import { HOOK_EVENTS } from './cli/install-hooks.js';

const repo = join(__dirname, '..', '..', '..');
const plugin = join(repo, 'plugin');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

const manifest = json(join(plugin, '.claude-plugin', 'plugin.json'));
const mcp = json(join(plugin, '.mcp.json'));
const serverEnv: Record<string, string> = mcp.mcpServers.yapa.env;

describe('Claude Code plugin packaging', () => {
  it('passes every userConfig option to the MCP server as YAPA_<KEY>', () => {
    for (const key of Object.keys(manifest.userConfig)) {
      expect(serverEnv[`YAPA_${key.toUpperCase()}`]).toBe(`\${user_config.${key}}`);
    }
  });

  it('maps every option onto a real config field (and hooks get the same name via CLAUDE_PLUGIN_OPTION_*)', () => {
    const defaults = createConfig({});
    for (const [key, option] of Object.entries<any>(manifest.userConfig)) {
      const field = key.toUpperCase();
      expect(field in defaults, `${field} missing from YapaConfig`).toBe(true);
      const current = (defaults as any)[field];
      const sample = option.type === 'boolean'
        ? String(!current)
        : option.options?.find((o: string) => o !== current) ?? 'x';
      const parsed = (createConfig({ [`YAPA_${field}`]: sample }) as any)[field];
      expect(parsed, `YAPA_${field} not read by createConfig`).not.toEqual((defaults as any)[field]);
    }
  });

  it('keeps hooks/hooks.json in sync with the CLI hook table', () => {
    const hooks = json(join(plugin, 'hooks', 'hooks.json')).hooks;
    expect(Object.keys(hooks).sort()).toEqual(HOOK_EVENTS.map(h => h.event).sort());
    for (const { event, sub, async } of HOOK_EVENTS) {
      const [hook] = hooks[event][0].hooks;
      expect(hook.command).toBe(`node "\${CLAUDE_PLUGIN_ROOT}/dist/yapa.mjs" hook ${sub}`);
      expect(Boolean(hook.async)).toBe(Boolean(async));
    }
  });

  it('ships a bundle plus a lockfile for every runtime dependency it leaves external', () => {
    expect(existsSync(join(plugin, 'dist', 'yapa-mcp.mjs'))).toBe(true);
    expect(existsSync(join(plugin, 'dist', 'yapa.mjs'))).toBe(true);
    expect(existsSync(join(plugin, 'package-lock.json'))).toBe(true);
    const core = json(join(repo, 'packages', 'core', 'package.json'));
    expect(json(join(plugin, 'package.json')).dependencies).toEqual(core.dependencies);
  });

  it('is listed in the repo marketplace at the right path', () => {
    const market = json(join(repo, '.claude-plugin', 'marketplace.json'));
    const entry = market.plugins.find((p: any) => p.name === manifest.name);
    expect(entry.source).toBe('./plugin');
  });
});
