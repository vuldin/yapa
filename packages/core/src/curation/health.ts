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
import { redactTokens } from '../redact.js';

export interface CaptureDay {
  /** Turns judged (extractor ran to the end). */
  turns: number;
  /** Of those, turns with no failure at all. */
  clean: number;
  stored: number;
  skipped: number;
  settled: number;
  /** Turns whose extraction failed (no memories stored). */
  failed: number;
  /** Judged turns whose follow-through failed. */
  follow_through_failed: number;
  /** Judged turns where a memory could not be stored. */
  store_failed: number;
  compactions: number;
  compactions_failed: number;
}

export type CaptureStage = 'extractor' | 'store' | 'follow-through' | 'compaction';

export interface CaptureHealth {
  /** Local dates (YYYY-MM-DD), the last KEEP_DAYS of them. */
  days: Record<string, CaptureDay>;
  /** Epoch ms of the latest record. */
  at: number;
  last_ok_at?: number;
  last_error?: { at: number; stage: CaptureStage; message: string };
}

export type CaptureEvent =
  | { kind: 'turn'; stored: number; skipped: number; settled: number; followThroughError?: unknown; storeError?: unknown }
  | { kind: 'turn_failed'; error: unknown }
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

const emptyDay = (): CaptureDay => ({
  turns: 0, clean: 0, stored: 0, skipped: 0, settled: 0, failed: 0, follow_through_failed: 0, store_failed: 0, compactions: 0, compactions_failed: 0,
});

/** The error, without the model's reply an extractor parse error quotes (it can repeat the turn), and with tokens redacted. */
const message = (e: unknown) => redactTokens((e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' '))
  .replace(/^(.*?extractor response[^:]*):.*$/i, '$1').slice(0, 300);

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
    }
    if (e.storeError !== undefined) {
      day.store_failed++;
      fail('store', e.storeError);
    }
    if (e.followThroughError === undefined && e.storeError === undefined) {
      day.clean++;
      next.last_ok_at = now;
    }
  } else if (e.kind === 'turn_failed') {
    day.failed++;
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
  store_failed: number;
  compactions: number;
  compactions_failed: number;
  last_ok_at?: number;
  last_error?: CaptureHealth['last_error'];
  /** The latest run failed, or more turns failed than succeeded today. */
  failing: boolean;
}

export function summarizeCapture(h: CaptureHealth | undefined, now = Date.now(), days = 7): CaptureSummary {
  const out: CaptureSummary = {
    days, turns: 0, stored: 0, skipped: 0, settled: 0, failed: 0, follow_through_failed: 0, store_failed: 0, compactions: 0, compactions_failed: 0, failing: false,
  };
  if (!h) return out;
  const t = new Date(now);
  const keys = new Set(Array.from({ length: days }, (_, i) => dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i, 12).getTime())));
  for (const [k, d] of Object.entries(h.days)) {
    if (!keys.has(k)) continue;
    for (const f of ['turns', 'stored', 'skipped', 'settled', 'failed', 'follow_through_failed', 'store_failed', 'compactions', 'compactions_failed'] as const) out[f] += Number(d[f] ?? 0);
  }
  out.last_ok_at = h.last_ok_at;
  out.last_error = h.last_error;
  out.failing = captureFailing(h, now);
  return out;
}

/** Runs today that had a failure, and runs that had none. */
export function dayRuns(d: Partial<CaptureDay>): { bad: number; good: number } {
  const n = (k: keyof CaptureDay) => Number(d[k] ?? 0);
  const clean = d.clean === undefined ? n('turns') - n('follow_through_failed') : n('clean');
  return { bad: n('failed') + (n('turns') - clean) + n('compactions_failed'), good: clean + n('compactions') - n('compactions_failed') };
}

/**
 * Same rule as the status line: the latest run failed within the hour (a
 * follow-through failure alone doesn't count: memories were still stored),
 * or today's runs with a failure outnumber those without, two or more.
 */
export function captureFailing(h: CaptureHealth | undefined, now = Date.now()): boolean {
  if (!h) return false;
  const err = h.last_error;
  if (err && err.stage !== 'follow-through' && err.at >= (h.last_ok_at ?? 0) && now - err.at < 3_600_000) return true;
  const d = h.days[dayKey(now)];
  if (!d) return false;
  const { bad, good } = dayRuns(d);
  return bad >= 2 && bad > good;
}

const CONSEQUENCE: Record<CaptureStage, string> = {
  extractor: 'memories from recent turns may be missing',
  store: 'some memories from recent turns could not be stored',
  'follow-through': 'open decisions, questions and findings may not have been updated',
  compaction: 'session summaries may be missing',
};

/** One line for session start when capture failed in the last day, else undefined. */
export function captureDownLine(h: CaptureHealth | undefined = readCaptureHealth(), now = Date.now()): string | undefined {
  const err = h?.last_error;
  if (!h || !err || now - err.at > 86_400_000 || (h.last_ok_at ?? 0) > err.at) return undefined;
  const { bad } = dayRuns(h.days[dayKey(now)] ?? {});
  const why = CONSEQUENCE[err.stage] ?? CONSEQUENCE.extractor;
  return `**YAPA capture is failing** (${err.stage}${bad ? `, ${bad} failed run(s) today` : ''}): ${err.message.slice(0, 160)}. So ${why}; \`yapa capture status\` for details.`;
}
