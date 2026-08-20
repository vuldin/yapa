import { getConfig } from '../config.js';
import { listCollections, getDocumentsByFilter, updateDocument } from '../store/index.js';
import { generateEmbedding } from '../embeddings.js';

import { upsertRemoteDocument, findSimilarRemote, addRemoteRelatedIds, deleteRemoteDocuments } from './postgres.js';
import { getPendingDeletes, clearPendingDeletes } from './deletes.js';
import { getSyncSubscriptions, updateSyncSubscriptions } from './sentinel.js';

/** Collection prefixes that should not be synced. */
function isSyncable(collectionName: string): boolean {
  return !collectionName.startsWith('private-') && !collectionName.startsWith('local-');
}

export interface PushStats {
  pushed: number;
  linked: number;
  deleted: number;
  errors: number;
}

/**
 * Push unsynced local documents to the remote database.
 * - Processes pending deletes first
 * - Then pushes new/updated docs with dedup
 */
export async function pushToRemote(): Promise<PushStats> {
  const stats: PushStats = { pushed: 0, linked: 0, deleted: 0, errors: 0 };

  // Step 1: Process pending deletes
  try {
    const pendingDeletes = await getPendingDeletes();
    if (pendingDeletes.length > 0) {
      const docIds = pendingDeletes.map(entry => entry.split(':')[1]).filter(Boolean);
      const deletedCount = await deleteRemoteDocuments(docIds);
      stats.deleted = deletedCount;
      await clearPendingDeletes();
    }
  } catch (e) {
    process.stderr.write(`[yapa-sync] Delete propagation error: ${e}\n`);
    stats.errors++;
  }

  // Step 2: Push unsynced documents and auto-subscribe pushed collections
  const collections = await listCollections();
  const pushedCollections: string[] = [];

  for (const collection of collections) {
    if (!isSyncable(collection.name)) continue;

    try {
      const unsyncedDocs = await getDocumentsByFilter(collection.name, { is_synced: false }, 500);
      let collectionHadPush = false;

      for (const doc of unsyncedDocs) {
        // Skip sentinel/internal documents
        if (doc.id.startsWith('__')) continue;

        try {
          // Generate embedding for similarity search
          const embedding = await generateEmbedding(doc.content);
          if (!embedding) {
            // ChromaDB server-side embeddings — we can't get the vector for remote comparison
            // Fall back to ID-based dedup only (insert, let ON CONFLICT handle it)
            await upsertRemoteDocument({
              id: doc.id,
              collection: collection.name,
              content: doc.content,
              embedding: [], // Will fail — need client-side embeddings for sync
              metadata: doc.metadata,
              origin_user: getConfig().USERNAME,
              created_at: doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
              updated_at: doc.metadata.updated_at ?? doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
            });
            await markSynced(collection.name, doc.id, doc.metadata);
            stats.pushed++;
            collectionHadPush = true;
            continue;
          }

          // Check for similar documents in remote
          const similar = await findSimilarRemote(collection.name, embedding);

          if (similar.length > 0) {
            // Found similar doc(s) — link them via related_ids
            const remoteId = similar[0].id;

            // Update remote doc's related_ids
            await addRemoteRelatedIds(remoteId, [doc.id]);

            // Update local doc's related_ids
            const existingRelated = Array.isArray(doc.metadata.related_ids) ? doc.metadata.related_ids : [];
            if (!existingRelated.includes(remoteId)) {
              existingRelated.push(remoteId);
            }

            // Still push our doc to remote (keep both, tag as related)
            await upsertRemoteDocument({
              id: doc.id,
              collection: collection.name,
              content: doc.content,
              embedding,
              metadata: { ...doc.metadata, related_ids: existingRelated },
              origin_user: getConfig().USERNAME,
              created_at: doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
              updated_at: doc.metadata.updated_at ?? doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
            });

            await markSynced(collection.name, doc.id, { ...doc.metadata, related_ids: existingRelated });
            stats.linked++;
            collectionHadPush = true;
          } else {
            // No match — fresh insert
            await upsertRemoteDocument({
              id: doc.id,
              collection: collection.name,
              content: doc.content,
              embedding,
              metadata: doc.metadata,
              origin_user: getConfig().USERNAME,
              created_at: doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
              updated_at: doc.metadata.updated_at ?? doc.metadata.created_at ?? Math.floor(Date.now() / 1000),
            });

            await markSynced(collection.name, doc.id, doc.metadata);
            stats.pushed++;
            collectionHadPush = true;
          }
        } catch (e) {
          process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${e}\n`);
          stats.errors++;
        }
      }

      if (collectionHadPush) {
        pushedCollections.push(collection.name);
      }
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push error for collection ${collection.name}: ${e}\n`);
      stats.errors++;
    }
  }

  // Auto-subscribe collections that were successfully pushed
  if (pushedCollections.length > 0) {
    try {
      const existing = await getSyncSubscriptions();
      const existingSet = new Set(existing);
      const newSubs = pushedCollections.filter(c => !existingSet.has(c));
      if (newSubs.length > 0) {
        await updateSyncSubscriptions([...existing, ...newSubs]);
      }
    } catch (e) {
      process.stderr.write(`[yapa-sync] Auto-subscribe error: ${e}\n`);
    }
  }

  return stats;
}

async function markSynced(collection: string, id: string, metadata: Record<string, any>): Promise<void> {
  await updateDocument(collection, id, {
    ...metadata,
    is_synced: true,
  });
}
