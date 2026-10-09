import { getDocumentsByFilter, updateDocumentsBatch, listCollections } from '../store/index.js';
import { applyDecay, type LifecycleMetadata } from '../lifecycle.js';

const DECAY_SENTINEL_ID = '__decay_sentinel__';
const DAY = 86400;
/** Upper bound on memories per collection read by one sweep. */
const SWEEP_LIMIT = 10_000;

/** Unix seconds of the previous sweep, or undefined if none was recorded. */
async function lastSweepAt(): Promise<number | undefined> {
  try {
    const results = await getDocumentsByFilter('global', { type: { $eq: 'decay_sentinel' } }, 1);
    return results[0]?.metadata.last_run as number | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decay every memory by the wall-clock time since IT was last decayed
 * (`decayed_at`), then stamp `decayed_at = now`. The curve therefore depends
 * only on elapsed time: a week without sessions decays a week's worth, a
 * manual re-run decays ~nothing, and machines that sweep at different times
 * agree. Memories from before `decayed_at` existed start from the previous
 * sweep (or one day ago), never from their creation date — so upgrading
 * doesn't apply months of decay at once.
 * Returns the number of documents updated.
 */
export async function runDecaySweep(now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const collections = await listCollections();
  const fallbackAnchor = (await lastSweepAt()) ?? now - DAY;
  let decayedCount = 0;

  for (const collection of collections) {
    try {
      const docs = await getDocumentsByFilter(collection.name, { type: 'memory' }, SWEEP_LIMIT);

      // Batch: one store mutation per collection (single HTTP request on
      // ChromaDB, single file flush on the local store) instead of N rewrites.
      const updates: Array<{ id: string; metadata: Record<string, any> }> = [];
      for (const doc of docs) {
        const anchor = typeof doc.metadata.decayed_at === 'number' ? doc.metadata.decayed_at : fallbackAnchor;
        const days = (now - anchor) / DAY;
        if (days <= 0) continue;
        const lifecycleMeta: LifecycleMetadata = {
          salience: doc.metadata.salience ?? 1.0,
          accessed_at: doc.metadata.accessed_at ?? now,
          created_at: doc.metadata.created_at ?? now,
          sector: doc.metadata.sector ?? 'episodic',
        };
        const decayed = applyDecay(lifecycleMeta, days);
        updates.push({
          id: doc.id,
          metadata: { ...doc.metadata, salience: decayed.salience, decayed_at: now },
        });
      }
      if (updates.length > 0) {
        await updateDocumentsBatch(collection.name, updates);
        decayedCount += updates.length;
      }
    } catch {
      continue;
    }
  }

  return decayedCount;
}

/**
 * Check if decay should run (more than 24h since last sweep).
 * Uses a sentinel document in the global collection to track last run.
 */
export async function shouldRunDecay(now: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const last = await lastSweepAt();
  return last === undefined || now - last > DAY;
}

/** Mark that decay has been run. */
export async function markDecayRun(now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  const { addDocument, getOrCreateCollection } = await import('../store/index.js');
  await getOrCreateCollection('global');
  await addDocument('global', DECAY_SENTINEL_ID, 'decay sentinel', {
    type: 'decay_sentinel',
    last_run: now,
  });
}
