#!/usr/bin/env node
// YAPA's Claude Code status line: one segment with YAPA's version, the team
// remote's name and whether sync with it is healthy, read from the sync
// health file (packages/core sync/health.ts) that the MCP server and hooks
// keep current, plus a note when a newer YAPA is out (update-check.json,
// packages/core update-check.ts). No network, no gcloud: it runs after every
// assistant message.
//
//   yapa@v1.6.0 (v1.7.0 available) <-> acme ● synced 2m ago
//
// `<->` is printed as is, so a font with programming ligatures draws one
// arrow; it appears only when the remote has a name (option remote_name).
// After ` | ` comes the collection this session last wrote to
// (last-write/<session>.json, packages/core last-write.ts), once it has
// written one:
//
//   yapa@v1.8.0 <-> acme ● synced 1m ago | project-acme
//
// SELF-CONTAINED: node built-ins only, no local imports. It is copied as a
// single file to a stable path (~/.local/share/yapa/statusline.mjs) because
// the plugin's own folder is versioned, and settings.json must keep working
// across plugin updates.
//
//   node statusline.mjs                  print the segment (Claude Code runs this)
//   node statusline.mjs --wrap <b64>     run the user's previous status line first
//   node statusline.mjs --install        add it to ~/.claude/settings.json
//   node statusline.mjs --uninstall      remove it (restores a wrapped status line)

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HealthRecord {
  status: 'ok' | 'signed_out' | 'unreachable' | 'error' | 'disabled';
  code?: string;
  message?: string;
  since?: number;
  at: number;
  last_ok_at?: number;
  unpushed?: number;
  interval_ms?: number;
  /** Legacy: the name an older YAPA wrote (STATUS_LABEL); `yapa` means none. */
  label?: string;
  /** The team remote's name (REMOTE_NAME). */
  remote?: string;
}

/** Set by scripts/build-plugin.mjs; the tsc build reads the version from update-check.json instead. */
declare const __YAPA_VERSION__: string | undefined;
export const SCRIPT_VERSION: string | undefined = typeof __YAPA_VERSION__ === 'string' ? __YAPA_VERSION__ : undefined;

