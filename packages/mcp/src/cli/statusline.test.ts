import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
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
  const v = { version: '1.6.0' };
  it('renders each state, after yapa@v<version>', () => {
    expect(renderSegment(rec({ last_ok_at: NOW - 120_000 }), NOW, v)).toBe('yapa@v1.6.0 ● synced 2m ago');
    expect(renderSegment(rec({ last_ok_at: NOW - 120_000, unpushed: 3 }), NOW, v)).toBe('yapa@v1.6.0 ● synced 2m ago · 3 to push');
    expect(renderSegment(rec({ status: 'signed_out', since: at(9, 12), unpushed: 4 }), NOW, v))
      .toBe('yapa@v1.6.0 ● signed out since 09:12 · 4 to push · run: gcloud auth login');
    expect(renderSegment(rec({ status: 'unreachable', since: at(9, 12), unpushed: 4 }), NOW, v)).toBe('yapa@v1.6.0 ● offline since 09:12 · 4 to push');
    expect(renderSegment(rec({ status: 'error', since: at(9, 12), message: 'rate limit\nexceeded' }), NOW, v))
      .toBe('yapa@v1.6.0 ● sync error since 09:12: rate limit exceeded');
    expect(renderSegment(rec({ status: 'disabled' }), NOW, v)).toBe('yapa@v1.6.0 ○ local only');
    expect(renderSegment(undefined, NOW, v)).toBe('yapa@v1.6.0 ○ sync status unknown');
  });

  it('names the remote only when one is set: yapa@v<version> <-> <remote>', () => {
    expect(renderSegment(rec({ remote: 'c360', last_ok_at: NOW - 120_000 }), NOW, v)).toBe('yapa@v1.6.0 <-> c360 ● synced 2m ago');
    expect(renderSegment(rec({ label: 'c360' }), NOW, v)).toBe('yapa@v1.6.0 <-> c360 ● synced 1m ago'); // an older writer's label
    expect(renderSegment(rec({ label: 'yapa' }), NOW, v)).toBe('yapa@v1.6.0 ● synced 1m ago');
    expect(renderSegment(rec({ remote: 'c360' }), NOW, { ...v, remote: 'team' })).toBe('yapa@v1.6.0 <-> team ● synced 1m ago');
    expect(renderSegment(rec({}), NOW, { ...v, label: 'team' })).toBe('yapa@v1.6.0 <-> team ● synced 1m ago');
    expect(renderSegment(rec({ remote: '\x1b[31m ' }), NOW, v)).toBe('yapa@v1.6.0 <-> [31m ● synced 1m ago');
    expect(renderSegment(undefined, NOW, { ...v, remote: 'c360' })).toBe('yapa@v1.6.0 <-> c360 ○ sync status unknown');
  });

  it('says when a newer YAPA is out, right after the version', () => {
    const update = { current: '1.6.0', latest: '1.7.0' };
    expect(renderSegment(rec({ remote: 'c360', last_ok_at: NOW - 120_000 }), NOW, { ...v, update }))
      .toBe('yapa@v1.6.0 (v1.7.0 available) <-> c360 ● synced 2m ago');
    expect(renderSegment(rec({}), NOW, { version: '1.7.0', update })).toBe('yapa@v1.7.0 ● synced 1m ago'); // already updated
    expect(renderSegment(rec({}), NOW, { update })).toBe('yapa@v1.6.0 (v1.7.0 available) ● synced 1m ago'); // version from the record
    expect(renderSegment(rec({}), NOW, { ...v, update, color: true })).toContain('\x1b[33m(v1.7.0 available)\x1b[0m');
  });

  it('an ok record that stopped updating is unknown; a failure stays shown', () => {
    expect(renderSegment(rec({ at: NOW - 3 * 3600_000 }), NOW, v)).toBe('yapa@v1.6.0 ○ sync status unknown (last checked 3h ago)');
    expect(renderSegment(rec({ status: 'signed_out', at: NOW - 3 * 3600_000, since: at(9, 12) }), NOW, v)).toContain('signed out since 09:12');
  });

  it('a failure from an earlier day shows the date', () => {
    expect(renderSegment(rec({ status: 'unreachable', since: new Date(2026, 9, 30, 8, 5).getTime() }), NOW, v)).toBe('yapa@v1.6.0 ● offline since Oct 30 08:05');
  });

  it('colors the state', () => {
    expect(renderSegment(rec({ status: 'signed_out' }), NOW, { ...v, color: true })).toMatch(/^yapa@v1\.6\.0 \x1b\[31m.*\x1b\[0m$/);
    expect(renderSegment(rec({}), NOW, { ...v, color: true })).toMatch(/^yapa@v1\.6\.0 \x1b\[32m/);
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
  const cleanup: string[] = [];

  beforeAll(async () => {
    // Through a symlink, as on macOS (/var -> /private/var) or a linked home dir.
    const real = mkdtempSync(join(tmpdir(), 'yapa-sl-run-'));
    d = `${real}-link`;
    symlinkSync(real, d);
    cleanup.push(real, d);
    // The same single-file bundle the plugin ships (it must need nothing else).
    bundled = join(d, 'statusline.mjs');
    await build({
      entryPoints: [join(__dirname, 'statusline.ts')], outfile: bundled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      define: { __YAPA_VERSION__: JSON.stringify('1.6.0') }, // as scripts/build-plugin.mjs does
    });
  });

  afterAll(() => { for (const p of cleanup) rmSync(p, { recursive: true, force: true }); });

  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bundled, ...args], { input: '{"session_id":"s"}', encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', ...env } });

  it('reads the health file next to itself and exits 0', () => {
    writeFileSync(join(d, 'sync-health.json'), JSON.stringify({ status: 'signed_out', at: Date.now(), since: Date.now(), label: 'acme-sync' }));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^yapa@v1\.6\.0 <-> acme-sync ● signed out since \d\d:\d\d · run: gcloud auth login\n$/);
  });

  it('shows a newer release from update-check.json beside the health file', () => {
    writeFileSync(join(d, 'sync-health.json'), JSON.stringify({ status: 'ok', at: Date.now(), last_ok_at: Date.now(), remote: 'c360', label: 'c360' }));
    writeFileSync(join(d, 'update-check.json'), JSON.stringify({ current: '1.6.0', latest: '1.7.0', checked_at: Date.now() }));
    expect(run().stdout).toBe('yapa@v1.6.0 (v1.7.0 available) <-> c360 ● synced just now\n');
    rmSync(join(d, 'update-check.json'));
  });

  it('a missing record still prints a line', () => {
    const r = run([], { YAPA_SYNC_HEALTH_FILE: join(d, 'nope.json') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('yapa@v1.6.0 ○ sync status unknown\n');
  });

  it('runs the wrapped status line first with the same stdin; a failing one is skipped', () => {
    const health = { YAPA_SYNC_HEALTH_FILE: join(d, 'nope.json') };
    const ok = run(['--wrap', encodeWrapped({ type: 'command', command: 'cat; echo' })], health);
    expect(ok.stdout).toBe('{"session_id":"s"}\nyapa@v1.6.0 ○ sync status unknown\n');
    const bad = run(['--wrap', encodeWrapped({ type: 'command', command: 'echo partial; exit 3' })], health);
    expect(bad.stdout).toBe('yapa@v1.6.0 ○ sync status unknown\n');
  });

  it('--install points settings at the script itself', () => {
    const settings = join(d, 'settings.json');
    expect(run(['--install', '--settings', settings]).status).toBe(0);
    expect(JSON.parse(readFileSync(settings, 'utf-8')).statusLine.command).toBe(`node "${realpathSync(bundled)}"`);
  });
});
