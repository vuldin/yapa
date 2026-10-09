import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';
import { listCollections, getDocumentsByFilter, updateDocument, addDocument, deleteDocument, type DocumentResult } from '../store/index.js';
import { generateEmbedding } from '../embeddings.js';

import { getSyncBackend, isCycleFatal, noteSyncError, resolveSyncUsername, type SyncBackend, type UpsertDoc, type UpsertOutcome } from './backend.js';
import { getPendingDeletes, clearPendingDeletes } from './deletes.js';
import { getSyncSubscriptions, updateSyncSubscriptions } from './sentinel.js';
import { getDeviceId } from './device.js';

import { isSyncableCollection as isSyncable } from './syncable.js';

export interface PushStats {
  pushed: number;
  linked: number;
  deleted: number;
  /** Shared rows removed because this user's doc now lives in a private-/local- collection. */
  retracted: number;
  /** Docs the remote refused (secret, bad embedding, ...): kept local and unsynced until they change. */
  rejected: number;
  /** Tasks renamed because their id belongs to a different task remotely. */
  renamed: number;
  errors: number;
}

export function emptyPushStats(): PushStats {
  return { pushed: 0, linked: 0, deleted: 0, retracted: 0, rejected: 0, renamed: 0, errors: 0 };
}

/** Local bookkeeping that never leaves this machine. */
const LOCAL_ONLY_KEYS = ['sync_rejected', 'sync_rejected_fp', 'sync_rejected_message'];

/**
 * Fingerprint of a doc's syncable state. A rejected doc is retried only when
 * this changes (an edit), so a refused doc is not resent every cycle.
 */
