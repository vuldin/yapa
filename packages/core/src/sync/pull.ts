import { withDocLock } from '../doc-lock.js';
import { getConfig } from '../config.js';
import { listCollections, addDocument, deleteDocument, getOrCreateCollection, getDocumentsByIds, getDocumentsByFilter, queryDocuments, updateDocument, patchDocument } from '../store/index.js';

import { getSyncBackend, isCycleFatal, noteSyncError, resolveSyncUsername, type RemoteDeletion, type RemoteDocument, type SyncBackend } from './backend.js';
import { addSyncSubscriptions, getSyncPullTimestamp, updateSyncPullTimestamp, getSyncSubscriptions, updateSyncSubscriptions, getUnfollowedCollections, getPendingBackfills, clearPendingBackfill } from './sentinel.js';
import { getLocalTombstones } from './deletes.js';
import { getDeviceId } from './device.js';

import { isDeletedUpstream, isSyncableCollection as isSyncable } from './syncable.js';

export interface PullStats {
  pulled: number;
  /** Existing local docs replaced by a newer remote version. */
  updated: number;
  /** Local copies relocated (or dropped) because the doc moved collections remotely. */
  moved: number;
  linked: number;
  skipped: number;
  /** Clean local copies removed because the doc was deleted remotely. */
  deleted: number;
  /** Clean copies of docs deleted remotely: archived here as deleted upstream (restorable). */
  archived: number;
  /** Docs deleted remotely whose local copy has unpushed edits: kept (the next push re-creates them). */
  keptDirty: number;
  errors: number;
}

export function emptyPullStats(): PullStats {
  return { pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, archived: 0, keptDirty: 0, errors: 0 };
}

/** Safety cap on pages per collection per call (500 docs each). */
const MAX_PULL_PAGES = 200;

/**
 * Pull new and updated documents from the remote database into the local store.
 * - Reads every syncable local collection plus subscribed remote-only ones
 * - Collections subscribed since the last cycle backfill their full history
 * - The stored pull timestamp is the cycle START minus an overlap window, so a
 *   doc pushed by someone else while this pull ran is re-read next cycle
 *   instead of falling behind the timestamp forever (re-reads skip by ID)
 */
