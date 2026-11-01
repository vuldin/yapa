/**
 * Is a newer YAPA out? The MCP server reads the newest release's manifest
 * (UPDATE_SOURCE: by default the plugin manifest on the main branch, which is
 * what `claude plugin update` installs) at most once a day, in the
 * background, and keeps the answer in a small file beside the sync health
 * record. The status line and the session-start hook read that file; nothing
 * on the prompt path touches the network.
 *
 * Failures are silent: an offline laptop just keeps the last answer.
 *
 * @module @yapa/core/update-check
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';

export interface UpdateState {
  /** The version this machine last ran. */
  current: string;
  /** A newer released version, when there is one. */
  latest?: string;
  /** When the release was last checked (epoch ms). */
  checked_at: number;
  /** The newer version the session-start hook already told Claude about. */
  notified?: string;
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Compare two versions: >0 when a is newer. Unparseable sorts lowest. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const pa = SEMVER.exec(String(a ?? '').trim());
  const pb = SEMVER.exec(String(b ?? '').trim());
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  // 1.7.0 is newer than 1.7.0-rc.1
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return (pa[4] ?? '').localeCompare(pb[4] ?? '');
}

/** Where the answer is kept: beside the sync health record. Undefined when that is off. */
export function updateStatePath(): string | undefined {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join(dirname(health), 'update-check.json') : undefined;
}

export function readUpdateState(path = updateStatePath()): UpdateState | undefined {
  if (!path) return undefined;
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8'));
    return s && typeof s.current === 'string' && typeof s.checked_at === 'number' ? s : undefined;
  } catch {
    return undefined;
  }
}

function writeUpdateState(s: UpdateState, path = updateStatePath()): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best effort
  }
}

/**
 * Record the version running now. A newer release stays only while it is
 * still newer, so updating clears the note by itself. Returns the state.
 */
export function noteInstalledVersion(current: string, path = updateStatePath()): UpdateState | undefined {
  if (!path) return undefined;
  const prev = readUpdateState(path);
  if (prev && prev.current === current) return prev;
  const next: UpdateState = { current, checked_at: prev?.checked_at ?? 0 };
  if (prev?.latest && compareVersions(prev.latest, current) > 0) next.latest = prev.latest;
  if (next.latest && prev?.notified === next.latest) next.notified = prev.notified;
  writeUpdateState(next, path);
  return next;
}

/**
 * Check the newest release (at most once per interval unless forced). Never
 * throws; returns the state as now known, or undefined when checks are off.
 */
export async function checkForUpdate(
  current: string,
  opts: { now?: number; force?: boolean; fetchImpl?: typeof fetch; path?: string } = {},
): Promise<UpdateState | undefined> {
  const config = getConfig();
  const path = opts.path ?? updateStatePath();
  if (!config.UPDATE_CHECK || !path || !config.UPDATE_SOURCE) return undefined;
  const now = opts.now ?? Date.now();
  const prev = noteInstalledVersion(current, path);
  if (!opts.force && prev && prev.checked_at > 0 && now - prev.checked_at < UPDATE_CHECK_INTERVAL_MS) return prev;
  let released: string | undefined;
  try {
    const r = await (opts.fetchImpl ?? fetch)(config.UPDATE_SOURCE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return prev;
    const body = await r.json() as { version?: unknown };
    if (typeof body?.version !== 'string' || !SEMVER.test(body.version.trim())) return prev;
    released = body.version.trim().replace(/^v/, '');
  } catch {
    return prev;
  }
  const next: UpdateState = { current, checked_at: now };
  if (compareVersions(released, current) > 0) next.latest = released;
  if (next.latest && prev?.notified === next.latest) next.notified = prev.notified;
  writeUpdateState(next, path);
  return next;
}

/** Mark the newer version as told, so the session-start hook says it once. */
export function markUpdateNotified(version: string, path = updateStatePath()): void {
  const s = readUpdateState(path);
  if (s && s.latest === version && s.notified !== version) writeUpdateState({ ...s, notified: version }, path);
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Check now and then once per interval, for a long-lived process (the MCP server). */
export function startUpdateChecks(current: string): void {
  if (timer || !getConfig().UPDATE_CHECK) return;
  void checkForUpdate(current);
  timer = setInterval(() => void checkForUpdate(current), UPDATE_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopUpdateChecks(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
