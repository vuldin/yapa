import { describe, it, expect } from 'vitest';
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

  it('keeps multi-user safety defaults conservative', () => {
    const c = createConfig({});
    expect(c.SYNC_SHARE_GLOBAL).toBe(false);
    expect(c.RESPONSE_CAPTURE).toBe(false);
    expect(c.SYNC_PULL_OVERLAP_SECONDS).toBeGreaterThan(0);
    expect(c.SYNC_PUSH_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});
