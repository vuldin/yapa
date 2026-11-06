import { getConfig } from '../config.js';
import { queueSyncDeletes, addLocalTombstones } from '../sync/deletes.js';
import { moveOwnLeases } from '../sync/coordination.js';
import { removeSyncSubscriptions, getSyncSubscriptions, updateSyncSubscriptions, addCollectionRedirect, addLeftCollection, clearCollectionRedirect, clearLeftCollection, rejoinCollection } from '../sync/sentinel.js';
import { withDocLock } from '../doc-lock.js';
import { isPushable, isRejectedUnchanged, pushDocsNow } from '../sync/push.js';
import {
  addDocument,
  addDocumentsBatch,
  deleteDocument,
  getDocumentsByFilter,
  getDocumentsByIds,
  listCollections as chromaListCollections,
  createCollection as chromaCreateCollection,
  deleteCollection as chromaDeleteCollection,
  getCollectionCount,
} from '../store/index.js';
import { isSyncableCollection, isReadOnlyDoc } from '../sync/syncable.js';
import { isSyncConfigured, remoteDataRules } from '../sync/backend.js';

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

/**
 * Create a new collection. Creating a name that was merged away on this
 * machine brings it back: its redirect is dropped.
 */
export async function createNewCollection(name: string): Promise<void> {
  await chromaCreateCollection(name);
  await clearCollectionRedirect(name);
  // Left earlier: followed again, with its whole history on the next pull.
  if (isSyncable(name)) await rejoinCollection(name);
  else await clearLeftCollection(name);
}

const isSyncable = isSyncableCollection;

export interface RemoveCollectionOptions {
  /**
   * `local` (default): remove the collection from this machine only. A shared
   * collection stays on the sync service for teammates; this machine stops
   * following it. `everyone`: also delete your documents in it from the sync
   * service, for every teammate (teammates' own documents stay there).
   */
  scope?: 'local' | 'everyone';
  /** The exact collection name: required when the delete loses data (see removeCollection). */
  confirm?: string;
  /** Skip the guard (internal callers that already confirmed). */
  force?: boolean;
  /** Internal: record a shared collection as left (default true; a merge records a redirect instead). */
  markLeft?: boolean;
}

export interface RemoveCollectionResult {
  name: string;
  scope: 'local' | 'everyone';
  /** Documents removed from this machine. */
  removed: number;
  /** Your unpushed documents pushed first, so the team copy has them. */
  pushed: number;
  /** Your documents queued for deletion on the sync service (scope `everyone`). */
  deletedRemotely: number;
  /** True when the collection syncs (shared), false for private-*, local-*, global. */
  shared: boolean;
}

/** A refused `removeCollection`: it would lose data, and was not confirmed. */
export class CollectionDeleteRefusedError extends Error {
  readonly code = 'collection_delete_refused';
  constructor(message: string, readonly documentCount: number) {
    super(message);
    this.name = 'CollectionDeleteRefusedError';
  }
}

/**
 * Delete a collection. Nothing a teammate has is lost unless the caller asks
 * for scope `everyone`; nothing only this machine has is lost without `confirm`:
 *
 * - shared, scope `local`, sync on: your unpushed documents are pushed first
 *   (refused if that fails, unless confirmed), then the collection is removed
 *   here, unsubscribed and recorded as left (sentinel.ts). Teammates and the
 *   sync service keep everything; `sync subscribe` brings it back.
 * - shared, scope `everyone`: requires `confirm`. Your documents are deleted
 *   on the sync service (and so from teammates' machines); teammates' own
 *   documents stay there, tombstoned here.
 * - local-only (private-*, local-*, global), or shared with sync off: there is
 *   no other copy, so a non-empty collection requires `confirm`.
 */
