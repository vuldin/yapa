/**
 * `yapa capture status`: how the per-turn capture and the compaction capture
 * have fared, from capture-health.json. One JSON object on stdout (--text: a
 * short summary). Exit: 0, or 2 for bad arguments.
 */
import { captureHealthFile, readCaptureHealth, summarizeCapture } from '@yapa/core';

export const CAPTURE_USAGE = 'Usage: yapa capture status [--days N] [--text]\n';

function when(ms: number | undefined, now: number): string {
  if (!ms) return 'never';
  const min = Math.round((now - ms) / 60_000);
  return min < 1 ? 'just now' : min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

export function runCapture(sub: string | undefined, args: string[], now = Date.now()): { exit: number; json: Record<string, unknown>; text: string } {
  if (sub !== 'status') return { exit: 2, json: { ok: false, error: CAPTURE_USAGE.trim() }, text: CAPTURE_USAGE.trim() };
  const i = args.indexOf('--days');
  const days = i >= 0 ? Number(args[i + 1]) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 14) return { exit: 2, json: { ok: false, error: '--days must be 1-14' }, text: '--days must be 1-14' };
  const file = captureHealthFile();
  const s = summarizeCapture(readCaptureHealth(file), now, days);
  const lines = [
    `Capture over the last ${days} day(s): ${s.turns} turn(s) judged, ${s.stored} stored, ${s.skipped} skipped as known, ${s.settled} settled of ${s.judged} open item(s) judged`,
    `Failures: ${s.failed} extraction, ${s.store_failed} store, ${s.follow_through_failed} follow-through, ${s.compactions_failed} of ${s.compactions} compaction capture(s)`,
    `Last success: ${when(s.last_ok_at, now)}`,
    ...(s.last_error ? [`Last error (${s.last_error.stage}, ${when(s.last_error.at, now)}): ${s.last_error.message}`] : []),
    ...(s.failing ? ['Status: FAILING'] : []),
    ...(file ? [] : ['(no health file: SYNC_HEALTH_FILE is off)']),
  ];
  return { exit: 0, json: { ok: true, file: file || null, ...s }, text: lines.join('\n') };
}
