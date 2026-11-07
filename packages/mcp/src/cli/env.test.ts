import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyScope, pluginSettingsEnv, resolveHostEnv } from './env.js';

describe('pluginSettingsEnv (yapa coord from a plain shell)', () => {
  const settings = {
    enabledPlugins: { 'yapa@yapa': true },
    pluginConfigs: { 'yapa@yapa': { options: { sync_enabled: true, sync_service_url: 'https://svc.example', username: '', status_label: 'team' } } },
  };

  it('maps the enabled plugin options to YAPA_* (booleans as strings, empty values skipped)', () => {
    expect(pluginSettingsEnv({}, settings)).toEqual({ YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://svc.example', YAPA_STATUS_LABEL: 'team' });
  });

  it('passes a path option through like any other', () => {
    const withCa = { ...settings, pluginConfigs: { 'yapa@yapa': { options: { sync_ca_cert: '~/certs/ca=1.pem' } } } };
    expect(pluginSettingsEnv({}, withCa)).toEqual({ YAPA_SYNC_CA_CERT: '~/certs/ca=1.pem' });
    expect(resolveHostEnv({ CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_OPTION_SYNC_CA_CERT: '~/certs/ca=1.pem' }, undefined).YAPA_SYNC_CA_CERT)
      .toBe('~/certs/ca=1.pem');
  });

  it('never overrides explicit env, and ignores a disabled or absent plugin', () => {
    expect(pluginSettingsEnv({ YAPA_SYNC_SERVICE_URL: 'http://local' }, settings).YAPA_SYNC_SERVICE_URL).toBeUndefined();
    expect(pluginSettingsEnv({}, { ...settings, enabledPlugins: { 'yapa@yapa': false } })).toEqual({});
    expect(pluginSettingsEnv({}, {})).toEqual({});
  });
});

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

  it('shares the model cache with the plugin\'s server when running as a plugin hook', () => {
    const add = resolveHostEnv({ CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_DATA: '/data' }, undefined);
    expect(add.YAPA_MODEL_CACHE_DIR).toBe('/data/models');
    expect(resolveHostEnv({}, undefined).YAPA_MODEL_CACHE_DIR).toBeUndefined();
  });
});

describe('adoptLegacyScope (upgrading from the folder options)', () => {
  it('moves the plugin options from Claude Code settings into the scope file once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-legacy-scope-'));
    try {
      mkdirSync(join(dir, 'claude'));
      writeFileSync(join(dir, 'claude', 'settings.json'), JSON.stringify({
        enabledPlugins: { 'yapa@yapa': true },
        pluginConfigs: { 'yapa@yapa': { options: { project_roots: '/srv/projects', collection_map: '/srv/projects/notes=private-notes;/srv/globex=private-globex' } } },
      }));
      const env = { CLAUDE_CONFIG_DIR: join(dir, 'claude'), YAPA_SCOPE_FILE: join(dir, 'scope.json'), YAPA_CUSTOMERS: 'acme' };
      expect(adoptLegacyScope(env)).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8'))).toEqual({
        project_roots: ['/srv/projects'],
        customers: ['acme'],
        collection_map: { '/srv/projects/notes': 'private-notes', '/srv/globex': 'private-globex' },
        records_elsewhere: [],
      });
      expect(adoptLegacyScope(env)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing without old options', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-legacy-scope-'));
    try {
      expect(adoptLegacyScope({ CLAUDE_CONFIG_DIR: join(dir, 'none'), YAPA_SCOPE_FILE: join(dir, 'scope.json') })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
