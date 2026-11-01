import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config.js';

/**
 * Sync health, persisted so processes other than the MCP server can show it:
 * the Claude Code status line (`yapa statusline`), the hooks, `sync status`.
 * Every process that talks to the remote records what it saw; the newest
 * observation wins, and `since` carries across processes so "down since"
 * means the first failure of the current streak.
 *
 * The file never holds tokens: messages come from errors that are already
 * redacted (http-backend's redactTokens).
 */

export type SyncHealthStatus = 'ok' | 'signed_out' | 'unreachable' | 'error' | 'disabled';

export interface SyncHealth {
  status: SyncHealthStatus;
  /** Error code of the latest failure (`token_command`, `unreachable`, ...). */
  code?: string;
  message?: string;
  /** First failure of the current streak (epoch ms). */
  since?: number;
  /** Latest observation (epoch ms). */
  at: number;
  last_ok_at?: number;
  /** Local docs waiting to be pushed, as of the server's last cycle. */
  unpushed?: number;
  /** The server's sync interval, so readers can tell a stale record. */
  interval_ms: number;
  /** What the status line calls the sync (STATUS_LABEL). */
  label: string;
}

const SIGNED_OUT = new Set(['token_command', 'unauthenticated', 'cloud_run_unauthenticated']);

/** How a failure's error code reads to the person: signed out, offline, or some other error. */
export function healthStatusFor(code: unknown): Exclude<SyncHealthStatus, 'ok' | 'disabled'> {
  if (typeof code === 'string' && SIGNED_OUT.has(code)) return 'signed_out';
  if (code === 'unreachable') return 'unreachable';
  return 'error';
}

export function readSyncHealth(path: string = getConfig().SYNC_HEALTH_FILE): SyncHealth | undefined {
  if (!path) return undefined;
  try {
    const h = JSON.parse(readFileSync(path, 'utf-8'));
    return h && typeof h.status === 'string' && typeof h.at === 'number' ? h : undefined;
  } catch {
    return undefined;
  }
}

export type SyncHealthUpdate =
  | { status: 'ok' | 'disabled'; unpushed?: number }
  | { status: Exclude<SyncHealthStatus, 'ok' | 'disabled'>; code?: string; message?: string; unpushed?: number };

/** Merge one observation into the record (best effort: a failed write never fails sync). */
export function recordSyncHealth(update: SyncHealthUpdate, now: number = Date.now(), path: string = getConfig().SYNC_HEALTH_FILE): SyncHealth | undefined {
  if (!path) return undefined;
  const prev = readSyncHealth(path);
  const config = getConfig();
  const next: SyncHealth = { status: update.status, at: now, interval_ms: config.SYNC_INTERVAL_MS, label: config.STATUS_LABEL };
  if (prev?.last_ok_at) next.last_ok_at = prev.last_ok_at;
  const unpushed = update.unpushed ?? prev?.unpushed;
  if (unpushed !== undefined) next.unpushed = unpushed;
  if (update.status === 'ok') {
    next.last_ok_at = now;
  } else if (update.status !== 'disabled') {
    const failing = prev && prev.status !== 'ok' && prev.status !== 'disabled';
    next.since = failing ? prev.since ?? now : now;
    if ('code' in update && update.code) next.code = update.code;
    if ('message' in update && update.message) next.message = update.message.slice(0, 300);
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Display only.
  }
  return next;
}

/** Update the to-push count alone, keeping the latest status as it stands. */
export function recordUnpushed(unpushed: number, path: string = getConfig().SYNC_HEALTH_FILE): void {
  const prev = readSyncHealth(path);
  if (!prev || prev.unpushed === unpushed) return;
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...prev, unpushed }) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Display only.
  }
}
