import { getConfig } from '../config.js';
import { queueSyncDeletes, addLocalTombstones } from '../sync/deletes.js';
import { getSyncSubscriptions, updateSyncSubscriptions } from '../sync/sentinel.js';
import {
  addDocumentsBatch,
  deleteDocument,
  getDocumentsByFilter,
  getDocumentsByIds,
  listCollections as chromaListCollections,
  createCollection as chromaCreateCollection,
  deleteCollection as chromaDeleteCollection,
  getCollectionCount,
} from '../store/index.js';
import { isSyncableCollection } from '../sync/syncable.js';

export interface CollectionInfo {
  name: string;
  id: string;
  documentCount: number;
}

/** List all collections with document counts. */
export async function listCollectionsWithCounts(): Promise<CollectionInfo[]> {
  const collections = await chromaListCollections();

  const results = await Promise.all(
    collections.map(async (c) => {
      try {
        const count = await getCollectionCount(c.name);
        return { name: c.name, id: c.id, documentCount: count };
      } catch {
        return { name: c.name, id: c.id, documentCount: 0 };
      }
    }),
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Create a new collection. */
export async function createNewCollection(name: string): Promise<void> {
  await chromaCreateCollection(name);
}

const isSyncable = isSyncableCollection;

/** A refused `removeCollection`: shared, non-empty, and not confirmed. */
export class CollectionDeleteRefusedError extends Error {
  constructor(message: string, readonly documentCount: number) {
    super(message);
    this.name = 'CollectionDeleteRefusedError';
  }
}

export interface RemoveCollectionOptions {
  /** Must equal the collection name to delete a non-empty shared collection. */
  confirm?: string;
  /** Skip the guard (internal callers that already confirmed). */
  force?: boolean;
}

/**
 * Delete a collection by name — and make the deletion stick under sync.
 * Before this, deleting a collection was invisible to the shared database:
 * its rows stayed remote forever, and the still-active subscription made the
 * next pull recreate the collection and backfill everything back. Now your
 * own docs are queued for remote deletion, teammates' docs are tombstoned
 * locally (their shared rows stay), and the collection is unsubscribed.
 *
 * Remote deletes are hard deletes for every teammate, so a non-empty shared
 * collection is refused unless `confirm` repeats its name. Deleting is not
 * merging: combining two collections is `mergeCollections`, which keeps
 * every document.
 */
export async function removeCollection(name: string, opts: RemoveCollectionOptions = {}): Promise<void> {
  if (isSyncable(name) && !opts.force && opts.confirm !== name) {
    const docs = await getDocumentsByFilter(name, {}, 100_000).catch(() => []);
    const count = docs.filter(d => !d.id.startsWith('__')).length;
    if (count > 0) {
      const reach = getConfig().SYNC_ENABLED
        ? 'Deleting it permanently deletes the collection for EVERY teammate on the sync service.'
        : 'Deleting it is permanent.';
      throw new CollectionDeleteRefusedError(
        `Refused: "${name}" is a shared collection with ${count} document${count === 1 ? '' : 's'}. ${reach} `
        + 'This is not a merge: to combine it with another collection, use collection_merge (it keeps every document). '
        + `To delete it anyway, confirm with the user, then pass confirm: "${name}".`,
        count,
      );
    }
  }
  if (getConfig().SYNC_ENABLED && isSyncable(name)) {
    const docs = await getDocumentsByFilter(name, {}, 100_000).catch(() => []);
    const me = getConfig().USERNAME;
    const real = docs.filter(d => !d.id.startsWith('__') && d.metadata.type !== 'journal_draft');
    await queueSyncDeletes(real.filter(d => !d.metadata.origin_user || d.metadata.origin_user === me).map(d => d.id), name);
    await addLocalTombstones(real.filter(d => d.metadata.origin_user && d.metadata.origin_user !== me).map(d => d.id));
    const subs = await getSyncSubscriptions();
    if (subs.includes(name)) await updateSyncSubscriptions(subs.filter(s => s !== name));
  }
  await chromaDeleteCollection(name);
}

export interface MergeResult {
  from: string;
  into: string;
  /** Docs moved (or that would move, for a dry run). */
  moved: number;
  /** Moved docs per metadata `type` (memory, task, journal, ...). */
  byType: Record<string, number>;
  dryRun: boolean;
  /** The emptied source collection was deleted. */
  sourceRemoved: boolean;
  /**
   * Shared -> private merges only: teammates' docs whose shared rows stay in
   * the source on the sync service (only the owner can remove a shared row;
   * this store keeps a personal copy).
   */
  teammateRowsKept: number;
}

/** Docs per target write (the store embeds each batch). */
const MERGE_BATCH = 100;

/**
 * Move every document of collection `from` into `into`, then delete the
 * emptied `from`. Ids, content and metadata (created_at, salience, tags,
 * origin_user, related_ids, ...) are kept; the store re-embeds the unchanged
 * content with the same embedder, so the vectors match. Each moved doc is
 * marked unsynced: the next push upserts it under its existing id with the
 * new collection, which the sync service applies as an in-place move (the
 * row keeps its owner and is never deleted), and other devices relocate their
 * copy on pull. Nothing is queued for remote deletion.
 *
 * Safety rules:
 * - `into` must already exist: new collection names are confirmed with the
 *   user and created first.
 * - A private source (`private-*`, `local-*`, `global`) never merges into a
 *   shared target: that would publish private notes to the whole team.
 * - Shared -> private is allowed: the next push retracts this user's shared
 *   copies, as for any doc moved into a private collection.
 * - An id already present in `into` aborts before anything is written.
 * - The source is deleted only after the target holds every moved doc.
 */
export async function mergeCollections(from: string, into: string, opts: { dryRun?: boolean } = {}): Promise<MergeResult> {
  if (from === into) throw new Error('Source and target are the same collection');
  const names = new Set((await chromaListCollections()).map(c => c.name));
  if (!names.has(from)) throw new Error(`Collection "${from}" not found`);
  if (!names.has(into)) {
    throw new Error(`Target collection "${into}" does not exist. Confirm the name with the user and create it first (collection_create), then merge.`);
  }
  if (!isSyncable(from) && isSyncable(into)) {
    throw new Error(
      `Refused: "${from}" is private (never synced) and "${into}" is shared. Merging would publish every document in "${from}" `
      + 'to all teammates on the sync service. Merge into another private collection, or store the specific documents that should be shared.',
    );
  }

  const docs = await getDocumentsByFilter(from, {}, 100_000);
  const total = await getCollectionCount(from);
  if (docs.length < total) throw new Error(`Could only read ${docs.length} of ${total} documents in "${from}"; nothing was moved`);

  const ids = docs.map(d => d.id);
  const clash = ids.length > 0 ? (await getDocumentsByIds(into, ids).catch(() => [])).map(d => d.id) : [];
  if (clash.length > 0) {
    throw new Error(`"${into}" already holds ${clash.length} id(s) from "${from}" (${clash.slice(0, 5).join(', ')}${clash.length > 5 ? ', ...' : ''}); nothing was moved`);
  }

  const byType: Record<string, number> = {};
  for (const d of docs) {
    const t = String(d.metadata.type ?? 'unknown');
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const me = getConfig().USERNAME;
  const teammateRowsKept = isSyncable(from) && !isSyncable(into)
    ? docs.filter(d => d.metadata.origin_user && d.metadata.origin_user !== me).length
    : 0;
  const result: MergeResult = { from, into, moved: docs.length, byType, dryRun: !!opts.dryRun, sourceRemoved: false, teammateRowsKept };
  if (opts.dryRun) return result;

  if (docs.length > 0) {
    const before = await getCollectionCount(into);
    for (let i = 0; i < docs.length; i += MERGE_BATCH) {
      await addDocumentsBatch(into, docs.slice(i, i + MERGE_BATCH).map(d => {
        const metadata: Record<string, any> = { ...d.metadata, is_synced: false };
        // A doc landing in a private collection gets its shared copy checked afresh.
        delete metadata.remote_checked_at;
        return { id: d.id, content: d.content, metadata };
      }));
    }
    const landed = await getDocumentsByIds(into, ids);
    const after = await getCollectionCount(into);
    if (landed.length !== ids.length || after !== before + ids.length) {
      throw new Error(`Merge verification failed: "${into}" holds ${landed.length} of ${ids.length} moved docs (count ${before} -> ${after}); "${from}" was left intact`);
    }

    for (const id of ids) await deleteDocument(from, id);
    const left = await getCollectionCount(from);
    if (left !== 0) throw new Error(`"${from}" still holds ${left} document(s) after the move; it was not deleted`);
  }
  // Empty now, so this only unsubscribes and drops the local collection; the
  // service holds no rows in it once the moved docs are pushed.
  await removeCollection(from);
  result.sourceRemoved = true;
  return result;
}
