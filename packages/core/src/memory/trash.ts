/**
 * What is left of documents deleted on the sync service, on this machine:
 * copies archived as deleted upstream (sync/pull.ts) when their owner deleted
 * them. They are hidden from recall and task lists and never pushed; they can
 * be kept (as a new document of your own), and they go after
 * DELETED_RETENTION_DAYS. Your own deleted documents live on the service
 * (soft delete) and are listed and restored through it (sync backend
 * listDeleted / restore).
 *
 * @module @yapa/core/memory/trash
 */
import { getConfig } from '../config.js';
import { withDocLock } from '../doc-lock.js';
import { deleteDocument, getDocumentsByFilter, getDocumentsByIds, listCollections } from '../store/index.js';
import { isDeletedUpstream, isSyncableCollection } from '../sync/syncable.js';
import { getSyncBackend, isSyncConfigured, UnsupportedByRemoteError, type DeletedDocument, type RestoreResult } from '../sync/backend.js';
import { queueSyncPurges } from '../sync/deletes.js';
import { storeMemory } from './store.js';
import { createTask } from '../tasks/create.js';

export interface TrashedCopy {
  id: string;
  collection: string;
  type: string;
  content: string;
  deleted_by: string;
  /** Unix seconds. */
  deleted_at: number;
  reason: string;
  /** Unix seconds when the retention sweep removes it. */
  expires_at: number;
}

const DAY = 86400;

function toCopy(collection: string, d: { id: string; content: string; metadata: Record<string, any> }): TrashedCopy {
  const at = Number(d.metadata.deleted_upstream_at) || 0;
  return {
    id: d.id, collection, type: String(d.metadata.type ?? 'memory'), content: d.content,
    deleted_by: String(d.metadata.deleted_upstream_by ?? ''), deleted_at: at,
    reason: String(d.metadata.deleted_upstream_reason ?? 'delete'),
    expires_at: at + getConfig().DELETED_RETENTION_DAYS * DAY,
  };
}

/** Copies kept here after their owners deleted them upstream (newest first). */
export async function listDeletedUpstream(collection?: string): Promise<TrashedCopy[]> {
  const names = collection ? [collection] : (await listCollections().catch(() => [])).map(c => c.name);
  const out: TrashedCopy[] = [];
  for (const c of names) {
    for (const d of await getDocumentsByFilter(c, { archived: true }, 100_000).catch(() => [])) {
      if (isDeletedUpstream(d.metadata) && !(d.metadata.parent_id && (d.metadata.chunk_index ?? 0) !== 0)) out.push(toCopy(c, d));
    }
  }
  return out.sort((a, b) => b.deleted_at - a.deleted_at);
}

/** Remove copies deleted upstream longer than DELETED_RETENTION_DAYS ago. Returns how many. */
export async function sweepDeletedUpstream(now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const cutoff = now - getConfig().DELETED_RETENTION_DAYS * DAY;
  let n = 0;
  for (const c of (await listCollections().catch(() => [])).map(x => x.name)) {
    for (const d of await getDocumentsByFilter(c, { archived: true }, 100_000).catch(() => [])) {
      if (!isDeletedUpstream(d.metadata) || Number(d.metadata.deleted_upstream_at) > cutoff) continue;
      await deleteDocument(c, d.id).catch(() => undefined);
      n++;
    }
  }
  return n;
}

/**
 * Keep a copy someone else deleted upstream: it becomes a new memory or task
 * of yours in the same collection (pushed like any other), and the archived
 * copy goes. Returns the new id.
 */
