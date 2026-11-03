import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

import {
  renderSegment, formatAgo, mergeStatusLine, removeStatusLine, isYapaStatusLine, encodeWrapped, installStatusLine,
  uninstallStatusLine, hasStatusLine, readLastWrite, readSessionRecord, sessionInfo, stdinInfo, stdinSession, type HealthRecord,
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
    expect(renderSegment(rec({ remote: 'acme', last_ok_at: NOW - 120_000 }), NOW, v)).toBe('yapa@v1.6.0 <-> acme ● synced 2m ago');
    expect(renderSegment(rec({ label: 'acme' }), NOW, v)).toBe('yapa@v1.6.0 <-> acme ● synced 1m ago'); // an older writer's label
    expect(renderSegment(rec({ label: 'yapa' }), NOW, v)).toBe('yapa@v1.6.0 ● synced 1m ago');
    expect(renderSegment(rec({ remote: 'acme' }), NOW, { ...v, remote: 'team' })).toBe('yapa@v1.6.0 <-> team ● synced 1m ago');
    expect(renderSegment(rec({}), NOW, { ...v, label: 'team' })).toBe('yapa@v1.6.0 <-> team ● synced 1m ago');
    expect(renderSegment(rec({ remote: '\x1b[31m ' }), NOW, v)).toBe('yapa@v1.6.0 <-> [31m ● synced 1m ago');
    expect(renderSegment(undefined, NOW, { ...v, remote: 'acme' })).toBe('yapa@v1.6.0 <-> acme ○ sync status unknown');
  });

  it('says when a newer YAPA is out, right after the version', () => {
    const update = { current: '1.6.0', latest: '1.7.0' };
    expect(renderSegment(rec({ remote: 'acme', last_ok_at: NOW - 120_000 }), NOW, { ...v, update }))
      .toBe('yapa@v1.6.0 (v1.7.0 available) <-> acme ● synced 2m ago');
    expect(renderSegment(rec({}), NOW, { version: '1.7.0', update })).toBe('yapa@v1.7.0 ● synced 1m ago'); // already updated
    expect(renderSegment(rec({}), NOW, { update })).toBe('yapa@v1.6.0 (v1.7.0 available) ● synced 1m ago'); // version from the record
    expect(renderSegment(rec({}), NOW, { ...v, update, color: true })).toContain('\x1b[33m(v1.7.0 available)\x1b[0m');
  });

  it('ends with the collection this session last wrote to, in every state', () => {
    const collection = 'project-acme';
    expect(renderSegment(rec({ remote: 'acme', last_ok_at: NOW - 60_000 }), NOW, { ...v, collection }))
      .toBe('yapa@v1.6.0 <-> acme ● synced 1m ago | project-acme');
    expect(renderSegment(rec({ status: 'signed_out', since: at(9, 12) }), NOW, { ...v, collection }))
      .toBe('yapa@v1.6.0 ● signed out since 09:12 · run: gcloud auth login | project-acme');
    expect(renderSegment(rec({ status: 'disabled' }), NOW, { ...v, collection })).toBe('yapa@v1.6.0 ○ local only | project-acme');
    expect(renderSegment(undefined, NOW, { ...v, collection })).toBe('yapa@v1.6.0 ○ sync status unknown | project-acme');
    // Uncolored, after the colored state; control characters dropped; nothing written yet: no separator.
    expect(renderSegment(rec({}), NOW, { ...v, collection, color: true })).toMatch(/\x1b\[0m \| project-acme$/);
    expect(renderSegment(rec({}), NOW, { ...v, collection: '\x1b[31mproject-acme ' })).toBe('yapa@v1.6.0 ● synced 1m ago | [31mproject-acme');
    expect(renderSegment(rec({}), NOW, { ...v, collection: ' ' })).toBe('yapa@v1.6.0 ● synced 1m ago');
  });

  it("shows this session's own YAPA, and when only a restart loads the installed one", () => {
    const base = rec({ remote: 'acme' });
    expect(renderSegment(base, NOW, { version: '1.10.1', session: { version: '1.10.1' } })).toBe('yapa@v1.10.1 <-> acme ● synced 1m ago');
    expect(renderSegment(base, NOW, { version: '1.10.1', session: { version: '1.8.0' } })).toBe('yapa@v1.8.0 (restart for v1.10.1) <-> acme ● synced 1m ago');
    // No live server reported for a session that has run a while: older than 1.10.1, or none.
    expect(renderSegment(base, NOW, { version: '1.10.1', session: { missing: true } })).toBe('yapa (restart for v1.10.1) <-> acme ● synced 1m ago');
    // A newer release is judged against what is installed.
    expect(renderSegment(base, NOW, { version: '1.10.1', session: { version: '1.8.0' }, update: { current: '1.10.1', latest: '1.11.0' } }))
      .toBe('yapa@v1.8.0 (restart for v1.10.1) (v1.11.0 available) <-> acme ● synced 1m ago');
    expect(renderSegment(base, NOW, { version: '1.10.1', session: { version: '1.8.0' }, color: true })).toContain('\x1b[33m(restart for v1.10.1)\x1b[0m');
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

describe('last-write lookup', () => {
  it('takes the session from the stdin JSON', () => {
    expect(stdinSession('{"session_id":"abc-1","cwd":"/x"}')).toBe('abc-1');
    expect(stdinSession('')).toBeUndefined();
    expect(stdinSession('{"session_id":5}')).toBeUndefined();
  });

  it('reads the newest record among the ids, ignoring bad ids and bad files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-sl-lw-'));
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ collection: 'project-a', at: 5 }));
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ collection: 'project-b', at: 9 }));
      writeFileSync(join(dir, 'c.json'), 'not json');
      expect(readLastWrite(dir, ['a', 'b'])).toEqual({ collection: 'project-b', at: 9 });
      expect(readLastWrite(dir, ['a', undefined, 'c', '../b'])).toEqual({ collection: 'project-a', at: 5 });
      expect(readLastWrite(dir, [undefined])).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session records', () => {
  it('reads the stdin session and its age (cost, else the transcript file)', () => {
    expect(stdinInfo('{"session_id":"a","cost":{"total_duration_ms":5000}}')).toEqual({ session: 'a', ageMs: 5000 });
    expect(stdinInfo('{"session_id":"a","transcript_path":"/nonexistent"}')).toEqual({ session: 'a', ageMs: undefined });
    expect(stdinInfo('nope')).toEqual({});
  });

  it("takes the newest record of a live server, and a session's age decides when none means \"restart\"", () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-sl-sess-'));
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ version: '1.10.1', pid: process.pid, started_at: 2 }));
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ version: '1.10.0', pid: process.pid, started_at: 1 }));
      writeFileSync(join(dir, 'dead.json'), JSON.stringify({ version: '1.9.0', pid: 2 ** 30, started_at: 3 }));
      expect(readSessionRecord(dir, ['a', 'b'])?.version).toBe('1.10.1');
      expect(readSessionRecord(dir, ['dead'])).toBeUndefined();
      expect(sessionInfo(readSessionRecord(dir, ['b']), 5)).toEqual({ version: '1.10.0' });
      expect(sessionInfo(undefined, 10_000)).toBeUndefined(); // just started: its server may not have reported yet
      expect(sessionInfo(undefined, 120_000)).toEqual({ missing: true });
      expect(sessionInfo(undefined, undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    writeFileSync(join(d, 'sync-health.json'), JSON.stringify({ status: 'ok', at: Date.now(), last_ok_at: Date.now(), remote: 'acme', label: 'acme' }));
    writeFileSync(join(d, 'update-check.json'), JSON.stringify({ current: '1.6.0', latest: '1.7.0', checked_at: Date.now() }));
    expect(run().stdout).toBe('yapa@v1.6.0 (v1.7.0 available) <-> acme ● synced just now\n');
    rmSync(join(d, 'update-check.json'));
  });

  it('shows the collection the session last wrote to (stdin session or the id Claude Code started with, newest wins)', () => {
    writeFileSync(join(d, 'sync-health.json'), JSON.stringify({ status: 'ok', at: Date.now(), last_ok_at: Date.now(), remote: 'acme' }));
    mkdirSync(join(d, 'last-write'), { recursive: true });
    const lw = (session: string, collection: string, at: number) =>
      writeFileSync(join(d, 'last-write', `${session}.json`), JSON.stringify({ collection, at }));
    const noEnvSession = { CLAUDE_CODE_SESSION_ID: '' };
    expect(run([], noEnvSession).stdout).toBe('yapa@v1.6.0 <-> acme ● synced just now\n'); // nothing written yet
    lw('s', 'project-acme', 1000);
    expect(run([], noEnvSession).stdout).toBe('yapa@v1.6.0 <-> acme ● synced just now | project-acme\n');
    // After /clear the MCP server still writes under the id the session started with.
    lw('started-as', 'customer-globex', 2000);
    expect(run([], { CLAUDE_CODE_SESSION_ID: 'started-as' }).stdout).toBe('yapa@v1.6.0 <-> acme ● synced just now | customer-globex\n');
    lw('s', 'project-acme', 3000);
    expect(run([], { CLAUDE_CODE_SESSION_ID: 'started-as' }).stdout).toBe('yapa@v1.6.0 <-> acme ● synced just now | project-acme\n');
    rmSync(join(d, 'last-write'), { recursive: true });
  });

  it("shows the session's own server version, or that it needs a restart", () => {
    writeFileSync(join(d, 'sync-health.json'), JSON.stringify({ status: 'ok', at: Date.now(), last_ok_at: Date.now(), remote: 'acme' }));
    mkdirSync(join(d, 'sessions'), { recursive: true });
    const env = { CLAUDE_CODE_SESSION_ID: '' };
    const runAs = (input: string) => spawnSync(process.execPath, [bundled], { input, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', ...env } }).stdout;
    writeFileSync(join(d, 'sessions', 'old.json'), JSON.stringify({ version: '1.5.0', pid: process.pid, started_at: 1 }));
    expect(runAs('{"session_id":"old"}')).toBe('yapa@v1.5.0 (restart for v1.6.0) <-> acme ● synced just now\n');
    expect(runAs('{"session_id":"unreported","cost":{"total_duration_ms":120000}}')).toBe('yapa (restart for v1.6.0) <-> acme ● synced just now\n');
    expect(runAs('{"session_id":"fresh","cost":{"total_duration_ms":3000}}')).toBe('yapa@v1.6.0 <-> acme ● synced just now\n');
    rmSync(join(d, 'sessions'), { recursive: true });
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