export async function removeCollection(name: string, opts: RemoveCollectionOptions = {}): Promise<RemoveCollectionResult> {
  const scope = opts.scope ?? 'local';
  const shared = isSyncable(name);
  const syncOn = getConfig().SYNC_ENABLED;
  const docs = (await getDocumentsByFilter(name, {}, 100_000).catch(() => [])).filter(d => !d.id.startsWith('__'));
  const result: RemoveCollectionResult = { name, scope, removed: docs.length, pushed: 0, deletedRemotely: 0, shared };
  const confirmed = !!opts.force || opts.confirm === name;
  const refuse = (why: string) => {
    throw new CollectionDeleteRefusedError(
      `Refused: ${why} This is not a merge: to combine it with another collection, use collection_merge (it keeps every document). `
      + `To delete it anyway, confirm with the user, then pass confirm: "${name}".`,
      docs.length,
    );
  };
  const n = `${docs.length} document${docs.length === 1 ? '' : 's'}`;

  if (docs.length > 0 && !confirmed) {
    if (!shared) refuse(`"${name}" is local only, with ${n} and no copy anywhere else: deleting it is permanent.`);
    if (!syncOn) refuse(`"${name}" has ${n} and sync is off, so this machine holds the only copy: deleting it is permanent.`);
    if (scope === 'everyone') {
      refuse(`deleting "${name}" for everyone removes your documents in it from the sync service and from every teammate's machine (${n} here).`);
    }
  }

  const me = getConfig().USERNAME;
  const mine = (d: { metadata: Record<string, any> }) => !d.metadata.origin_user || d.metadata.origin_user === me;
  if (shared && syncOn && scope === 'local') {
    // Refused by the sync service (a secret, a bad embedding) and unchanged
    // since: no push will take it, so this machine holds the only copy.
    const stuck = docs.filter(d => d.metadata.is_synced === false && isRejectedUnchanged(d));
    if (stuck.length && !confirmed) {
      refuse(`${stuck.length} document${stuck.length === 1 ? '' : 's'} in "${name}" (${stuck.slice(0, 3).map(d => d.id).join(', ')}${stuck.length > 3 ? ', ...' : ''}) ${stuck.length === 1 ? 'was refused by the sync service and exists' : 'were refused by the sync service and exist'} only on this machine: deleting it here loses ${stuck.length === 1 ? 'it' : 'them'}.`);
    }
    // Everything else only this machine has reaches the team copy first:
    // your new docs, and your edits to teammates' docs (the service keeps
    // the owner and records you as the last editor).
    const unpushed = docs.filter(isPushable).map(d => d.id);
    if (unpushed.length) {
      const r = await pushDocsNow(name, unpushed).catch(() => ({ pushed: [] as string[], errors: unpushed.length }));
      result.pushed = r.pushed.length;
      // Not "no errors": with the service unreachable nothing is pushed and nothing errs.
      const missing = unpushed.length - r.pushed.length;
      if (missing > 0 && !confirmed) {
        refuse(`${missing} of your documents in "${name}" could not be pushed to the sync service, so deleting it here would lose them.`);
      }
    }
  }
  if (shared && syncOn && scope === 'everyone') {
    const real = docs.filter(d => d.metadata.type !== 'journal_draft');
    const own = real.filter(mine).map(d => d.id);
    await queueSyncDeletes(own, name);
    await addLocalTombstones(real.filter(d => !mine(d)).map(d => d.id));
    result.deletedRemotely = own.length;
  }
  // With sync off too: a subscription left behind would recreate the
  // collection (and backfill it) as soon as sync is turned on.
  if (shared) {
    await removeSyncSubscriptions([name]);
    if (scope === 'local' && (opts.markLeft ?? true)) await addLeftCollection(name);
  }
  await chromaDeleteCollection(name);
  return result;
}

/** One line for the user: what a removeCollection did. */
export function removeReport(r: RemoveCollectionResult): string {
  const docs = `${r.removed} document${r.removed === 1 ? '' : 's'}`;
  if (!r.shared) return `Deleted "${r.name}" (${docs}) from this machine. It was local only, so it is gone.`;
  if (r.scope === 'everyone') {
    return `Deleted "${r.name}" (${docs}) here and, for everyone, your ${r.deletedRemotely} document${r.deletedRemotely === 1 ? '' : 's'} in it on the sync service. Teammates' own documents in it stay shared.`;
  }
  return `Removed "${r.name}" (${docs}) from this machine only${r.pushed ? ` after pushing ${r.pushed} unpushed document${r.pushed === 1 ? '' : 's'} of yours` : ''}. `
    + `Teammates and the sync service keep it; this machine no longer follows it (sync subscribe ${r.name} to follow it again).`;
}

