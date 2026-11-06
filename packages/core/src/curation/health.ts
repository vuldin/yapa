/**
 * Capture health, persisted beside sync health (`capture-health.json`) so the
 * status line, session start and `yapa capture status` can say when the
 * per-turn capture is failing. It runs in short-lived hook processes whose
 * stderr nobody sees, so without this a broken aux model goes unnoticed.
 *
 * Recording never throws and never blocks a turn.
 *
 * @module @yapa/core/curation/health
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from '../config.js';
import { lockFileFor, withFileLockSync, writeJsonAtomic } from '../fs-lock.js';

export interface CaptureDay {
  /** Turns judged (extractor ran to the end). */
  turns: number;
  stored: number;
  skipped: number;
  settled: number;
  /** Turns whose extraction failed (no memories stored). */
  failed: number;
  /** Turns whose follow-through failed (extraction may still have run). */
  follow_through_failed: number;
  compactions: number;
  compactions_failed: number;
}

export type CaptureStage = 'extractor' | 'follow-through' | 'compaction';

export interface CaptureHealth {
  /** Local dates (YYYY-MM-DD), the last KEEP_DAYS of them. */
  days: Record<string, CaptureDay>;
  /** Epoch ms of the latest record. */
  at: number;
  last_ok_at?: number;
  last_error?: { at: number; stage: CaptureStage; message: string };
}

export type CaptureEvent =
  | { kind: 'turn'; stored: number; skipped: number; settled: number; followThroughError?: unknown }
  | { kind: 'turn_failed'; error: unknown; followThroughError?: unknown }
  | { kind: 'compaction'; error?: unknown };

const KEEP_DAYS = 14;

/** `capture-health.json` beside SYNC_HEALTH_FILE; empty when that file is off. */
export function captureHealthFile(): string {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join(dirname(health), 'capture-health.json') : '';
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const emptyDay = (): CaptureDay => ({ turns: 0, stored: 0, skipped: 0, settled: 0, failed: 0, follow_through_failed: 0, compactions: 0, compactions_failed: 0 });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

export function readCaptureHealth(path: string = captureHealthFile()): CaptureHealth | undefined {
  if (!path) return undefined;
  try {
    const h = JSON.parse(readFileSync(path, 'utf-8'));
    return h && typeof h.at === 'number' && h.days && typeof h.days === 'object' ? h : undefined;
  } catch {
    return undefined;
  }
}

/** Add one event to `h` (pure). */
export function applyCaptureEvent(h: CaptureHealth | undefined, e: CaptureEvent, now: number): CaptureHealth {
  const days: Record<string, CaptureDay> = {};
  const key = dayKey(now);
  for (const [k, v] of Object.entries(h?.days ?? {})) days[k] = { ...emptyDay(), ...v };
  const day = days[key] ?? (days[key] = emptyDay());
  const next: CaptureHealth = { ...h, days, at: now };
  const fail = (stage: CaptureStage, err: unknown) => { next.last_error = { at: now, stage, message: message(err) }; };
  if (e.kind === 'turn') {
    day.turns++;
    day.stored += e.stored;
    day.skipped += e.skipped;
    day.settled += e.settled;
    if (e.followThroughError !== undefined) {
      day.follow_through_failed++;
      fail('follow-through', e.followThroughError);
    } else {
      next.last_ok_at = now;
    }
  } else if (e.kind === 'turn_failed') {
    day.failed++;
    if (e.followThroughError !== undefined) day.follow_through_failed++;
    fail('extractor', e.error);
  } else {
    day.compactions++;
    if (e.error !== undefined) {
      day.compactions_failed++;
      fail('compaction', e.error);
    } else {
      next.last_ok_at = now;
    }
  }
  for (const k of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[k];
  return next;
}

export function recordCapture(e: CaptureEvent, now = Date.now(), path: string = captureHealthFile()): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    withFileLockSync(lockFileFor(path), () => writeJsonAtomic(path, applyCaptureEvent(readCaptureHealth(path), e, now)), { waitMs: 2000 });
  } catch {
    // Health is best effort: a turn never fails because of it.
  }
}

export interface CaptureSummary {
  days: number;
  turns: number;
  stored: number;
  skipped: number;
  settled: number;
  failed: number;
  follow_through_failed: number;
  compactions: number;
  compactions_failed: number;
  last_ok_at?: number;
  last_error?: CaptureHealth['last_error'];
  /** The latest run failed, or more turns failed than succeeded today. */
  failing: boolean;
}

export function summarizeCapture(h: CaptureHealth | undefined, now = Date.now(), days = 7): CaptureSummary {
  const out: CaptureSummary = {
    days, turns: 0, stored: 0, skipped: 0, settled: 0, failed: 0, follow_through_failed: 0, compactions: 0, compactions_failed: 0, failing: false,
  };
  if (!h) return out;
  const keys = new Set(Array.from({ length: days }, (_, i) => dayKey(now - i * 86_400_000)));
  for (const [k, d] of Object.entries(h.days)) {
    if (!keys.has(k)) continue;
    for (const f of ['turns', 'stored', 'skipped', 'settled', 'failed', 'follow_through_failed', 'compactions', 'compactions_failed'] as const) out[f] += Number(d[f] ?? 0);
  }
  out.last_ok_at = h.last_ok_at;
  out.last_error = h.last_error;
  out.failing = captureFailing(h, now);
  return out;
}

/** Same rule as the status line: the latest run failed within the hour, or today's failures outnumber its successes. */
export function captureFailing(h: CaptureHealth | undefined, now = Date.now()): boolean {
  if (!h) return false;
  const err = h.last_error;
  if (err && err.at >= (h.last_ok_at ?? 0) && now - err.at < 3_600_000) return true;
  const d = h.days[dayKey(now)];
  if (!d) return false;
  const bad = d.failed + d.follow_through_failed + d.compactions_failed;
  const good = d.turns - d.follow_through_failed + d.compactions - d.compactions_failed;
  return bad >= 2 && bad > good;
}

/** One line for session start when capture failed in the last day, else undefined. */
export function captureDownLine(h: CaptureHealth | undefined = readCaptureHealth(), now = Date.now()): string | undefined {
  const err = h?.last_error;
  if (!h || !err || now - err.at > 86_400_000 || (h.last_ok_at ?? 0) > err.at) return undefined;
  const d = h.days[dayKey(now)] ?? emptyDay();
  const failed = d.failed + d.follow_through_failed + d.compactions_failed;
  return `**YAPA capture is failing** (${err.stage}${failed ? `, ${failed} failure(s) today` : ''}): ${err.message.slice(0, 160)}. Memories from recent turns may be missing; \`yapa capture status\` for details.`;
}