export interface UpdateRecord {
  current?: string;
  latest?: string;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** >0 when a is newer (the same rule as core's compareVersions; this file stays self-contained). */
export function newer(a: string | undefined, b: string | undefined): boolean {
  const pa = SEMVER.exec(String(a ?? '').trim());
  const pb = SEMVER.exec(String(b ?? '').trim());
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0;
  }
  if (pa[4] && !pb[4]) return false;
  if (!pa[4] && pb[4]) return true;
  return (pa[4] ?? '') > (pb[4] ?? '');
}

const DEFAULT_INTERVAL_MS = 300_000;
/** An ok record older than this many sync intervals no longer says anything. */
const STALE_INTERVALS = 3;
const WRAP_TIMEOUT_MS = 5000;

const ANSI = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' };
type Tone = 'green' | 'red' | 'yellow' | 'dim';

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "09:12" today, "Oct 30 09:12" before that (local time). */
export function formatSince(at: number, now: number): string {
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date(now).toDateString()) return hhmm;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${hhmm}`;
}

function cleanLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  const v = label.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
  return v || undefined;
}

/** The remote's name: an explicit one, else the record's (a legacy `label` other than yapa counts). */
function remoteName(health: HealthRecord | undefined, explicit?: string): string | undefined {
  const legacy = cleanLabel(health?.label);
  return cleanLabel(explicit) ?? cleanLabel(health?.remote) ?? (legacy && legacy !== 'yapa' ? legacy : undefined);
}

export interface RenderOptions {
  color?: boolean;
  /** The remote's name (overrides the record's). */
  remote?: string;
  /** Legacy alias of `remote`. */
  label?: string;
  /** The YAPA version running (default: this script's own). */
  version?: string;
  /** What update-check.json says. */
  update?: UpdateRecord;
  /** The collection this session last wrote to. */
  collection?: string;
  /**
   * What this session's own YAPA server reported (sessions/<id>.json):
   * `version` when a live server recorded one; `missing` when the session has
   * run a while and no live server reported (an older YAPA, or none).
   */
  session?: { version?: string; missing?: boolean };
}

/** The segment for `health` (undefined: no record yet). */
export function renderSegment(health: HealthRecord | undefined, now: number, opts: RenderOptions = {}): string {
  const paint = (tone: Tone, text: string) => (opts.color ? `${ANSI[tone]}${text}${ANSI.reset}` : text);
  const installed = opts.version ?? SCRIPT_VERSION ?? opts.update?.current;
  // The version this session runs, when its server said; else what is installed.
  const running = opts.session?.version ?? installed;
  // Installed is newer than what this session runs (or this session's server
  // never reported): only a restart loads it.
  const restart = installed && (opts.session?.missing || (opts.session?.version && newer(installed, opts.session.version))) ? installed : undefined;
  const latest = opts.update?.latest && installed && newer(opts.update.latest, installed) ? opts.update.latest : undefined;
  const remote = remoteName(health, opts.remote ?? opts.label);
  const shown = opts.session?.missing ? 'yapa' : `yapa${running ? `@v${running}` : ''}`;
  const head = shown
    + (restart ? ` ${paint('yellow', `(restart for v${restart})`)}` : '')
    + (latest ? ` ${paint('yellow', `(v${latest} available)`)}` : '')
    + (remote ? ` <-> ${remote}` : '');
  const push = health?.unpushed ? ` · ${health.unpushed} to push` : '';
  const since = health?.since ? ` since ${formatSince(health.since, now)}` : '';
  const tail = cleanCollection(opts.collection);
  const state = (tone: Tone, text: string) => `${head} ${paint(tone, text)}${tail ? ` | ${tail}` : ''}`;

  if (!health) return state('dim', '○ sync status unknown');
  switch (health.status) {
    case 'disabled':
      return state('dim', '○ local only');
    case 'signed_out':
      return state('red', `● signed out${since}${push} · run: gcloud auth login`);
    case 'unreachable':
      return state('yellow', `● offline${since}${push}`);
    case 'error': {
      const why = health.message ? `: ${health.message.replace(/\s+/g, ' ').slice(0, 60)}` : '';
      return state('yellow', `● sync error${since}${why}`);
    }
    case 'ok': {
      const interval = health.interval_ms && health.interval_ms > 0 ? health.interval_ms : DEFAULT_INTERVAL_MS;
      if (now - health.at > STALE_INTERVALS * interval) {
        return state('dim', `○ sync status unknown (last checked ${formatAgo(now - health.at)})`);
      }
      return state('green', `● synced ${formatAgo(now - (health.last_ok_at ?? health.at))}${push}`);
    }
    default:
      return state('dim', '○ sync status unknown');
  }
}

function cleanCollection(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const v = name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  return v || undefined;
}

export interface LastWrite {
  collection: string;
  at: number;
}

/** The newest last-write record among `sessions` (the same file names as core's lastWriteFile). */
export function readLastWrite(dir: string, sessions: Array<string | undefined>): LastWrite | undefined {
  let best: LastWrite | undefined;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, `${s.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), 'utf-8'));
      if (r && typeof r.collection === 'string' && typeof r.at === 'number' && (!best || r.at > best.at)) best = r;
    } catch {
      // none for this id
    }
  }
  return best;
}

/** `session_id` from the JSON Claude Code sends the status line on stdin. */
export function stdinSession(input: string): string | undefined {
  return stdinInfo(input).session;
}

/** What the status line needs from Claude Code's stdin JSON: the session, and how long it has run (ms). */
export function stdinInfo(input: string, now = Date.now()): { session?: string; ageMs?: number } {
  let j: any;
  try {
    j = JSON.parse(input);
  } catch {
    return {};
  }
  const session = typeof j?.session_id === 'string' ? j.session_id : undefined;
  let ageMs: number | undefined = typeof j?.cost?.total_duration_ms === 'number' ? j.cost.total_duration_ms : undefined;
  if (ageMs === undefined && typeof j?.transcript_path === 'string') {
    try {
      const born = statSync(j.transcript_path).birthtimeMs;
      if (born > 0) ageMs = now - born;
    } catch {
      // no transcript yet
    }
  }
  return { session, ageMs };
}