export interface MergeResult {
  from: string;
  into: string;
  /** Recording the redirect failed after the move (the source may come back in its folder). */
  redirectError?: string;
  /** Your live claims on the moved tasks, re-acquired in `into`; `kept` stayed in `from`; `unchecked`: they could not be read. */
  leases?: { moved: number; kept: string[]; unchecked?: boolean };
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
  /**
   * Shared -> private merges only: an upper bound on your own docs whose
   * shared rows the next push removes from the sync service (retracts), as
   * for any doc moved into a private collection. Every doc of yours that
   * retraction checks is counted; only those that reached the service have a
   * row to remove.
   */
  ownRowsRetracted: number;
  /** The sync service declares it cannot erase, so retracted rows keep their content there, hidden. */
  remoteKeepsContent?: boolean;
  /** Sync is on but the service's data rules are not known yet (nothing has asked it this run). */
  remoteRulesUnknown?: boolean;
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
 * copy on pull. Nothing is queued for remote deletion. Into a private
 * collection, the next push instead retracts your own shared rows (push.ts
 * retractSharedCopies); teammates' rows stay shared in `from`.
 *
 * Once merged, `from` redirects to `into` on this machine (a local sentinel
 * in `global`): scope detection and writes naming `from` follow it, `from`
 * is unsubscribed (with sync off too), and sync never brings it back from
 * teammates' rows. `sync subscribe from` follows it again. The redirect is
 * per machine: another device of the same user still follows `from` until
 * it is merged there too.
 *
 * Safety rules:
 * - `into` must already exist: new collection names are confirmed with the
 *   user and created first.
 * - `global` is never a source: it holds this machine's sync sentinels.
 * - A private source (`private-*`, `local-*`) never merges into a
 *   shared target: that would publish private notes to the whole team.
 * - Shared -> private is allowed: the next push retracts this user's shared
 *   copies, as for any doc moved into a private collection.
 * - An id already present in `into` aborts before anything is written.
 * - The source is deleted only after the target holds every moved doc.
 */
export async function mergeCollections(from: string, into: string, opts: { dryRun?: boolean } = {}): Promise<MergeResult> {
  if (from === into) throw new Error('Source and target are the same collection');
  if (from === 'global') {
    // global holds this machine's sync state (subscriptions, pull point,
    // merge redirects) next to its notes; moving it would lose all of that.
    throw new Error('Refused: "global" cannot be merged into another collection. It holds this machine\'s sync state (subscriptions, pull point, merge redirects). Move specific memories with memory_store instead.');
  }
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
  const sharedToPrivate = isSyncable(from) && !isSyncable(into);
  const teammateRowsKept = sharedToPrivate
    ? docs.filter(d => d.metadata.origin_user && d.metadata.origin_user !== me).length
    : 0;
  // Upper bound on what retractSharedCopies removes: every doc of yours it
  // checks (it also retracts synced docs with unpushed edits, so is_synced is
  // no guide). Docs that never reached the service have no row to remove.
  const ownRowsRetracted = sharedToPrivate
    ? docs.filter(d => !d.id.startsWith('__') && d.metadata.type !== 'journal_draft' && !isReadOnlyDoc(d.metadata)
      && (!d.metadata.origin_user || d.metadata.origin_user === me) && Number(d.metadata.created_at) > 0).length
    : 0;
  const result: MergeResult = {
    from, into, moved: docs.length, byType, dryRun: !!opts.dryRun, sourceRemoved: false, teammateRowsKept, ownRowsRetracted,
  };
  if (ownRowsRetracted > 0 && isSyncConfigured()) {
    const rules = await remoteDataRules({ cachedOnly: true });
    if (!rules) result.remoteRulesUnknown = true;
    else if (rules.erasure === 'none') result.remoteKeepsContent = true;
  }
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

    // Each source doc leaves under its lock, and one edited since it was
    // copied (an update that landed mid-merge) is copied again first.
    const copied = new Map(docs.map(d => [d.id, JSON.stringify([d.content, d.metadata])]));
    for (const id of ids) {
      await withDocLock(from, id, async () => {
        const [cur] = await getDocumentsByIds(from, [id]);
        if (cur && JSON.stringify([cur.content, cur.metadata]) !== copied.get(id)) {
          const metadata: Record<string, any> = { ...cur.metadata, is_synced: false };
          delete metadata.remote_checked_at;
          await addDocument(into, id, cur.content, metadata);
        }
        await deleteDocument(from, id);
      });
    }
    const left = await getCollectionCount(from);
    if (left !== 0) throw new Error(`"${from}" still holds ${left} document(s) after the move; it was not deleted`);
  }
  // Empty now, so this only unsubscribes and drops the local collection; the
  // service holds no rows in it once the moved docs are pushed.
  await removeCollection(from, { force: true, markLeft: false });
  result.sourceRemoved = true;
  // Teammates' rows keep `from` alive remotely: without this, the next prompt
  // in its folder (or a recovery pull) would recreate and re-follow it.
  try {
    await addCollectionRedirect(from, into);
  } catch (e) {
    result.redirectError = e instanceof Error ? e.message : String(e);
  }
  const leases = await moveOwnLeases(from, into, docs.filter(d => d.metadata.type === 'task').map(d => d.id));
  if (leases.moved || leases.kept.length || leases.unchecked) result.leases = leases;
  return result;
}

