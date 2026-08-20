import { getDocumentsByFilter, updateDocument, listCollections } from '../store/index.js';
import { applyDecay, type LifecycleMetadata } from '../lifecycle.js';

const DECAY_SENTINEL_ID = '__decay_sentinel__';

/**
 * Run decay sweep across all collections.
 * Applies salience decay to all memories that haven't been decayed in 24h.
 * Returns the number of documents decayed.
 */
export async function runDecaySweep(): Promise<number> {
  const collections = await listCollections();
  let decayedCount = 0;

  for (const collection of collections) {
    try {
      const docs = await getDocumentsByFilter(collection.name, { type: 'memory' }, 1000);

      for (const doc of docs) {
        const lifecycleMeta: LifecycleMetadata = {
          salience: doc.metadata.salience ?? 1.0,
          accessed_at: doc.metadata.accessed_at ?? Math.floor(Date.now() / 1000),
          created_at: doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
          sector: doc.metadata.sector ?? 'episodic',
        };

        const decayed = applyDecay(lifecycleMeta);
        if (decayed.salience !== lifecycleMeta.salience) {
          await updateDocument(collection.name, doc.id, {
            ...doc.metadata,
            salience: decayed.salience,
          });
          decayedCount++;
        }
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
export async function shouldRunDecay(): Promise<boolean> {
  try {
    const results = await getDocumentsByFilter('global', {
      type: { $eq: 'decay_sentinel' },
    }, 1);

    if (results.length === 0) return true;

    const lastRun = results[0].metadata.last_run as number;
    const now = Math.floor(Date.now() / 1000);
    return (now - lastRun) > 86400; // 24 hours
  } catch {
    return true;
  }
}

/** Mark that decay has been run. */
export async function markDecayRun(): Promise<void> {
  const { addDocument, getOrCreateCollection } = await import('../store/index.js');
  await getOrCreateCollection('global');
  await addDocument('global', DECAY_SENTINEL_ID, 'decay sentinel', {
    type: 'decay_sentinel',
    last_run: Math.floor(Date.now() / 1000),
  });
}
