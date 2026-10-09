import { getConfig } from '../config.js';
import { listCollections, getDocumentsByFilter, updateDocument, addDocument, deleteDocument, type DocumentResult } from '../store/index.js';
import { generateEmbedding } from '../embeddings.js';

import { upsertRemoteDocument, findSimilarRemote, addRemoteRelatedIds, deleteRemoteDocuments, getRemoteCreatedAt, getRemoteMaxTaskNumber } from './postgres.js';
import { getPendingDeletes, clearPendingDeletes } from './deletes.js';
import { getSyncSubscriptions, updateSyncSubscriptions } from './sentinel.js';
import { getDeviceId } from './device.js';

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
      const deletedCount = await deleteRemoteDocuments(docIds, getConfig().USERNAME);
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

      for (const unsynced of unsyncedDocs) {
        // Skip sentinel/internal documents
        if (unsynced.id.startsWith('__')) continue;
        // Journal drafts are per-session scratch; only the consolidated
        // journal memory is worth sharing.
        if (unsynced.metadata.type === 'journal_draft') continue;
        // Stamp the last writer's device: pull on this device skips its own
        // echoes, while the same user's other devices still receive the row.
        let doc: DocumentResult = { ...unsynced, metadata: { ...unsynced.metadata, origin_device: getDeviceId() } };

        if (doc.metadata.type === 'task') {
          try {
            doc = (await rekeyIfTaskIdTaken(collection.name, doc)) ?? doc;
          } catch (e) {
            process.stderr.write(`[yapa-sync] Task id check failed for ${doc.id}, not pushing it this cycle: ${e}\n`);
            stats.errors++;
            continue;
          }
        }

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
          // A re-push of an edited doc matches its own remote row; never self-link.
          const similar = (await findSimilarRemote(collection.name, embedding)).filter(s => s.id !== doc.id);

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

/**
 * Task ids are sequential per user (`user-302`), so a wiped store or a second
 * machine can mint an id that already belongs to a DIFFERENT task remotely.
 * Upserting would silently overwrite that task. Detect it (same id, different
 * creation time) and give this task a fresh id instead. Returns the renamed
 * doc, or undefined when the id is free or is this same task.
 */
export async function rekeyIfTaskIdTaken(collection: string, doc: DocumentResult): Promise<DocumentResult | undefined> {
  const localCreated = Number(doc.metadata.created_at);
  if (!Number.isFinite(localCreated) || localCreated <= 0) return undefined; // can't tell; legacy doc
  const remoteCreated = await getRemoteCreatedAt(doc.id);
  if (remoteCreated === undefined || Math.abs(remoteCreated - localCreated) <= 1) return undefined;

  // We're mid-push, so the remote is reachable: take the higher of the local
  // next id and the remote's highest number for this user.
  const { getNextTaskId } = await import('../tasks/create.js');
  const localNext = Number((await getNextTaskId()).split('-').pop());
  const remoteMax = await getRemoteMaxTaskNumber(getConfig().USERNAME);
  const newId = `${getConfig().USERNAME}-${Math.max(localNext, remoteMax + 1)}`;
  const metadata = { ...doc.metadata, id: newId, rekeyed_from: doc.id };
  await addDocument(collection, newId, doc.content, metadata);
  await deleteDocument(collection, doc.id);
  process.stderr.write(`[yapa-sync] Task id ${doc.id} already belongs to a different task on the shared database; renamed this task to ${newId}\n`);
  return { ...doc, id: newId, metadata };
}

async function markSynced(collection: string, id: string, metadata: Record<string, any>): Promise<void> {
  await updateDocument(collection, id, {
    ...metadata,
    is_synced: true,
  });
}