function erasureLines(r: MergeResult): string[] {
  if (r.remoteKeepsContent) return ['This sync service cannot erase: it keeps their content, hidden from everyone. Ask its administrators to remove it for good.'];
  if (r.remoteRulesUnknown) return ["This sync service's data rules aren't known yet (see `sync status`): if it cannot erase, it keeps their content."];
  return [];
}

/**
 * The user-facing report of a merge, shared by the MCP and DSH tools. For a
 * shared -> private merge it spells out what happens on the sync service:
 * your shared rows are retracted at the next push, teammates' rows stay
 * shared in `from`, and `from` is not followed again unless asked.
 */
export function mergeReportLines(r: MergeResult): string[] {
  const types = Object.entries(r.byType).sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${n} ${t}`).join(', ') || 'none';
  const sharedToPrivate = isSyncable(r.from) && !isSyncable(r.into);
  const docs = (n: number) => `${n} doc${n === 1 ? '' : 's'}`;
  if (r.dryRun) {
    const lines = [`Dry run: would move ${r.moved} document(s) from "${r.from}" into "${r.into}" (${types}), then remove "${r.from}". Nothing changed.`];
    if (sharedToPrivate && r.ownRowsRetracted > 0) {
      lines.push(`Up to ${docs(r.ownRowsRetracted)} of yours would be removed from the shared copy (retracted) at the next push (those that reached the sync service).`);
      lines.push(...erasureLines(r));
    }
    if (sharedToPrivate && r.teammateRowsKept > 0) {
      lines.push(`${docs(r.teammateRowsKept)} by teammates would stay shared in "${r.from}" (you would keep a private copy).`);
    }
    return lines;
  }
  const lines = [`Moved ${r.moved} document(s) from "${r.from}" into "${r.into}" (${types}) and removed the empty "${r.from}".`];
  if (sharedToPrivate) {
    if (r.ownRowsRetracted > 0) {
      lines.push(`Up to ${docs(r.ownRowsRetracted)} of yours will be removed from the shared copy (retracted) at the next push (those that reached the sync service).`);
      lines.push(...erasureLines(r));
    }
    if (r.teammateRowsKept > 0) {
      lines.push(`${r.teammateRowsKept} teammates' docs stay shared in "${r.from}" (you now have a private copy; only their owners can remove the shared rows).`);
    }
  }
  if (r.redirectError) lines.push(`Could not record that "${r.from}" moved here (${r.redirectError}): a prompt in its folder may recreate it; run collection_merge again to record it.`);
  if (r.leases?.moved) lines.push(`${r.leases.moved} of your claims moved with their tasks to "${r.into}".`);
  if (r.leases?.kept.length) lines.push(`Claims still on "${r.from}" (the target refused them): ${r.leases.kept.join(', ')}.`);
  if (r.leases?.unchecked) lines.push(`Your claims in "${r.from}" could not be checked (the sync service did not answer): claim the moved tasks you were working on again in "${r.into}".`);
  if (isSyncable(r.from)) {
    lines.push(`"${r.from}" won't come back here (sync subscribe ${r.from} to follow it again).`);
    lines.push(
      `This redirect is for this machine only. Another device of yours still follows "${r.from}": run the same merge there`
      + (sharedToPrivate
        ? ` too. Until then it drops its unedited copies of your retracted docs when the retraction reaches it, and a copy it edited can be pushed back into "${r.from}".`
        : ' too.'),
    );
  }
  return lines;
}
