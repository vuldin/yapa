import { getConfig } from '../config.js';
import { listCollections, addDocument, getOrCreateCollection, getDocumentsByIds, queryDocuments, updateDocument } from '../store/index.js';

import { getRemoteDocsSince, addRemoteRelatedIds, getRemoteCollectionsForUser, type RemoteDocument } from './postgres.js';
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
 * teammate subscribing to the shared DB must not receive it unless the team
 * opts in with YAPA_SYNC_SHARE_GLOBAL=true.
 */
export function isPersonalCollection(collectionName: string): boolean {
  return collectionName === 'global' && !getConfig().SYNC_SHARE_GLOBAL;
}

export interface PullStats {
  pulled: number;
  /** Existing local docs replaced by a newer remote version. */
  updated: number;
  linked: number;
  skipped: number;
  errors: number;
}

export function emptyPullStats(): PullStats {
  return { pulled: 0, updated: 0, linked: 0, skipped: 0, errors: 0 };
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

  for (const collectionName of pullCollectionNames) {
    await pullCollection(collectionName, backfill.has(collectionName) ? 0 : lastPull, stats, { includeOwnDevice: recovering });
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
  opts: { includeOwnDevice?: boolean } = {},
): Promise<PullStats> {
  if (!isSyncable(collectionName)) return stats;
  try {
    const remoteDocs = await getRemoteDocsSince(
      collectionName,
      since,
      { user: getConfig().USERNAME, device: getDeviceId() },
      { onlyOwnRows: isPersonalCollection(collectionName), includeOwnDevice: opts.includeOwnDevice },
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

async function applyRemoteDoc(collectionName: string, remoteDoc: RemoteDocument, stats: PullStats): Promise<void> {
  const [existing] = await getDocumentsByIds(collectionName, [remoteDoc.id]).catch(() => []);

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
