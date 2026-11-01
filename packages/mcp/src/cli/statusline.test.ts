import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

import {
  renderSegment, formatAgo, mergeStatusLine, removeStatusLine, isYapaStatusLine, encodeWrapped, installStatusLine,
  uninstallStatusLine, hasStatusLine, type HealthRecord,
} from './statusline.js';

const NOW = new Date(2026, 10, 1, 15, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 10, 1, h, m).getTime();
const rec = (h: Partial<HealthRecord>): HealthRecord => ({ status: 'ok', at: NOW - 60_000, interval_ms: 300_000, label: 'yapa', ...h });

describe('renderSegment', () => {
  it('renders each state', () => {
    expect(renderSegment(rec({ last_ok_at: NOW - 120_000 }), NOW)).toBe('yapa ● synced 2m ago');
    expect(renderSegment(rec({ last_ok_at: NOW - 120_000, unpushed: 3 }), NOW)).toBe('yapa ● synced 2m ago · 3 to push');
    expect(renderSegment(rec({ status: 'signed_out', since: at(9, 12), unpushed: 4 }), NOW))
      .toBe('yapa ● signed out since 09:12 · 4 to push · run: gcloud auth login');
    expect(renderSegment(rec({ status: 'unreachable', since: at(9, 12), unpushed: 4 }), NOW)).toBe('yapa ● offline since 09:12 · 4 to push');
    expect(renderSegment(rec({ status: 'error', since: at(9, 12), message: 'rate limit\nexceeded' }), NOW))
      .toBe('yapa ● sync error since 09:12: rate limit exceeded');
    expect(renderSegment(rec({ status: 'disabled' }), NOW)).toBe('yapa ○ local only');
    expect(renderSegment(undefined, NOW)).toBe('yapa ○ sync status unknown');
  });

  it('an ok record that stopped updating is unknown; a failure stays shown', () => {
    expect(renderSegment(rec({ at: NOW - 3 * 3600_000 }), NOW)).toBe('yapa ○ sync status unknown (last checked 3h ago)');
    expect(renderSegment(rec({ status: 'signed_out', at: NOW - 3 * 3600_000, since: at(9, 12) }), NOW)).toContain('signed out since 09:12');
  });

  it('a failure from an earlier day shows the date', () => {
    expect(renderSegment(rec({ status: 'unreachable', since: new Date(2026, 9, 30, 8, 5).getTime() }), NOW)).toBe('yapa ● offline since Oct 30 08:05');
  });

  it('uses the configured label (record or --label), cleaned', () => {
    expect(renderSegment(rec({ label: 'acme-sync' }), NOW)).toBe('acme-sync ● synced 1m ago');
    expect(renderSegment(rec({ label: 'acme-sync' }), NOW, { label: 'team' })).toBe('team ● synced 1m ago');
    expect(renderSegment(rec({ label: '\x1b[31m ' }), NOW)).toBe('[31m ● synced 1m ago');
    expect(renderSegment(undefined, NOW, { label: 'acme-sync' })).toBe('acme-sync ○ sync status unknown');
  });

  it('colors by state', () => {
    expect(renderSegment(rec({ status: 'signed_out' }), NOW, { color: true })).toMatch(/^\x1b\[31m.*\x1b\[0m$/);
    expect(renderSegment(rec({}), NOW, { color: true })).toMatch(/^\x1b\[32m/);
  });

  it('formats ages', () => {
    expect(formatAgo(10_000)).toBe('just now');
    expect(formatAgo(5 * 60_000)).toBe('5m ago');
    expect(formatAgo(50 * 3600_000)).toBe('2d ago');
  });
});

describe('settings.json', () => {
  const script = '/home/u/.local/share/yapa/statusline.mjs';

  it('adds the status line, and removing it leaves settings as they were', () => {
    const before = { theme: 'dark' };
    const after = mergeStatusLine(before, script);
    expect(after.statusLine).toEqual({ type: 'command', command: `node "${script}"`, refreshInterval: 30 });
    expect(isYapaStatusLine(after.statusLine)).toBe(true);
    expect(removeStatusLine(after)).toEqual(before);
  });

  it('wraps an existing status line and restores it exactly', () => {
    const mine = { type: 'command', command: '~/.claude/my-line.sh', padding: 2, refreshInterval: 5 };
    const after = mergeStatusLine({ statusLine: mine }, script);
    expect(after.statusLine).toEqual({ type: 'command', command: `node "${script}" --wrap ${encodeWrapped(mine)}`, padding: 2, refreshInterval: 5 });
    // Re-installing keeps the original wrapped, not a wrapper of a wrapper.
    expect(mergeStatusLine(after, script)).toEqual(after);
    expect(removeStatusLine(after).statusLine).toEqual(mine);
  });

  it('leaves a status line it did not install alone on uninstall', () => {
    const mine = { statusLine: { type: 'command', command: 'echo hi' } };
    expect(removeStatusLine(mine)).toEqual(mine);
  });

  it('install/uninstall edit the file, and refuse an unparsable one', () => {
    const d = mkdtempSync(join(tmpdir(), 'yapa-sl-'));
    try {
      const path = join(d, 'settings.json');
      writeFileSync(path, JSON.stringify({ hooks: {} }));
      installStatusLine(script, path);
      expect(hasStatusLine(path)).toBe(true);
      uninstallStatusLine(path);
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ hooks: {} });
      writeFileSync(path, '{oops');
      expect(() => installStatusLine(script, path)).toThrow(/Refusing to edit/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('the script as Claude Code runs it', () => {
  let d: string;
  let bundled: string;

  beforeAll(async () => {
    d = mkdtempSync(join(tmpdir(), 'yapa-sl-run-'));
    // The same single-file bundle the plugin ships (it must need nothing else).
    bundled = join(d, 'statusline.mjs');
    await build({ entryPoints: [join(__dirname, 'statusline.ts')], outfile: bundled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  });

  afterAll(() => rmSync(d, { recursive: true, force: true }));

  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bundled, ...args], { input: '{"session_id":"s"}', encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', ...env } });

  it('reads the health file next to itself and exits 0', () => {
    writeFileSync(join(d, 'sync-health.json'), JSON.stringify({ status: 'signed_out', at: Date.now(), since: Date.now(), label: 'acme-sync' }));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^acme-sync ● signed out since \d\d:\d\d · run: gcloud auth login\n$/);
  });

  it('a missing record still prints a line', () => {
    const r = run([], { YAPA_SYNC_HEALTH_FILE: join(d, 'nope.json') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('yapa ○ sync status unknown\n');
  });

  it('runs the wrapped status line first with the same stdin; a failing one is skipped', () => {
    const health = { YAPA_SYNC_HEALTH_FILE: join(d, 'nope.json') };
    const ok = run(['--wrap', encodeWrapped({ type: 'command', command: 'cat; echo' })], health);
    expect(ok.stdout).toBe('{"session_id":"s"}\nyapa ○ sync status unknown\n');
    const bad = run(['--wrap', encodeWrapped({ type: 'command', command: 'echo partial; exit 3' })], health);
    expect(bad.stdout).toBe('yapa ○ sync status unknown\n');
  });

  it('--install points settings at the script itself', () => {
    const settings = join(d, 'settings.json');
    expect(run(['--install', '--settings', settings]).status).toBe(0);
    expect(JSON.parse(readFileSync(settings, 'utf-8')).statusLine.command).toBe(`node "${bundled}"`);
  });
});
