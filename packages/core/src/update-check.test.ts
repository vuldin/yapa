import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, resetConfig, setConfig } from './config.js';
import { checkForUpdate, compareVersions, markUpdateNotified, noteInstalledVersion, readUpdateState, UPDATE_CHECK_INTERVAL_MS } from './update-check.js';

const dir = mkdtempSync(join(tmpdir(), 'yapa-update-'));
const path = join(dir, 'update-check.json');
const released = (version: unknown, ok = true) =>
  (async () => ({ ok, json: async () => ({ version }) })) as unknown as typeof fetch;
let calls = 0;
const counting = (version: string) => (async () => { calls++; return { ok: true, json: async () => ({ version }) }; }) as unknown as typeof fetch;

beforeEach(() => {
  rmSync(path, { force: true });
  calls = 0;
  setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json'), YAPA_UPDATE_CHECK: 'true' }));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
});

describe('compareVersions', () => {
  it('orders semver, with a release newer than its prerelease', () => {
    expect(compareVersions('1.7.0', '1.6.0')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.6.0', '1.6.0')).toBe(0);
    expect(compareVersions('1.7.0', '1.7.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('junk', '1.0.0')).toBeLessThan(0);
  });
});

describe('checkForUpdate', () => {
  it('records a newer release, and nothing for the same or an older one', async () => {
    expect((await checkForUpdate('1.6.0', { fetchImpl: released('1.7.0'), path }))?.latest).toBe('1.7.0');
    expect((await checkForUpdate('1.6.0', { fetchImpl: released('1.6.0'), path, force: true }))?.latest).toBeUndefined();
    expect((await checkForUpdate('1.6.0', { fetchImpl: released('1.5.0'), path, force: true }))?.latest).toBeUndefined();
  });

  it('checks at most once a day', async () => {
    await checkForUpdate('1.6.0', { fetchImpl: counting('1.7.0'), path, now: 1_000 });
    await checkForUpdate('1.6.0', { fetchImpl: counting('1.7.0'), path, now: 2_000 });
    expect(calls).toBe(1);
    await checkForUpdate('1.6.0', { fetchImpl: counting('1.7.0'), path, now: 1_000 + UPDATE_CHECK_INTERVAL_MS });
    expect(calls).toBe(2);
  });

  it('keeps the last answer when the check fails or the manifest is malformed', async () => {
    await checkForUpdate('1.6.0', { fetchImpl: released('1.7.0'), path, now: 1 });
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await checkForUpdate('1.6.0', { fetchImpl: failing, path, force: true }))?.latest).toBe('1.7.0');
    expect((await checkForUpdate('1.6.0', { fetchImpl: released({ x: 1 }), path, force: true }))?.latest).toBe('1.7.0');
    expect((await checkForUpdate('1.6.0', { fetchImpl: released('1.8.0', false), path, force: true }))?.latest).toBe('1.7.0');
  });

  it('clears the note once the installed version catches up', async () => {
    await checkForUpdate('1.6.0', { fetchImpl: released('1.7.0'), path });
    expect(noteInstalledVersion('1.7.0', path)?.latest).toBeUndefined();
    expect(readUpdateState(path)?.current).toBe('1.7.0');
  });

  it('remembers which version was told, once', async () => {
    await checkForUpdate('1.6.0', { fetchImpl: released('1.7.0'), path });
    markUpdateNotified('1.7.0', path);
    expect(readUpdateState(path)?.notified).toBe('1.7.0');
    expect((await checkForUpdate('1.6.0', { fetchImpl: released('1.7.0'), path, force: true }))?.notified).toBe('1.7.0');
    expect((await checkForUpdate('1.6.0', { fetchImpl: released('1.8.0'), path, force: true }))?.notified).toBeUndefined();
  });

  it('does nothing when checks are off', async () => {
    setConfig(createConfig({ YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json'), YAPA_UPDATE_CHECK: 'false' }));
    expect(await checkForUpdate('1.6.0', { fetchImpl: counting('9.9.9'), path })).toBeUndefined();
    expect(calls).toBe(0);
  });
});
