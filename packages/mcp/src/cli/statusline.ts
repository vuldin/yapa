#!/usr/bin/env node
// YAPA's Claude Code status line: one segment saying whether team sync is
// healthy, read from the sync health file (packages/core sync/health.ts)
// that the MCP server and hooks keep current. No network, no gcloud: it runs
// after every assistant message.
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
import { copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
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
  label?: string;
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

/** The segment for `health` (undefined: no record yet). `label` overrides the record's. */
export function renderSegment(health: HealthRecord | undefined, now: number, opts: { color?: boolean; label?: string } = {}): string {
  const name = cleanLabel(opts.label) ?? cleanLabel(health?.label) ?? 'yapa';
  const paint = (tone: Tone, text: string) => (opts.color ? `${ANSI[tone]}${text}${ANSI.reset}` : text);
  const push = health?.unpushed ? ` · ${health.unpushed} to push` : '';
  const since = health?.since ? ` since ${formatSince(health.since, now)}` : '';

  if (!health) return paint('dim', `${name} ○ sync status unknown`);
  switch (health.status) {
    case 'disabled':
      return paint('dim', `${name} ○ local only`);
    case 'signed_out':
      return paint('red', `${name} ● signed out${since}${push} · run: gcloud auth login`);
    case 'unreachable':
      return paint('yellow', `${name} ● offline${since}${push}`);
    case 'error': {
      const why = health.message ? `: ${health.message.replace(/\s+/g, ' ').slice(0, 60)}` : '';
      return paint('yellow', `${name} ● sync error${since}${why}`);
    }
    case 'ok': {
      const interval = health.interval_ms && health.interval_ms > 0 ? health.interval_ms : DEFAULT_INTERVAL_MS;
      if (now - health.at > STALE_INTERVALS * interval) {
        return paint('dim', `${name} ○ sync status unknown (last checked ${formatAgo(now - health.at)})`);
      }
      return paint('green', `${name} ● synced ${formatAgo(now - (health.last_ok_at ?? health.at))}${push}`);
    }
    default:
      return paint('dim', `${name} ○ sync status unknown`);
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

export function isYapaStatusLine(statusLine: any): boolean {
  return typeof statusLine?.command === 'string' && /yapa[\\/]statusline\.mjs/.test(statusLine.command);
}

function wrappedOf(statusLine: any): Record<string, any> | undefined {
  const m = typeof statusLine?.command === 'string' ? statusLine.command.match(/--wrap\s+([A-Za-z0-9_-]+)/) : null;
  return m ? decodeWrapped(m[1]) : undefined;
}

/** `settings` with YAPA's status line running `script`; an existing status line is wrapped, not replaced. */
export function mergeStatusLine(settings: Record<string, any>, script: string, refreshInterval = 30): Record<string, any> {
  const next = structuredClone(settings ?? {});
  const current = next.statusLine;
  const wrapped = isYapaStatusLine(current) ? wrappedOf(current) : current && typeof current === 'object' ? current : undefined;
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
export function removeStatusLine(settings: Record<string, any>): Record<string, any> {
  const next = structuredClone(settings ?? {});
  if (!isYapaStatusLine(next.statusLine)) return next;
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

export function uninstallStatusLine(path = defaultSettingsPath()): string {
  writeSettings(path, removeStatusLine(readSettings(path)));
  return path;
}

/** Is YAPA's status line configured in `path`? (false when unreadable) */
export function hasStatusLine(path = defaultSettingsPath()): boolean {
  try {
    return isYapaStatusLine(JSON.parse(readFileSync(path, 'utf-8')).statusLine);
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
    return;
  }
  if (args.includes('--uninstall')) {
    process.stdout.write(`Status line removed from ${uninstallStatusLine(settings)}\n`);
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
  const color = !process.env.NO_COLOR;
  process.stdout.write(renderSegment(readHealth(healthPath), Date.now(), { color, label: argValue(args, '--label') }) + '\n');
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
  main(process.argv.slice(2), self).catch(() => process.stdout.write('yapa ○ sync status unknown\n'));
}