export async function keepDeletedUpstream(id: string, collection: string): Promise<{ id: string; type: string }> {
  return withDocLock(collection, id, async () => {
    const [d] = await getDocumentsByIds(collection, [id]);
    if (!d || !isDeletedUpstream(d.metadata)) throw new Error(`${id} is not a deleted copy in ${collection}`);
    const m = d.metadata;
    const tags = Array.isArray(m.tags) ? m.tags : String(m.tags ?? '').split(',').filter(Boolean);
    let newId: string;
    if (m.type === 'task') {
      newId = await createTask(d.content, { priority: m.priority, tags, notes: m.notes ? `${m.notes}\n(kept from ${id}, deleted by ${m.deleted_upstream_by})` : `(kept from ${id}, deleted by ${m.deleted_upstream_by})` }, collection);
    } else {
      // A memory stored in chunks: all of them, in order.
      const base = m.parent_id ?? d.id;
      const chunks = m.parent_id
        ? (await getDocumentsByFilter(collection, { parent_id: base }, 1000)).sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0))
        : [d];
      newId = (await storeMemory(chunks.map(c => c.content).join('\n'), { collection, tags, salience: m.salience })).ids[0];
      for (const c of chunks) if (c.id !== id) await deleteDocument(collection, c.id);
    }
    await deleteDocument(collection, id);
    return { id: newId, type: String(m.type ?? 'memory') };
  });
}

// ------------------------------------------------------------ on the remote

export interface TrashListing {
  /** Copies kept here after their owners deleted them upstream. */
  upstream: TrashedCopy[];
  /** Your own deleted documents on the sync service, restorable within its retention. */
  remote: DeletedDocument[];
  /** Why `remote` is empty when it is not known: sync off, offline, or an older service. */
  remoteUnavailable?: string;
}

export async function listTrash(collection?: string): Promise<TrashListing> {
  const out: TrashListing = { upstream: await listDeletedUpstream(collection), remote: [] };
  if (!isSyncConfigured()) {
    out.remoteUnavailable = 'sync is off';
    return out;
  }
  try {
    const backend = await getSyncBackend();
    if (!backend?.listDeleted) out.remoteUnavailable = 'this sync target has no soft delete';
    else out.remote = await backend.listDeleted(collection);
  } catch (e) {
    out.remoteUnavailable = e instanceof UnsupportedByRemoteError ? e.message : `the sync service could not be asked: ${(e as Error).message}`;
  }
  return out;
}

/**
 * Restore your own deleted documents on the sync service; the next pull
 * brings each back here (over an archived copy, on every teammate's machine
 * too). Throws UnsupportedByRemoteError on an older service.
 */
export async function restoreDeleted(ids: string[]): Promise<RestoreResult[]> {
  if (!isSyncConfigured()) throw new Error('restore needs the sync service (sync is off)');
  const backend = await getSyncBackend();
  if (!backend?.restore) throw new UnsupportedByRemoteError('restore');
  return backend.restore([...new Set(ids)]);
}

export interface PurgeQueued {
  /** Removed here and queued for a purge on the next push. */
  queued: string[];
  /** Removed here only: in a local-only collection (no remote copy), or sync is off. */
  local: string[];
  /** Not yours: only the owner can purge a document. */
  refused: Array<{ id: string; collection: string; owner: string }>;
}

/**
 * Purge documents of yours for good: a mistake such as a leaked secret. Each
 * is removed here at once (with its chunks) and, in a shared collection,
 * queued for a purge on the next push. Ids not found here are queued too:
 * the service may still hold them as deleted rows.
 */
export async function purgeDocuments(ids: string[]): Promise<PurgeQueued> {
  const me = getConfig().USERNAME;
  const out: PurgeQueued = { queued: [], local: [], refused: [] };
  const collections = (await listCollections().catch(() => [])).map(c => c.name);
  for (const id of [...new Set(ids)]) {
    let found: { collection: string; metadata: Record<string, any> } | undefined;
    for (const c of collections) {
      const [d] = await getDocumentsByIds(c, [id]).catch(() => []);
      if (d) { found = { collection: c, metadata: d.metadata }; break; }
    }
    if (found && found.metadata.origin_user && found.metadata.origin_user !== me) {
      out.refused.push({ id, collection: found.collection, owner: String(found.metadata.origin_user) });
      continue;
    }
    if (found) {
      await withDocLock(found.collection, id, async () => {
        for (const c of await getDocumentsByFilter(found!.collection, { parent_id: id }, 1000).catch(() => [])) await deleteDocument(found!.collection, c.id);
        await deleteDocument(found!.collection, id);
      });
    }
    if (found && (!isSyncableCollection(found.collection) || !isSyncConfigured())) out.local.push(id);
    else out.queued.push(id);
  }
  await queueSyncPurges(out.queued);
  return out;
}
