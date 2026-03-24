import { addDocument, getOrCreateCollection, getDocumentsByFilter } from '../chroma.js';

const SYNC_PULL_SENTINEL_ID = '__sync_pull_sentinel__';

/**
 * Get the timestamp of the last successful pull.
 * Returns 0 if no pull has ever been done (will pull everything).
 */
export async function getSyncPullTimestamp(): Promise<number> {
  try {
    const results = await getDocumentsByFilter('global', {
      type: { $eq: 'sync_pull_sentinel' },
    }, 1);

    if (results.length === 0) return 0;
    return (results[0].metadata.last_pull as number) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Update the pull timestamp to now.
 */
export async function updateSyncPullTimestamp(): Promise<void> {
  await getOrCreateCollection('global');
  await addDocument('global', SYNC_PULL_SENTINEL_ID, 'sync pull sentinel', {
    type: 'sync_pull_sentinel',
    last_pull: Math.floor(Date.now() / 1000),
  });
}