export async function pullFromRemote(): Promise<PullStats> {
  const stats = emptyPullStats();
  const backend = await getSyncBackend();
  if (!backend) return stats;
  await resolveSyncUsername();

  const cycleStartedAt = Math.floor(Date.now() / 1000) - getConfig().SYNC_PULL_OVERLAP_SECONDS;
  const lastPull = await getSyncPullTimestamp();

  // A store that has never pulled is new or was wiped (the April 2026 data
  // loss: a container recreated without its volume). Rebuild it: subscribe to
  // every collection this user has written to and accept this device's own
  // rows once, which normal pulls skip as echoes.
  const recovering = lastPull === 0;
  if (recovering) {
    try {
      // A collection merged away here stays away, even though the remote
      // still lists it for this user (teammates' rows, or rows not yet moved).
      const unfollowed = await getUnfollowedCollections();
      const mine = (await backend.collectionsForUser()).filter(c => isSyncable(c) && !unfollowed.has(c));
      await addSyncSubscriptions(mine);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Recovery subscribe failed: ${e}\n`);
      noteSyncError(e);
      // Not signed in / unreachable: keep the store marked as never-pulled so
      // recovery runs again next cycle.
      if (isCycleFatal(e)) {
        stats.errors++;
        return stats;
      }
    }
  }
  const collections = await listCollections();
  const localCollectionNames = new Set(collections.map(c => c.name));

  // Build pull list: local syncable collections + subscribed remote-only collections.
  // A name merged away on this machine is never pulled: a subscription left
  // behind (a merge with sync off, an older version) must not recreate it.
  const unfollowed = await getUnfollowedCollections();
  const pullCollectionNames: string[] = [];
  for (const col of collections) {
    if (isSyncable(col.name) && !unfollowed.has(col.name)) pullCollectionNames.push(col.name);
  }

  // Followed again after leaving it: from the start of its history.
  const pendingBackfills = (await getPendingBackfills()).filter(n => !unfollowed.has(n));
  const backfill = new Set<string>(pendingBackfills);
  const subscriptions = await getSyncSubscriptions();
  for (const sub of subscriptions) {
    if ((!localCollectionNames.has(sub) || backfill.has(sub)) && isSyncable(sub) && !unfollowed.has(sub)) {
      await getOrCreateCollection(sub);
      if (!pullCollectionNames.includes(sub)) pullCollectionNames.push(sub);
      backfill.add(sub);
    }
  }

  const followed = new Set(pullCollectionNames);
  let fatal = false;
  for (const collectionName of pullCollectionNames) {
    const errorsBefore = stats.errors;
    await pullCollection(collectionName, backfill.has(collectionName) ? 0 : lastPull, stats, {
      includeOwnDevice: recovering,
      followedCollections: followed,
      onFatal: () => { fatal = true; },
    });
    if (fatal) break;
    if (pendingBackfills.includes(collectionName) && stats.errors === errorsBefore) await clearPendingBackfill(collectionName);
  }

  // A cycle cut short (not signed in, unreachable) must not advance the pull
  // point past docs it never read.
  if (!fatal) await updateSyncPullTimestamp(cycleStartedAt);

  return stats;
}

/**
 * Pull one collection's remote docs newer than `since` into the local store.
 * Does not advance the shared pull timestamp, so it is safe to call
 * out-of-band (a prompt hook freshening the active collection, or a
 * subscription backfill with `since = 0`).
 */
export async function pullCollection(
  collectionName: string,
  since: number,
  stats: PullStats = emptyPullStats(),
  opts: {
    includeOwnDevice?: boolean;
    /**
     * Full sync cycles pass the set of collections this store follows; it
     * enables the moved-out check (one id lookup per collection), which the
     * per-prompt hook skips to stay fast.
     */
    followedCollections?: Set<string>;
    /** Called when the remote is unusable for the rest of the cycle (auth, network). */
    onFatal?: () => void;
  } = {},
): Promise<PullStats> {
  if (!isSyncable(collectionName)) return stats;
  const backend = await getSyncBackend();
  if (!backend) return stats;
  const failed = (what: string, e: unknown) => {
    process.stderr.write(`[yapa-sync] ${what}: ${e}\n`);
    noteSyncError(e);
    stats.errors++;
    if (isCycleFatal(e)) opts.onFatal?.();
    return isCycleFatal(e);
  };
  if (opts.followedCollections) {
    let fatal = false;
    await dropMovedOut(backend, collectionName, opts.followedCollections, stats).catch(e => {
      fatal = failed(`Move check failed for ${collectionName}`, e);
    });
    if (fatal) return stats;
  }
  try {
    let tombstones: Set<string> | undefined;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const res = await backend.pull(collectionName, { since, cursor, includeOwnDevice: opts.includeOwnDevice });
      if (res.documents.length > 0 || res.deletions.length > 0) {
        await getOrCreateCollection(collectionName);
        tombstones ??= await getLocalTombstones();
        // Deletions first: a doc deleted and then re-created comes back in
        // the documents feed and must survive. A deletion of an id that this
        // pull returned as a live row is older than that row.
        for (const d of res.documents) seen.add(d.id);
        for (const del of res.deletions) {
          if (seen.has(del.id)) continue;
          try {
            await applyRemoteDeletion(collectionName, del, stats);
          } catch (e) {
            process.stderr.write(`[yapa-sync] Pull delete error for ${del.id}: ${e}\n`);
            stats.errors++;
          }
        }
        for (const remoteDoc of res.documents) {
          try {
            // Tombstoned here, or another session's journal scratch (drafts are
            // never shared; only consolidated journals are).
            if (tombstones.has(remoteDoc.id) || remoteDoc.metadata?.type === 'journal_draft') {
              stats.skipped++;
              continue;
            }
            await applyRemoteDoc(backend, collectionName, remoteDoc, stats);
          } catch (e) {
            process.stderr.write(`[yapa-sync] Pull error for ${remoteDoc.id}: ${e}\n`);
            stats.errors++;
          }
        }
      }
      if (!res.hasMore || !res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
  } catch (e) {
    failed(`Pull error for collection ${collectionName}`, e);
  }
  return stats;
}

/**
 * A doc deleted remotely by its owner. Nothing is lost here:
 * - a copy with unpushed local edits is kept live (its next push re-creates
 *   the shared row), as before;
 * - a clean copy is archived as deleted upstream (isDeletedUpstream): hidden,
 *   never pushed, restorable, removed after DELETED_RETENTION_DAYS.
 * Two exceptions drop the copy instead:
 * - a purge (the owner removing a mistake such as a leaked secret), edited
 *   or not;
 * - a teammate's retract (they moved the doc to a private collection, so no
 *   shared copy should stay), when this copy is clean. Your own retract is
 *   archived: a private collection doesn't sync between your machines, so
 *   this may be your only copy here.
 */
async function applyRemoteDeletion(collectionName: string, del: RemoteDeletion, stats: PullStats): Promise<void> {
  await withDocLock(collectionName, del.id, async () => {
    const [existing] = await getDocumentsByIds(collectionName, [del.id]).catch(() => []);
    if (!existing) return;
    if (del.purged) {
      await deleteDocument(collectionName, del.id);
      stats.deleted++;
      if (existing.metadata.is_synced === false) process.stderr.write(`[yapa-sync] ${del.id} was purged by ${del.deleted_by}: dropped here, with its unpushed edits\n`);
      return;
    }
    if (existing.metadata.is_synced === false && !isDeletedUpstream(existing.metadata)) {
      stats.keptDirty++;
      process.stderr.write(`[yapa-sync] ${del.id} was deleted remotely by ${del.deleted_by}, but this copy has unpushed edits: kept (it will be pushed again)\n`);
      return;
    }
    if (del.reason === 'retract' && del.deleted_by !== getConfig().USERNAME) {
      await deleteDocument(collectionName, del.id);
      stats.deleted++;
      return;
    }
    if (isDeletedUpstream(existing.metadata)) return;
    await patchDocument(collectionName, del.id, {
      archived: true,
      // Equality-filterable marker, so the trash and its sweep needn't scan every archived doc.
      deleted_upstream: true,
      deleted_upstream_by: del.deleted_by,
      deleted_upstream_at: Number(del.deleted_at) || Math.floor(Date.now() / 1000),
      deleted_upstream_reason: del.reason ?? 'delete',
    });
    stats.archived++;
  });
}

function toUnixSeconds(value: Date | number | string | undefined | null): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

function localMetadataFor(remoteDoc: RemoteDocument): Record<string, any> {
  return {
    ...remoteDoc.metadata,
    origin_user: remoteDoc.origin_user,
    related_ids: remoteDoc.related_ids,
    updated_at: toUnixSeconds(remoteDoc.updated_at) || remoteDoc.metadata?.updated_at,
    is_synced: true, // Already synced from remote
  };
}

/** This id's copies in OTHER local collections (normally none). */
async function copiesElsewhere(id: string, except: string): Promise<Array<{ collection: string; dirty: boolean }>> {
  const out: Array<{ collection: string; dirty: boolean }> = [];
  for (const col of await listCollections()) {
    // A private copy is personal: a shared row moving never relocates it.
    if (col.name === except || !isSyncable(col.name)) continue;
    const [doc] = await getDocumentsByIds(col.name, [id]).catch(() => []);
    if (doc) out.push({ collection: col.name, dirty: doc.metadata.is_synced === false });
  }
  return out;
}

/**
 * Moved out: a clean local copy whose remote row now lives in a collection
 * this store doesn't follow is dropped (it left the shared collection we
 * follow). If we DO follow the destination, that collection's pull relocates
 * it instead. Copies with unpushed local edits are kept; their push moves the
 * remote row back.
 */
async function dropMovedOut(backend: SyncBackend, collectionName: string, followed: Set<string>, stats: PullStats): Promise<void> {
  const local = (await getDocumentsByFilter(collectionName, {}, 100_000))
    .filter(d => !d.id.startsWith('__') && d.metadata.type !== 'journal_draft' && d.metadata.is_synced !== false);
  if (local.length === 0) return;
  const remote = await backend.collectionsByIds(local.map(d => d.id));
  for (const doc of local) {
    const now = remote.get(doc.id);
    if (!now || now === collectionName || followed.has(now)) continue;
    await deleteDocument(collectionName, doc.id);
    stats.moved++;
  }
}

/**
 * Apply one remote doc under the doc's lock, deciding from the local copy as
 * it is now (not one read before a local edit). Linking it to a similar local
 * doc happens after the lock is released: it takes the other doc's own lock,
 * and it makes a network call.
 */
async function applyRemoteDoc(backend: SyncBackend, collectionName: string, remoteDoc: RemoteDocument, stats: PullStats): Promise<void> {
  const after: Array<() => Promise<void>> = [];
  await withDocLock(collectionName, remoteDoc.id, () => applyRemoteDocLocked(backend, collectionName, remoteDoc, stats, after));
  for (const fn of after) await fn().catch(e => process.stderr.write(`[yapa-sync] Link error for ${remoteDoc.id}: ${e}\n`));
}

async function applyRemoteDocLocked(backend: SyncBackend, collectionName: string, remoteDoc: RemoteDocument, stats: PullStats, after: Array<() => Promise<void>>): Promise<void> {
  const [existing] = await getDocumentsByIds(collectionName, [remoteDoc.id]).catch(() => []);

  if (!existing) {
    // Moved in: the doc may still sit in its previous collection here. Local
    // unpushed edits win (the next push moves the remote row back); otherwise
    // relocate it so the store never holds two copies.
    const elsewhere = await copiesElsewhere(remoteDoc.id, collectionName);
    if (elsewhere.some(c => c.dirty)) {
      stats.skipped++;
      return;
    }
    if (elsewhere.length > 0) {
      for (const c of elsewhere) await deleteDocument(c.collection, remoteDoc.id);
      await addDocument(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
      stats.moved++;
      return;
    }
  }

  if (existing) {
    // Remote edits (a teammate completing a task, a re-stored correction) win
    // when they're newer AND this copy has no unpushed local edits — a dirty
    // local copy is pushed next cycle and becomes the newer version instead.
    // A copy archived as deleted upstream never goes back, so its local edits
    // don't count: the owner restoring the doc brings the live one back.
    const upstreamGone = isDeletedUpstream(existing.metadata);
    const localDirty = existing.metadata.is_synced === false && !upstreamGone;
    const localUpdated = toUnixSeconds(existing.metadata.updated_at ?? existing.metadata.created_at);
    if (upstreamGone || (!localDirty && toUnixSeconds(remoteDoc.updated_at) > localUpdated)) {
      await addDocument(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
      stats.updated++;
    } else {
      stats.skipped++;
    }
    return;
  }

  // New doc. Check for a near-identical local doc and cross-link them
  // (both are kept — the link just records the relationship).
  try {
    const similarLocal = await queryDocuments(collectionName, remoteDoc.content, 1);
    if (similarLocal.length > 0) {
      // Cosine distance: similarity = 1 - distance
      const similarity = 1 - similarLocal[0].distance;
      if (similarity > getConfig().SYNC_SIMILARITY_THRESHOLD) {
        const localId = similarLocal[0].id;
        after.push(async () => {
          // The local doc's own lock, over its metadata as it is now.
          await withDocLock(collectionName, localId, async () => {
            const [cur] = await getDocumentsByIds(collectionName, [localId]);
            if (!cur) return;
            const related = Array.isArray(cur.metadata.related_ids) ? [...cur.metadata.related_ids] : [];
            if (!related.includes(remoteDoc.id)) await patchDocument(collectionName, localId, { related_ids: [...related, remoteDoc.id] });
          });
          await backend.addRelatedIds(remoteDoc.id, [localId]);
        });
        stats.linked++;
      }
    }
  } catch {
    // Query failed (e.g., empty collection) — proceed with insert
  }

  await addDocument(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
  stats.pulled++;
}
