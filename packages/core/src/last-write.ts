import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';
import { currentSession } from './sync/coordination.js';

/**
 * The collection each Claude Code session last wrote to, for the status line
 * (`yapa@v1.8.0 <-> acme ● synced 1m ago | project-acme`). One small file per
 * session in `last-write/` beside the sync health file, keyed by the Claude
 * Code session id, which the status line also receives. Written by the MCP
 * tools and the `yapa memory` / `yapa task` CLI when a write succeeds;
 * background work (sync pulls, decay, the janitor) never touches it.
 *
 * Display only: every failure is ignored.
 */

export interface LastWrite {
  collection: string;
  /** Epoch ms. */
  at: number;
}

/** Records untouched this long are removed the first time a process writes. */
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;
let pruned = false;

/** `last-write/` beside SYNC_HEALTH_FILE; empty when that file is off. */
export function lastWriteDir(): string {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join(dirname(health), 'last-write') : '';
}

export function lastWriteFile(session: string, dir: string = lastWriteDir()): string {
  return join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/**
 * Note that this session just wrote to `collection` (no session or no dir:
 * nothing). The key is the Claude Code session id, the one the status line
 * gets, ahead of YAPA_SESSION (a claim holder name, which may be a project's
 * own session id).
 */
export function recordLastWrite(
  collection: string | undefined,
  opts: { session?: string; now?: number; dir?: string } = {},
): void {
  const session = currentSession(opts.session ?? process.env.CLAUDE_CODE_SESSION_ID);
  const dir = opts.dir ?? lastWriteDir();
  if (!collection || !session || !dir) return;
  const now = opts.now ?? Date.now();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = lastWriteFile(session, dir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ collection, at: now } satisfies LastWrite) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    if (!pruned) {
      pruned = true;
      pruneLastWrites(dir, now);
    }
  } catch {
    // Display only.
  }
}

export function readLastWrite(session: string, dir: string = lastWriteDir()): LastWrite | undefined {
  if (!dir) return undefined;
  try {
    const r = JSON.parse(readFileSync(lastWriteFile(session, dir), 'utf-8'));
    return r && typeof r.collection === 'string' && typeof r.at === 'number' ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Remove the records of sessions that have not written for a week. */
export function pruneLastWrites(dir: string = lastWriteDir(), now: number = Date.now()): void {
  if (!dir) return;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > PRUNE_AFTER_MS) rmSync(p, { force: true });
      } catch {
        // gone already
      }
    }
  } catch {
    // no dir yet
  }
}