export interface SessionRecord {
  version: string;
  pid: number;
  started_at: number;
}

/** Is that process alive? EPERM means it exists but belongs to someone else. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The newest record among `sessions` whose server is still running (the same file names as core's sessionRecordFile). */
export function readSessionRecord(dir: string, sessions: Array<string | undefined>): SessionRecord | undefined {
  let best: SessionRecord | undefined;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, `${s.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), 'utf-8'));
      if (r && typeof r.version === 'string' && typeof r.pid === 'number' && alive(r.pid) && (!best || r.started_at > best.started_at)) best = r;
    } catch {
      // none for this id
    }
  }
  return best;
}

/** A session this old without a live server record runs a YAPA too old to report one (or none). */
export const SESSION_REPORT_GRACE_MS = 60_000;

/** What to tell renderSegment about this session's own server. */
export function sessionInfo(record: SessionRecord | undefined, ageMs: number | undefined): RenderOptions['session'] {
  if (record) return { version: record.version };
  if (ageMs !== undefined && ageMs > SESSION_REPORT_GRACE_MS) return { missing: true };
  return undefined;
}

export function readUpdate(path: string): UpdateRecord | undefined {
  try {
    const u = JSON.parse(readFileSync(path, 'utf-8'));
    return u && typeof u === 'object' ? { current: typeof u.current === 'string' ? u.current : undefined, latest: typeof u.latest === 'string' ? u.latest : undefined } : undefined;
  } catch {
    return undefined;
  }
}

export function readHealth(path: string): HealthRecord | undefined {
  try {
    const h = JSON.parse(readFileSync(path, 'utf-8'));
    return h && typeof h.status === 'string' && typeof h.at === 'number' ? h : undefined;
  } catch {
    return undefined;
  }
}

// --- settings.json --------------------------------------------------------

/** The user's own status line, kept inside ours so uninstall can put it back. */
export function encodeWrapped(statusLine: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(statusLine)).toString('base64url');
}

export function decodeWrapped(b64: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Is this YAPA's status line? `script` also recognizes a copy kept outside a yapa/ folder. */
export function isYapaStatusLine(statusLine: any, script?: string): boolean {
  if (typeof statusLine?.command !== 'string') return false;
  return /yapa[\\/]statusline\.mjs/.test(statusLine.command) || (!!script && statusLine.command.includes(`"${script}"`));
}

function wrappedOf(statusLine: any): Record<string, any> | undefined {
  const m = typeof statusLine?.command === 'string' ? statusLine.command.match(/--wrap\s+([A-Za-z0-9_-]+)/) : null;
  return m ? decodeWrapped(m[1]) : undefined;
}

/** `settings` with YAPA's status line running `script`; an existing status line is wrapped, not replaced. */
export function mergeStatusLine(settings: Record<string, any>, script: string, refreshInterval = 30): Record<string, any> {
  const next = structuredClone(settings ?? {});
  const current = next.statusLine;
  const wrapped = isYapaStatusLine(current, script) ? wrappedOf(current) : current && typeof current === 'object' ? current : undefined;
  let command = `node "${script}"`;
  if (wrapped) command += ` --wrap ${encodeWrapped(wrapped)}`;
  next.statusLine = {
    ...(wrapped ?? {}),
    type: 'command',
    command,
    refreshInterval: Math.min(Number(wrapped?.refreshInterval) || refreshInterval, refreshInterval),
  };
  return next;
}

/** `settings` without YAPA's status line: the wrapped one is restored as it was. */
export function removeStatusLine(settings: Record<string, any>, script?: string): Record<string, any> {
  const next = structuredClone(settings ?? {});
  if (!isYapaStatusLine(next.statusLine, script)) return next;
  const wrapped = wrappedOf(next.statusLine);
  if (wrapped) next.statusLine = wrapped;
  else delete next.statusLine;
  return next;
}

export function defaultSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
}

function readSettings(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    throw new Error(`Refusing to edit ${path}: ${e?.message ?? e}`);
  }
}

function writeSettings(path: string, settings: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, path);
}

export function installStatusLine(script: string, path = defaultSettingsPath()): string {
  writeSettings(path, mergeStatusLine(readSettings(path), script));
  return path;
}

export function uninstallStatusLine(path = defaultSettingsPath(), script?: string): string {
  writeSettings(path, removeStatusLine(readSettings(path), script));
  return path;
}

/** Is YAPA's status line configured in `path`? (false when unreadable) */
export function hasStatusLine(path = defaultSettingsPath(), script?: string): boolean {
  try {
    return isYapaStatusLine(JSON.parse(readFileSync(path, 'utf-8')).statusLine, script);
  } catch {
    return false;
  }
}

/** Copy the script to its stable path when missing or different. Returns true if it wrote. */
export function copyScript(from: string, to: string): boolean {
  let src: Buffer;
  try {
    src = readFileSync(from);
  } catch {
    return false;
  }
  try {
    if (readFileSync(to).equals(src)) return false;
  } catch {
    // not there yet
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
  return true;
}

/**
 * `statusline-removed` beside the script: the user took YAPA's status line
 * out, so the session-start hook never adds it back (option statusline).
 */
export const REMOVED_MARKER = 'statusline-removed';

export function setRemovedMarker(dir: string, removed: boolean): void {
  const p = join(dir, REMOVED_MARKER);
  try {
    if (removed) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(p, `${new Date().toISOString()}\n`);
    } else {
      rmSync(p, { force: true });
    }
  } catch {
    // best effort
  }
}

// --- main -----------------------------------------------------------------

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** Status line entry point. Always exits 0: a failing status line blanks the whole row. */
export async function main(args: string[], self: string): Promise<void> {
  const settings = argValue(args, '--settings');
  if (args.includes('--install')) {
    process.stdout.write(`Status line added to ${installStatusLine(self, settings)}\n`);
    setRemovedMarker(dirname(self), false);
    return;
  }
  if (args.includes('--uninstall')) {
    process.stdout.write(`Status line removed from ${uninstallStatusLine(settings, self)}\n`);
    // Removed on purpose: the session-start hook must not add it back.
    setRemovedMarker(dirname(self), true);
    return;
  }

  const input = await readStdin();
  const wrapped = argValue(args, '--wrap');
  const previous = wrapped ? decodeWrapped(wrapped) : undefined;
  if (typeof previous?.command === 'string') {
    const r = spawnSync(previous.command, { shell: true, input, encoding: 'utf-8', timeout: WRAP_TIMEOUT_MS });
    const out = (r.stdout ?? '').replace(/\s+$/, '');
    if (r.status === 0 && out) process.stdout.write(out + '\n');
  }

  const healthPath = process.env.YAPA_SYNC_HEALTH_FILE || join(dirname(self), 'sync-health.json');
  const update = readUpdate(join(dirname(healthPath), 'update-check.json'));
  // The session on stdin, and the id Claude Code started with (the MCP server
  // keeps that one after /clear): whichever wrote last.
  const info = stdinInfo(input);
  const ids = [info.session, process.env.CLAUDE_CODE_SESSION_ID];
  const last = readLastWrite(join(dirname(healthPath), 'last-write'), ids);
  const session = sessionInfo(readSessionRecord(join(dirname(healthPath), 'sessions'), ids), info.ageMs);
  const color = !process.env.NO_COLOR;
  process.stdout.write(renderSegment(readHealth(healthPath), Date.now(), {
    color, remote: argValue(args, '--remote') ?? argValue(args, '--label'), update, collection: last?.collection, session,
  }) + '\n');
}

// Run only as the script itself: the CLI bundle imports these functions too.
// Compare real paths: node reports the main module's resolved path, and the
// path Claude Code runs may go through a symlink (macOS /var -> /private/var).
function isMain(argv1: string | undefined, self: string): boolean {
  if (!argv1 || !/statusline\.m?js$/.test(self)) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(self);
  } catch {
    return false;
  }
}

const self = fileURLToPath(import.meta.url);
if (isMain(process.argv[1], self)) {
  main(process.argv.slice(2), self).catch(() => process.stdout.write(`yapa${SCRIPT_VERSION ? `@v${SCRIPT_VERSION}` : ''} ○ sync status unknown\n`));
}
