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

  it('parses list settings and expands ~ in project roots', () => {
    const c = createConfig({ YAPA_PROJECT_ROOTS: '~/work/, /srv/projects', YAPA_CUSTOMERS: 'acme, globex' });
    expect(c.PROJECT_ROOTS).toEqual([`${process.env.HOME}/work`, '/srv/projects']);
    expect(c.CUSTOMERS).toEqual(['acme', 'globex']);
  });

  it('parses the collection map: ";" or newline separated path=collection entries, ~ expanded, paths resolved', () => {
    expect(createConfig({}).COLLECTION_MAP).toEqual([]);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const c = createConfig({ YAPA_COLLECTION_MAP: '~/work/acme/ = private-acme; /srv/x/../y//=local-y\n/srv/a:b,c=private-ab;typo' });
      expect(c.COLLECTION_MAP).toEqual([`${process.env.HOME}/work/acme=private-acme`, '/srv/y=local-y', '/srv/a:b,c=private-ab']);
    } finally {
      err.mockRestore();
    }
    expect(createConfig({ COLLECTION_MAP: '/a=private-a' }).COLLECTION_MAP).toEqual(['/a=private-a']);
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
