import { listCollections, addDocument, getOrCreateCollection, getDocumentsByIds, queryDocuments } from '../chroma.js';
import { USERNAME, SYNC_SIMILARITY_THRESHOLD } from '../config.js';
import { getRemoteDocsSince, addRemoteRelatedIds } from './postgres.js';
import { getSyncPullTimestamp, updateSyncPullTimestamp } from './sentinel.js';

/** Collection prefixes that should not be synced. */
function isSyncable(collectionName: string): boolean {
  return !collectionName.startsWith('private-') && !collectionName.startsWith('local-');
}

export interface PullStats {
  pulled: number;
  linked: number;
  skipped: number;
  errors: number;
}

/**
 * Pull new documents from the remote database into local ChromaDB.
 * - Fetches docs from remote that were synced after last pull
 * - Dedup: checks local for similar docs before inserting
 * - Links similar docs via related_ids
 */
export async function pullFromRemote(): Promise<PullStats> {
  const stats: PullStats = { pulled: 0, linked: 0, skipped: 0, errors: 0 };

  const collections = await listCollections();
  const lastPull = await getSyncPullTimestamp();

  // Also pull for collections that exist remotely but not locally
  const localCollectionNames = new Set(collections.map(c => c.name));

  for (const collection of collections) {
    if (!isSyncable(collection.name)) continue;

    try {
      const remoteDocs = await getRemoteDocsSince(collection.name, lastPull, USERNAME);

      for (const remoteDoc of remoteDocs) {
        try {
          // Check if we already have this doc locally (by ID)
          try {
            const existing = await getDocumentsByIds(collection.name, [remoteDoc.id]);
            if (existing.length > 0) {
              stats.skipped++;
              continue;
            }
          } catch {
            // Collection might not exist locally yet — that's fine
          }

          // Check for similar docs locally (dedup)
          let linked = false;
          try {
            const similarLocal = await queryDocuments(collection.name, remoteDoc.content, 1);
            if (similarLocal.length > 0) {
              // ChromaDB returns distance (lower = more similar)
              // Cosine distance: similarity = 1 - distance
              const similarity = 1 - similarLocal[0].distance;
              if (similarity > SYNC_SIMILARITY_THRESHOLD) {
                // Found similar local doc — link them
                const localDoc = similarLocal[0];
                const localRelated = Array.isArray(localDoc.metadata.related_ids) ? localDoc.metadata.related_ids : [];
                if (!localRelated.includes(remoteDoc.id)) {
                  localRelated.push(remoteDoc.id);
                  const { updateDocument } = await import('../chroma.js');
                  await updateDocument(collection.name, localDoc.id, {
                    ...localDoc.metadata,
                    related_ids: localRelated,
                  });
                }

                // Also update remote doc's related_ids
                await addRemoteRelatedIds(remoteDoc.id, [localDoc.id]);
                linked = true;
                stats.linked++;
              }
            }
          } catch {
            // Query failed (e.g., empty collection) — proceed with insert
          }

          // Insert into local ChromaDB (whether or not we found a similar doc — keep both)
          await getOrCreateCollection(collection.name);
          const metadata = {
            ...remoteDoc.metadata,
            origin_user: remoteDoc.origin_user,
            related_ids: remoteDoc.related_ids,
            is_synced: true, // Already synced from remote
          };

          await addDocument(collection.name, remoteDoc.id, remoteDoc.content, metadata);
          stats.pulled++;
        } catch (e) {
          process.stderr.write(`[yapa-sync] Pull error for ${remoteDoc.id}: ${e}\n`);
          stats.errors++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-sync] Pull error for collection ${collection.name}: ${e}\n`);
      stats.errors++;
    }
  }

  // Update the pull timestamp
  await updateSyncPullTimestamp();

  return stats;
}
