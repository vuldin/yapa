import { getConfig } from '../config.js';
import { listCollections, addDocument, deleteDocument, getOrCreateCollection, getDocumentsByIds, getDocumentsByFilter, queryDocuments, updateDocument } from '../store/index.js';

import { getRemoteDocsSince, addRemoteRelatedIds, getRemoteCollectionsForUser, getRemoteCollectionsByIds, type RemoteDocument } from './postgres.js';
import { getSyncPullTimestamp, updateSyncPullTimestamp, getSyncSubscriptions, updateSyncSubscriptions } from './sentinel.js';
import { getLocalTombstones } from './deletes.js';
import { getDeviceId } from './device.js';

/** Collection prefixes that should not be synced. */
function isSyncable(collectionName: string): boolean {
  return !collectionName.startsWith('private-') && !collectionName.startsWith('local-');
}

/**
 * Personal collections sync only between the same user's devices. `global`
 * holds cross-cutting personal notes (preferences, PTO, writing style), so a
 * teammate never receives it unless its OWNER opted in with
 * YAPA_SYNC_SHARE_GLOBAL=true (stamped on each pushed row as
 * `share_global`) and the reader opted in too.
 */
export function isPersonalCollection(collectionName: string): boolean {
  return collectionName === 'global';
}

export interface PullStats {
  pulled: number;
  /** Existing local docs replaced by a newer remote version. */
  updated: number;
  /** Local copies relocated (or dropped) because the doc moved collections remotely. */
  moved: number;
  linked: number;
  skipped: number;
  errors: number;
}

export function emptyPullStats(): PullStats {
  return { pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, errors: 0 };
}

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

  const cycleStartedAt = Math.floor(Date.now() / 1000) - getConfig().SYNC_PULL_OVERLAP_SECONDS;
  const lastPull = await getSyncPullTimestamp();

  // A store that has never pulled is new or was wiped (the April 2026 data
  // loss: a container recreated without its volume). Rebuild it: subscribe to
  // every collection this user has written to and accept this device's own
  // rows once, which normal pulls skip as echoes.
  const recovering = lastPull === 0;
  if (recovering) {
    try {
      const mine = (await getRemoteCollectionsForUser(getConfig().USERNAME)).filter(isSyncable);
      const subs = await getSyncSubscriptions();
      const add = mine.filter(c => !subs.includes(c));
      if (add.length) await updateSyncSubscriptions([...subs, ...add]);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Recovery subscribe failed: ${e}\n`);
    }
  }
  const collections = await listCollections();
  const localCollectionNames = new Set(collections.map(c => c.name));

  // Build pull list: local syncable collections + subscribed remote-only collections
  const pullCollectionNames: string[] = [];
  for (const col of collections) {
    if (isSyncable(col.name)) pullCollectionNames.push(col.name);
  }

  const backfill = new Set<string>();
  const subscriptions = await getSyncSubscriptions();
  for (const sub of subscriptions) {
    if (!localCollectionNames.has(sub) && isSyncable(sub)) {
      await getOrCreateCollection(sub);
      pullCollectionNames.push(sub);
      backfill.add(sub);
    }
  }

  const followed = new Set(pullCollectionNames);
  for (const collectionName of pullCollectionNames) {
    await pullCollection(collectionName, backfill.has(collectionName) ? 0 : lastPull, stats, {
      includeOwnDevice: recovering,
      followedCollections: followed,
    });
  }

  await updateSyncPullTimestamp(cycleStartedAt);

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
  } = {},
): Promise<PullStats> {
  if (!isSyncable(collectionName)) return stats;
  if (opts.followedCollections) {
    await dropMovedOut(collectionName, opts.followedCollections, stats).catch(e => {
      process.stderr.write(`[yapa-sync] Move check failed for ${collectionName}: ${e}\n`);
      stats.errors++;
    });
  }
  try {
    const remoteDocs = await getRemoteDocsSince(
      collectionName,
      since,
      { user: getConfig().USERNAME, device: getDeviceId() },
      {
        onlyOwnRows: isPersonalCollection(collectionName),
        orOwnerShared: getConfig().SYNC_SHARE_GLOBAL,
        includeOwnDevice: opts.includeOwnDevice,
      },
    );
    if (remoteDocs.length === 0) return stats;

    const tombstones = await getLocalTombstones();
    await getOrCreateCollection(collectionName);
    for (const remoteDoc of remoteDocs) {
      try {
        // Tombstoned here, or another session's journal scratch (drafts are
        // never shared; only consolidated journals are).
        if (tombstones.has(remoteDoc.id) || remoteDoc.metadata?.type === 'journal_draft') {
          stats.skipped++;
          continue;
        }
        await applyRemoteDoc(collectionName, remoteDoc, stats);
      } catch (e) {
        process.stderr.write(`[yapa-sync] Pull error for ${remoteDoc.id}: ${e}\n`);
        stats.errors++;
      }
    }
  } catch (e) {
    process.stderr.write(`[yapa-sync] Pull error for collection ${collectionName}: ${e}\n`);
    stats.errors++;
  }
  return stats;
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
async function dropMovedOut(collectionName: string, followed: Set<string>, stats: PullStats): Promise<void> {
  const local = (await getDocumentsByFilter(collectionName, {}, 100_000))
    .filter(d => !d.id.startsWith('__') && d.metadata.type !== 'journal_draft' && d.metadata.is_synced !== false);
  if (local.length === 0) return;
  const remote = await getRemoteCollectionsByIds(local.map(d => d.id));
  for (const doc of local) {
    const now = remote.get(doc.id);
    if (!now || now === collectionName || followed.has(now)) continue;
    await deleteDocument(collectionName, doc.id);
    stats.moved++;
  }
}

async function applyRemoteDoc(collectionName: string, remoteDoc: RemoteDocument, stats: PullStats): Promise<void> {
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
    const localDirty = existing.metadata.is_synced === false;
    const localUpdated = toUnixSeconds(existing.metadata.updated_at ?? existing.metadata.created_at);
    if (!localDirty && toUnixSeconds(remoteDoc.updated_at) > localUpdated) {
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
        const localDoc = similarLocal[0];
        const localRelated = Array.isArray(localDoc.metadata.related_ids) ? localDoc.metadata.related_ids : [];
        if (!localRelated.includes(remoteDoc.id)) {
          localRelated.push(remoteDoc.id);
          await updateDocument(collectionName, localDoc.id, { ...localDoc.metadata, related_ids: localRelated });
        }
        await addRemoteRelatedIds(remoteDoc.id, [localDoc.id]);
        stats.linked++;
      }
    }
  } catch {
    // Query failed (e.g., empty collection) — proceed with insert
  }

  await addDocument(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
  stats.pulled++;
}
