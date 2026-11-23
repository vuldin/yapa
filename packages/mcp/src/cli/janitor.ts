/**
 * `yapa janitor status`: the duplicate janitor's last automatic run and when
 * the next is due. `yapa janitor run`: run it now. One JSON object on stdout
 * (--text: a short summary). Exit: 0, 2 for bad arguments, 1 on error.
 */
import { getConfig, readJanitorRecord, runJanitorIfDue, type JanitorStats } from '@yapa/core';

export const JANITOR_USAGE = 'Usage: yapa janitor status|run [--text]\n';

const day = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

export function statsLine(s: Omit<JanitorStats, 'keptPairs'>): string {
  return `${s.pairsConsidered} pair(s) judged: ${s.skippedDuplicates} duplicate(s) archived, ${s.superseded} superseded, ${s.keptDistinct} kept distinct, ${s.skippedNotOwned} left as teammates', ${s.errors} error(s)`;
}

export function janitorStatus(now = Date.now()): { json: Record<string, unknown>; text: string } {
  const config = getConfig();
  const r = readJanitorRecord();
  const next = r ? r.finished_at + config.JANITOR_INTERVAL_MS : now;
  const lines = [
    `Janitor: ${config.JANITOR_ENABLED ? 'on' : 'off'} (every ${Math.round(config.JANITOR_INTERVAL_MS / 3_600_000)} h, up to ${config.JANITOR_MAX_PAIRS} pairs)`,
    r ? `Last run: ${day(r.finished_at)} UTC, ${r.result ? statsLine(r.result.stats) : 'no result recorded'}` : 'Last run: never',
    ...(config.JANITOR_ENABLED ? [`Next due: ${next <= now ? 'now (runs at the next hourly check)' : `${day(next)} UTC`}`] : []),
  ];
  return { json: { ok: true, enabled: config.JANITOR_ENABLED, last: r ?? null, next_due: config.JANITOR_ENABLED ? next : null }, text: lines.join('\n') };
}

export async function runJanitorCli(sub: string | undefined): Promise<{ exit: number; json: Record<string, unknown>; text: string }> {
  if (sub === 'status') return { exit: 0, ...janitorStatus() };
  if (sub === 'run') {
    try {
      const stats = await runJanitorIfDue({ force: true, enabled: true });
      if (!stats) return { exit: 0, json: { ok: true, ran: false }, text: 'Another session is running the janitor now' };
      const { keptPairs: _k, ...rest } = stats;
      return { exit: 0, json: { ok: true, ran: true, stats: rest }, text: statsLine(rest) };
    } catch (e) {
      return { exit: 1, json: { ok: false, error: String(e) }, text: `Janitor error: ${e}` };
    }
  }
  return { exit: 2, json: { ok: false, error: JANITOR_USAGE.trim() }, text: JANITOR_USAGE.trim() };
}
