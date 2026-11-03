import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';
import { pidAlive, writeJsonAtomic } from './fs-lock.js';

/**
 * Which YAPA each Claude Code session runs, for the status line: the MCP
 * server writes `sessions/<session id>.json` beside the sync health file when
 * it starts (`{version, pid, started_at}`) and removes it when it exits. The
 * status line, one shared script, then shows the version of this session's
 * server rather than its own, and says when a session needs a restart to
 * load a newer YAPA.
 *
 * Display only: every failure is ignored.
 */

export interface SessionRecord {
  version: string;
  pid: number;
  /** Epoch ms. */
  started_at: number;
}

const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;

/** `sessions/` beside SYNC_HEALTH_FILE; empty when that file is off. */
export function sessionRecordDir(): string {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join(dirname(health), 'sessions') : '';
}

export function sessionRecordFile(session: string, dir: string = sessionRecordDir()): string {
  return join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** The Claude Code session this process serves (the id it was started with). */
function sessionId(explicit?: string): string | undefined {
  const v = explicit ?? process.env.CLAUDE_CODE_SESSION_ID;
  return v && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : undefined;
}

/** Note that this session's YAPA server runs `version` (call at server start). Returns the file written, if any. */
export function recordSessionStart(version: string, opts: { session?: string; dir?: string; now?: number } = {}): string | undefined {
  const session = sessionId(opts.session);
  const dir = opts.dir ?? sessionRecordDir();
  if (!session || !dir) return undefined;
  const file = sessionRecordFile(session, dir);
  try {
    writeJsonAtomic(file, { version, pid: process.pid, started_at: opts.now ?? Date.now() } satisfies SessionRecord);
    pruneSessionRecords(dir, opts.now ?? Date.now());
    return file;
  } catch {
    return undefined;
  }
}

/** Remove this server's record (call at exit), only if it is still ours. */
export function removeSessionRecord(opts: { session?: string; dir?: string } = {}): void {
  const session = sessionId(opts.session);
  const dir = opts.dir ?? sessionRecordDir();
  if (!session || !dir) return;
  const file = sessionRecordFile(session, dir);
  try {
    const r = JSON.parse(readFileSync(file, 'utf-8')) as SessionRecord;
    if (r.pid === process.pid) rmSync(file, { force: true });
  } catch {
    // gone already
  }
}

/** Records of servers that are gone, or untouched for a week. */
export function pruneSessionRecords(dir: string = sessionRecordDir(), now = Date.now()): void {
  if (!dir) return;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const p = join(dir, name);
      try {
        const r = JSON.parse(readFileSync(p, 'utf-8')) as SessionRecord;
        if (!pidAlive(r.pid) || now - statSync(p).mtimeMs > PRUNE_AFTER_MS) rmSync(p, { force: true });
      } catch {
        rmSync(p, { force: true });
      }
    }
  } catch {
    // no dir yet
  }
}
