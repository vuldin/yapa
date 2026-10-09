import { describe, it, expect } from 'vitest';
import { resolveHostEnv } from './env.js';

const claudeConfig = {
  mcpServers: { yapa: { env: { YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: 'postgres://u:p@h/yapa' } } },
  projects: { '/work/acme': { mcpServers: { yapa: { env: { YAPA_USERNAME: 'josh-acme' } } } } },
};

describe('resolveHostEnv', () => {
  it('adopts the yapa server env from ~/.claude.json (claude mcp add installs)', () => {
    expect(resolveHostEnv({}, claudeConfig)).toEqual({
      YAPA_USERNAME: 'josh', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: 'postgres://u:p@h/yapa',
    });
  });

  it('prefers the project-scoped server entry for the hook cwd', () => {
    expect(resolveHostEnv({}, claudeConfig, '/work/acme').YAPA_USERNAME).toBe('josh-acme');
  });

  it('maps plugin options to YAPA_* and lets them beat ~/.claude.json', () => {
    const add = resolveHostEnv({ CLAUDE_PLUGIN_OPTION_USERNAME: 'teammate', CLAUDE_PLUGIN_OPTION_STORAGE: 'local' }, claudeConfig);
    expect(add.YAPA_USERNAME).toBe('teammate');
    expect(add.YAPA_STORAGE).toBe('local');
    expect(add.YAPA_SYNC_DATABASE_URL).toBe('postgres://u:p@h/yapa');
  });

  it('as a plugin hook, never mixes in a legacy `claude mcp add` entry', () => {
    const add = resolveHostEnv({ CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_OPTION_USERNAME: '', CLAUDE_PLUGIN_OPTION_SYNC_ENABLED: 'false' }, claudeConfig);
    expect(add.YAPA_USERNAME).toBeUndefined();
    expect(add.YAPA_SYNC_ENABLED).toBe('false');
    expect(add.YAPA_SYNC_DATABASE_URL).toBeUndefined();
  });

  it('never overrides an explicitly set variable, and skips empty option values', () => {
    const add = resolveHostEnv({ YAPA_USERNAME: 'explicit', CLAUDE_PLUGIN_OPTION_CHROMA_URL: '' }, claudeConfig);
    expect(add.YAPA_USERNAME).toBeUndefined();
    expect(add.YAPA_CHROMA_URL).toBeUndefined();
  });

  it('turns on rules injection and the shared model cache when running as a plugin hook', () => {
    const add = resolveHostEnv({ CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_DATA: '/data' }, undefined);
    expect(add.YAPA_HOOK_INJECT_RULES).toBe('true');
    expect(add.YAPA_MODEL_CACHE_DIR).toBe('/data/models');
    expect(resolveHostEnv({}, undefined).YAPA_HOOK_INJECT_RULES).toBeUndefined();
  });
});
