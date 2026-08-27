/**
 * Plugin-owned background lifecycle: journal consolidation on session
 * disposal, salience decay sweeps, and background remote sync — all
 * effect-scoped so plugin reload/disposal cleans them up (replaces the MCP
 * server's process-level setInterval loops).
 *
 * @module yapa/lifecycle
 */
import type { Context } from '@deepseek-ai/cordis';
// ctx.interval augmentation.
import type {} from '@deepseek-ai/cordis-plugin-timer';
import {
  janitorSweep,
  journalConsolidate,
  markDecayRun,
  runDecaySweep,
  shouldRunDecay,
  startSync,
  stopSync,
} from '@yapa/core';
import type { ResolvedConfig } from './config.js';

const DECAY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly due-check
const JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily contradiction sweep

const log = (msg: string) => process.stderr.write(`[yapa] ${msg}\n`);

export interface LifecycleHandle {
  /** Re-apply sync start/stop against the current resolved config. */
  syncChanged(): void;
}

export function registerLifecycle(ctx: Context, getResolved: () => ResolvedConfig): LifecycleHandle {
  // --- Journal consolidation on session end ---------------------------------
  // The MCP install's SessionEnd hook only logged a line; here we actually
  // roll the disposed session's drafts into a journal memory, per collection
  // the session touched (drafts live in 'global' unless scoped otherwise, so
  // consolidate there; scoped collections are handled when the agent calls
  // yapa_journal_consolidate itself).
  ctx.on('session/disposed', session => {
    if (!getResolved().autoJournalConsolidate) return;
    void journalConsolidate({ sessionId: session.id })
      .then(result => {
        if (result) log(`Session ${session.id} journal consolidated (${result.draft_count} drafts → ${result.memory_id})`);
      })
      .catch(e => log(`Journal consolidation failed for session ${session.id}: ${e}`));
  });

  // --- Salience decay ---------------------------------------------------------
  const runDecayIfDue = async () => {
    try {
      if (await shouldRunDecay()) {
        const count = await runDecaySweep();
        await markDecayRun();
        if (count > 0) log(`Decay sweep: ${count} documents updated`);
      }
    } catch (e) {
      log(`Decay sweep skipped: ${e}`);
    }
  };
  if (getResolved().decayOnStartup) void runDecayIfDue();
  ctx.interval(() => void runDecayIfDue(), DECAY_CHECK_INTERVAL_MS);

  // --- Contradiction janitor ----------------------------------------------------
  // Daily sweep for duplicate/contradictory pairs that predate (or bypass) the
  // capture-time resolver. Conservative, bounded, fail-open; manual trigger via
  // the `yapa_janitor_now` tool.
  let janitorRunning = false;
  const runJanitor = async () => {
    const cfg = getResolved();
    if (!cfg.janitorEnabled || janitorRunning) return;
    janitorRunning = true;
    try {
      const stats = await janitorSweep({ maxPairs: cfg.janitorMaxPairs });
      if (stats.superseded > 0 || stats.skippedDuplicates > 0) {
        log(`Janitor: ${stats.skippedDuplicates} duplicates archived, ${stats.superseded} superseded (${stats.pairsConsidered} pairs judged)`);
      }
    } catch (e) {
      log(`Janitor sweep skipped: ${e}`);
    } finally {
      janitorRunning = false;
    }
  };
  ctx.interval(() => void runJanitor(), JANITOR_INTERVAL_MS);

  // --- Background sync ---------------------------------------------------------
  // Core's startSync/stopSync own the interval; we scope start/stop to this
  // plugin fiber so HMR or removal stops the loop. Hot-reloaded settings that
  // change sync fields restart the loop (see index.ts watch handler).
  const syncCtl = { active: false };
  const applySyncState = (cfg: ResolvedConfig['core']) => {
    if (cfg.SYNC_ENABLED && cfg.SYNC_DATABASE_URL && !syncCtl.active) {
      startSync().catch(e => log(`Sync startup error: ${e}`));
      syncCtl.active = true;
    } else if ((!cfg.SYNC_ENABLED || !cfg.SYNC_DATABASE_URL) && syncCtl.active) {
      stopSync();
      syncCtl.active = false;
    }
  };
  ctx.effect(() => {
    applySyncState(getResolved().core);
    return () => {
      if (syncCtl.active) {
        stopSync();
        syncCtl.active = false;
      }
    };
  });

  return {
    syncChanged: () => applySyncState(getResolved().core),
  };
}
