import { describe, it, expect, vi } from 'vitest';
import { userInfo } from 'node:os';
import { createConfig } from './config.js';

describe('createConfig', () => {
  it('treats empty strings as unset (Claude Code substitutes "" for unconfigured plugin options)', () => {
    const c = createConfig({ YAPA_STORAGE: '', YAPA_CHROMA_URL: '', YAPA_SYNC_INTERVAL_MS: '', YAPA_USERNAME: '' });
    expect(c.STORAGE).toBe('chroma');
    expect(c.CHROMA_URL).toBe('http://localhost:8000');
    expect(c.SYNC_INTERVAL_MS).toBe(300000);
    expect(c.USERNAME).toBe(userInfo().username);
  });

  it('defaults the username to the OS login and honors YAPA_USERNAME', () => {
    expect(createConfig({}).USERNAME).toBe(userInfo().username);
    expect(createConfig({ YAPA_USERNAME: 'josh' }).USERNAME).toBe('josh');
  });

  it('keeps the folder rules in the scope file, never in options', () => {
    expect(createConfig({ YAPA_SCOPE_FILE: '/x/scope.json' }).SCOPE_FILE).toBe('/x/scope.json');
    expect(createConfig({}).SCOPE_FILE).toMatch(/yapa-test-scope-\d+\.json$/);
    expect(createConfig({ YAPA_PROJECT_ROOTS: '/srv' })).not.toHaveProperty('PROJECT_ROOTS');
  });

  it('keeps multi-user safety defaults conservative', () => {
    const c = createConfig({});
    expect(c.RESPONSE_CAPTURE).toBe(true);
    expect(c.SYNC_PULL_OVERLAP_SECONDS).toBeGreaterThan(0);
    expect(c.SYNC_PUSH_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});

describe('remote name', () => {
  it('comes from REMOTE_NAME, else a legacy status line name other than yapa', () => {
    expect(createConfig({}).REMOTE_NAME).toBe('');
    expect(createConfig({ YAPA_REMOTE_NAME: ' acme ' }).REMOTE_NAME).toBe('acme');
    expect(createConfig({ YAPA_STATUS_LABEL: 'acme' }).REMOTE_NAME).toBe('acme');
    expect(createConfig({ YAPA_STATUS_LABEL: 'yapa' }).REMOTE_NAME).toBe('');
    expect(createConfig({ YAPA_REMOTE_NAME: 'team', YAPA_STATUS_LABEL: 'old' }).REMOTE_NAME).toBe('team');
    expect(createConfig({ YAPA_STATUSLINE: 'true' }).STATUSLINE).toBe(true);
    expect(createConfig({ YAPA_STATUSLINE: 'false' }).STATUSLINE).toBe(false);
  });
});

describe('shared sync cycle', () => {
  it('is on by default with a 30 s prompt-pull window', () => {
    expect(createConfig({}).SYNC_COORDINATE).toBe(true);
    expect(createConfig({ YAPA_SYNC_COORDINATE: 'false' }).SYNC_COORDINATE).toBe(false);
    expect(createConfig({}).HOOK_PULL_WINDOW_MS).toBe(30000);
    expect(createConfig({ YAPA_HOOK_PULL_WINDOW_MS: '0' }).HOOK_PULL_WINDOW_MS).toBe(0);
  });
});

describe('session summary retention', () => {
  it('defaults to 90 days, and only an explicit 0 keeps summaries forever', () => {
    const days = (v?: string) => createConfig(v === undefined ? {} : { YAPA_SESSION_SUMMARY_RETENTION_DAYS: v }).SESSION_SUMMARY_RETENTION_DAYS;
    expect(days()).toBe(90);
    expect(days('30')).toBe(30);
    expect(days('0')).toBe(0);
    for (const bad of ['ninety', '-5', '1.5', '']) expect(days(bad)).toBe(90);
  });
});