export function syncFingerprint(doc: { content: string; metadata: Record<string, any> }): string {
  const skip = new Set([...LOCAL_ONLY_KEYS, 'is_synced', 'origin_device', 'remote_checked_at']);
  const meta = Object.fromEntries(Object.entries(doc.metadata).filter(([k]) => !skip.has(k)).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(doc.content).update('\n').update(JSON.stringify(meta)).digest('hex').slice(0, 32);
}

function stripLocalOnly(metadata: Record<string, any>): Record<string, any> {
  const out = { ...metadata };
  for (const k of LOCAL_ONLY_KEYS) delete out[k];
  return out;
}

/**
 * Push unsynced local documents to the remote.
 * - Processes pending deletes first, then retracts shared copies of docs now in local-only collections
 * - Then pushes new/updated docs in batches; similar remote docs are linked via related_ids
 */
export async function pushToRemote(): Promise<PushStats> {
  const stats = emptyPushStats();
  const backend = await getSyncBackend();
  if (!backend) return stats;
  // Owner checks, origin_user and task renames use the remote's name for us.
  await resolveSyncUsername();

  // Step 1: Process pending deletes
  try {
    const pendingDeletes = await getPendingDeletes();
    if (pendingDeletes.length > 0) {
      const docIds = pendingDeletes.map(entry => entry.split(':')[1]).filter(Boolean);
      stats.deleted = await backend.delete(docIds, 'delete');
      // Only the entries handled here: a delete queued during the await stays.
      await clearPendingDeletes(pendingDeletes);
    }
  } catch (e) {
    process.stderr.write(`[yapa-sync] Delete propagation error: ${e}\n`);
    noteSyncError(e);
    stats.errors++;
    if (isCycleFatal(e)) return stats;
  }

  const collections = await listCollections();

  // Step 2: A doc of ours that now lives in a local-only collection
  // (private-/local-/global: moved there, restored, or synced by an older
  // version) must not keep a shared copy. Teammates' rows are theirs, so a private copy of one is just
  // a personal copy and their row stays.
  for (const collection of collections) {
    if (isSyncable(collection.name)) continue;
    try {
      stats.retracted += await retractSharedCopies(backend, collection.name);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Private-copy check failed for ${collection.name}: ${e}\n`);
      noteSyncError(e);
      stats.errors++;
      if (isCycleFatal(e)) return stats;
    }
  }

  // Step 3: Push unsynced documents and auto-subscribe pushed collections
  const pushedCollections: string[] = [];

  for (const collection of collections) {
    if (!isSyncable(collection.name)) continue;

    try {
      const unsyncedDocs = await getDocumentsByFilter(collection.name, { is_synced: false }, 500);
      const before = stats.pushed + stats.linked;
      const batch: Array<{ doc: DocumentResult; upsert: UpsertDoc }> = [];

      for (const unsynced of unsyncedDocs) {
        // Skip sentinel/internal documents
        if (unsynced.id.startsWith('__')) continue;
        // Journal drafts are per-session scratch; only the consolidated
        // journal memory is worth sharing.
        if (unsynced.metadata.type === 'journal_draft') continue;
        // Refused before and unchanged since: stays local until edited.
        if (unsynced.metadata.sync_rejected && unsynced.metadata.sync_rejected_fp === syncFingerprint(unsynced)) continue;
        // Stamp the last writer's device: pull on this device skips its own
        // echoes, while the same user's other devices still receive the row.
        const doc: DocumentResult = { ...unsynced, metadata: { ...unsynced.metadata, origin_device: getDeviceId() } };
        try {
          batch.push({ doc, upsert: await toUpsert(collection.name, doc) });
        } catch (e) {
          process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${e}\n`);
          stats.errors++;
        }
      }

      await pushBatch(backend, collection.name, batch, stats, true);

      if (stats.pushed + stats.linked > before) pushedCollections.push(collection.name);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push error for collection ${collection.name}: ${e}\n`);
      noteSyncError(e);
      stats.errors++;
      if (isCycleFatal(e)) break;
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

async function toUpsert(collection: string, doc: DocumentResult): Promise<UpsertDoc> {
  const now = Math.floor(Date.now() / 1000);
  // Embedding for similarity search and the server's vector column. An
  // empty vector is refused remotely (embedding_dimension) and the doc kept local.
  const embedding = (await generateEmbedding(doc.content)) ?? [];
  return {
    id: doc.id,
    collection,
    content: doc.content,
    embedding,
    metadata: stripLocalOnly(doc.metadata),
    origin_user: getConfig().USERNAME,
    created_at: doc.metadata.created_at ?? now,
    updated_at: doc.metadata.updated_at ?? doc.metadata.created_at ?? now,
  };
}

/**
 * Upsert one collection's batch and apply each outcome locally. `allowRekey`:
 * an `id_taken` task is renamed and pushed again once in the same cycle.
 */
async function pushBatch(
  backend: SyncBackend,
  collection: string,
  batch: Array<{ doc: DocumentResult; upsert: UpsertDoc }>,
  stats: PushStats,
  allowRekey: boolean,
): Promise<void> {
  if (batch.length === 0) return;
  let outcomes: UpsertOutcome[];
  try {
    outcomes = await backend.upsertMany(batch.map(b => b.upsert));
  } catch (e) {
    stats.errors += batch.length - 1; // the caller counts one more
    throw e;
  }

  const retry: Array<{ doc: DocumentResult; upsert: UpsertDoc }> = [];
  for (let i = 0; i < batch.length; i++) {
    const { doc, upsert } = batch[i];
    const outcome = outcomes[i];
    try {
      if (outcome.ok) {
        await applyPushed(backend, collection, doc, outcome.similar, stats);
      } else if (outcome.code === 'id_taken' && allowRekey && doc.metadata.type === 'task') {
        const renamed = await rekeyTask(collection, doc, outcome.suggestedId);
        stats.renamed++;
        retry.push({ doc: renamed, upsert: { ...upsert, id: renamed.id, metadata: stripLocalOnly(renamed.metadata) } });
      } else if (outcome.permanent) {
        await markRejected(collection, doc, outcome.code, outcome.message);
        stats.rejected++;
      } else {
        process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${outcome.code}: ${outcome.message}\n`);
        noteSyncError(`${doc.id}: ${outcome.code}: ${outcome.message}`);
        stats.errors++;
      }
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${e}\n`);
      stats.errors++;
    }
  }
  await pushBatch(backend, collection, retry, stats, false);
}

async function applyPushed(
  backend: SyncBackend,
  collection: string,
  doc: DocumentResult,
  similar: Array<{ id: string; similarity: number }>,
  stats: PushStats,
): Promise<void> {
  // A re-push of an edited doc matches its own remote row; never self-link.
  const match = similar.find(s => s.id !== doc.id);
  const metadata = stripLocalOnly(doc.metadata);
  if (!match) {
    await updateDocument(collection, doc.id, { ...metadata, is_synced: true });
    stats.pushed++;
    return;
  }
  // Found a similar doc: link both ways (both are kept; the link records the relationship).
  try {
    await backend.addRelatedIds(match.id, [doc.id]);
    await backend.addRelatedIds(doc.id, [match.id]);
  } catch (e) {
    process.stderr.write(`[yapa-sync] Link error for ${doc.id} -> ${match.id}: ${e}\n`);
  }
  const related = Array.isArray(metadata.related_ids) ? [...metadata.related_ids] : [];
  if (!related.includes(match.id)) related.push(match.id);
  await updateDocument(collection, doc.id, { ...metadata, related_ids: related, is_synced: true });
  stats.linked++;
}

/** Keep a refused doc local and unsynced, flagged so it is not resent until it changes. */
async function markRejected(collection: string, doc: DocumentResult, code: string, message: string): Promise<void> {
  await updateDocument(collection, doc.id, {
    ...doc.metadata,
    is_synced: false,
    sync_rejected: code,
    sync_rejected_message: message.slice(0, 300),
    sync_rejected_fp: syncFingerprint(doc),
  });
  process.stderr.write(`[yapa-sync] Not syncing ${doc.id} (${collection}): ${code}: ${message}. It stays local and is retried after it changes.\n`);
}

/** Docs currently refused by the remote (kept local), for `sync status`. */
export async function listRejectedDocs(): Promise<Array<{ collection: string; id: string; code: string }>> {
  const out: Array<{ collection: string; id: string; code: string }> = [];
  for (const col of await listCollections()) {
    if (!isSyncable(col.name)) continue;
    const docs = await getDocumentsByFilter(col.name, { is_synced: false }, 100_000).catch(() => []);
    for (const d of docs) {
      if (d.metadata.sync_rejected && d.metadata.sync_rejected_fp === syncFingerprint(d)) {
        out.push({ collection: col.name, id: d.id, code: String(d.metadata.sync_rejected) });
      }
    }
  }
  return out;
}

/**
 * Task ids are sequential per user (`user-302`), so a wiped store or a second
 * machine can mint an id that already belongs to a DIFFERENT task remotely.
 * The remote refuses to overwrite it (`id_taken`, with a suggested id); give
 * this task a fresh id: the higher of the local next id and the suggestion.
 */
export async function rekeyTask(collection: string, doc: DocumentResult, suggestedId?: string): Promise<DocumentResult> {
  const { getNextTaskId } = await import('../tasks/create.js');
  const me = getConfig().USERNAME;
  const localNext = Number((await getNextTaskId()).split('-').pop());
  const suggested = Number(suggestedId?.split('-').pop());
  const n = Math.max(localNext, Number.isFinite(suggested) ? suggested : 0);
  const newId = `${me}-${n}`;
  const metadata = { ...doc.metadata, id: newId, rekeyed_from: doc.id };
  await addDocument(collection, newId, doc.content, metadata);
  await deleteDocument(collection, doc.id);
  process.stderr.write(`[yapa-sync] Task id ${doc.id} already belongs to a different task on the shared remote; renamed this task to ${newId}\n`);
  return { ...doc, id: newId, metadata };
}

/**
 * Delete this user's shared rows for docs in private collection `collection`.
 * Each doc is checked once per version: `remote_checked_at` records the
 * updated_at that was checked (private docs never sync, so the marker stays
 * local), keeping steady-state cycles free of remote lookups.
 */
async function retractSharedCopies(backend: SyncBackend, collection: string): Promise<number> {
  const versionOf = (d: DocumentResult) => Number(d.metadata.updated_at ?? d.metadata.created_at ?? 0);
  const unchecked = (await getDocumentsByFilter(collection, {}, 100_000)).filter(d =>
    !d.id.startsWith('__') && d.metadata.type !== 'journal_draft' && d.metadata.remote_checked_at !== versionOf(d));
  if (unchecked.length === 0) return 0;

  const me = getConfig().USERNAME;
  const remote = await backend.ownersByIds(unchecked.map(d => d.id));
  // Same id is not proof of the same doc: task ids are `user-N`, and a task
  // minted in a private collection is invisible to the remote max, so
  // another device can reuse its number for a different shared task. Only
  // retract a row created at the same moment as this doc.
  const mine = unchecked.filter(d => {
    const row = remote.get(d.id);
    const localCreated = Number(d.metadata.created_at);
    return row?.owner === me
      && (!d.metadata.origin_user || d.metadata.origin_user === me)
      && Number.isFinite(localCreated) && localCreated > 0
      && Math.abs(row.createdAt - localCreated) <= 1;
  });
  const removed = mine.length > 0 ? await backend.delete(mine.map(d => d.id), 'retract') : 0;
  if (removed > 0) process.stderr.write(`[yapa-sync] Removed ${removed} shared cop${removed === 1 ? 'y' : 'ies'} of docs now in ${collection}\n`);
  for (const d of unchecked) await updateDocument(collection, d.id, { ...d.metadata, remote_checked_at: versionOf(d) });
  return removed;
}
