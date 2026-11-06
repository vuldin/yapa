import { addDocument, getOrCreateCollection, getDocumentsByFilter } from '../store/index.js';
import { withDocLock } from '../doc-lock.js';

const SYNC_PULL_SENTINEL_ID = '__sync_pull_sentinel__';
const SYNC_SUBSCRIPTIONS_ID = '__sync_subscriptions__';

/**
 * Get the timestamp of the last successful pull.
 * Returns 0 if no pull has ever been done (will pull everything).
 */
export async function getSyncPullTimestamp(): Promise<number> {
  try {
    const results = await getDocumentsByFilter('global', {
      type: { $eq: 'sync_pull_sentinel' },
    }, 1);

    if (results.length === 0) return 0;
    return (results[0].metadata.last_pull as number) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Update the pull timestamp (defaults to now).
 */
export async function updateSyncPullTimestamp(at: number = Math.floor(Date.now() / 1000)): Promise<void> {
  await getOrCreateCollection('global');
  await addDocument('global', SYNC_PULL_SENTINEL_ID, 'sync pull sentinel', {
    type: 'sync_pull_sentinel',
    last_pull: at,
  });
}

/**
 * Get the list of remote collections the user has subscribed to for pull sync.
 */
export async function getSyncSubscriptions(): Promise<string[]> {
  try {
    const results = await getDocumentsByFilter('global', {
      type: { $eq: 'sync_subscriptions' },
    }, 1);

    if (results.length === 0) return [];
    const raw = results[0].metadata.collections as string;
    if (!raw) return [];
    return raw.split(',').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Update the list of subscribed remote collections.
 */
export async function updateSyncSubscriptions(collections: string[]): Promise<void> {
  await getOrCreateCollection('global');
  const deduped = [...new Set(collections)].sort();
  await addDocument('global', SYNC_SUBSCRIPTIONS_ID, 'sync subscriptions', {
    type: 'sync_subscriptions',
    collections: deduped.join(','),
  });
}

/** Subscribe to `names` (read and written under the subscriptions lock). Returns the list before and the names added. */
export async function addSyncSubscriptions(names: string[]): Promise<{ before: string[]; added: string[] }> {
  return withDocLock('global', SYNC_SUBSCRIPTIONS_ID, async () => {
    const before = await getSyncSubscriptions();
    const added = [...new Set(names)].filter(n => !before.includes(n));
    if (added.length) await updateSyncSubscriptions([...before, ...added]);
    return { before, added };
  });
}

/** Unsubscribe from `names` under the subscriptions lock. Returns the list before and the names removed. */
export async function removeSyncSubscriptions(names: string[]): Promise<{ before: string[]; removed: string[] }> {
  return withDocLock('global', SYNC_SUBSCRIPTIONS_ID, async () => {
    const before = await getSyncSubscriptions();
    const drop = new Set(names);
    const removed = before.filter(n => drop.has(n));
    if (removed.length) await updateSyncSubscriptions(before.filter(n => !drop.has(n)));
    return { before, removed };
  });
}

const COLLECTION_REDIRECTS_ID = '__collection_redirects__';

/**
 * Collections merged away on this machine: `{ from: into }`. Written by
 * `mergeCollections` and kept in `global` beside the subscriptions, so it
 * never syncs. Scope detection follows it (a folder whose collection was
 * merged lands in the target), and sync never re-follows a redirected name
 * from teammates' rows: no backfill, no recovery or push auto-subscribe.
 * An explicit `sync subscribe` (or creating the collection again) clears it.
 */
export async function getCollectionRedirects(): Promise<Record<string, string>> {
  try {
    const results = await getDocumentsByFilter('global', {
      type: { $eq: 'collection_redirects' },
    }, 1);
    if (results.length === 0) return {};
    // The store adapters decode the JSON object; accept a raw string too.
    const raw = results[0].metadata.redirects ?? {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeCollectionRedirects(redirects: Record<string, string>): Promise<void> {
  await getOrCreateCollection('global');
  await addDocument('global', COLLECTION_REDIRECTS_ID, 'collection redirects', {
    type: 'collection_redirects',
    redirects, // stored as JSON by the adapters
  });
}

/** Record that `from` was merged into `into`. `into` is live again, so a redirect away from it is dropped. */
export async function addCollectionRedirect(from: string, into: string): Promise<void> {
  if (from === into || from === 'global') return;
  await withDocLock('global', COLLECTION_REDIRECTS_ID, async () => {
    const redirects = await getCollectionRedirects();
    redirects[from] = into;
    delete redirects[into];
    await writeCollectionRedirects(redirects);
  });
}

/** Forget the redirect for `name` (the user wants that collection back). No-op without one. */
export async function clearCollectionRedirect(name: string): Promise<void> {
  await withDocLock('global', COLLECTION_REDIRECTS_ID, async () => {
    const redirects = await getCollectionRedirects();
    if (!Object.hasOwn(redirects, name)) return;
    delete redirects[name];
    await writeCollectionRedirects(redirects);
  });
}

const COLLECTIONS_LEFT_ID = '__collections_left__';

/**
 * Shared collections removed from this machine only (`collection_delete`
 * with scope `local`): teammates keep them on the sync service, and this
 * machine stops following them. Kept in `global` beside the subscriptions,
 * so it never syncs. Like a redirect, a left name is never re-followed
 * implicitly (no backfill, recovery or push auto-subscribe, no pull); an
 * explicit `sync subscribe` or `collection_create` clears it.
 */
export async function getLeftCollections(): Promise<string[]> {
  try {
    const r = await getDocumentsByFilter('global', { type: { $eq: 'collections_left' } }, 1);
    const raw = r[0]?.metadata.collections;
    return Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(',').filter(Boolean);
  } catch {
    return [];
  }
}

async function writeLeftCollections(names: string[]): Promise<void> {
  await getOrCreateCollection('global');
  await addDocument('global', COLLECTIONS_LEFT_ID, 'collections removed from this machine', {
    type: 'collections_left',
    collections: [...new Set(names)].sort().join(','),
  });
}

/** Record that this machine left the shared collection `name`. */
export async function addLeftCollection(name: string): Promise<void> {
  await withDocLock('global', COLLECTIONS_LEFT_ID, async () => {
    const left = await getLeftCollections();
    if (!left.includes(name)) await writeLeftCollections([...left, name]);
  });
}

/** Follow `name` again (the user subscribed to it or created it). No-op when not left. */
export async function clearLeftCollection(name: string): Promise<void> {
  await withDocLock('global', COLLECTIONS_LEFT_ID, async () => {
    const left = await getLeftCollections();
    if (left.includes(name)) await writeLeftCollections(left.filter(n => n !== name));
  });
}

/**
 * Names this machine never follows implicitly: merged away (redirects) or
 * left. Backfill, pulls, recovery and push auto-subscribe all skip them.
 */
export async function getUnfollowedCollections(): Promise<Set<string>> {
  return new Set([...Object.keys(await getCollectionRedirects()), ...(await getLeftCollections())]);
}

/**
 * Where `name` lives now: follows redirect chains (a -> b -> c), stopping at
 * a cycle. `redirectedFrom` is set when `name` itself was merged away.
 */
export function resolveCollectionRedirect(
  name: string,
  redirects: Record<string, string>,
): { collection: string; redirectedFrom?: string } {
  let current = name;
  const seen = new Set<string>([name]);
  while (Object.hasOwn(redirects, current)) {
    const next = redirects[current];
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === name ? { collection: name } : { collection: current, redirectedFrom: name };
}

/** Where a write naming `requested` lands (see `resolveWriteCollection`). */
export interface WriteCollection {
  collection: string;
  /** Set when `requested` was merged away here and the write follows the redirect. */
  redirectedFrom?: string;
}

/**
 * The collection a user write naming `name` must go to: a collection merged
 * away on this machine is followed to where its docs went, so a hardcoded
 * old name (in a CLAUDE.md, a memory, a script) never recreates it and has
 * the next push publish into it again. Used by every write entry point
 * (memory store, task create, external put, journal); a read store failure
 * leaves the name as is.
 */
export async function resolveWriteCollection(name: string): Promise<WriteCollection> {
  if (name === 'global') return { collection: name };
  const w = resolveCollectionRedirect(name, await getCollectionRedirects());
  // Removed from this machine: a write would bring it back pushed but never
  // pulled (teammates' docs missing from recall). Following it again is explicit.
  if ((await getLeftCollections()).includes(w.collection)) throw new CollectionLeftError(w.collection);
  return w;
}

/** A write to a collection removed from this machine (collection_delete, scope local). */
export class CollectionLeftError extends Error {
  readonly code = 'collection_left';
  constructor(readonly collection: string) {
    super(`"${collection}" was removed from this machine (collection_delete), so writes to it are refused: written here it would be pushed but never pulled, and teammates' documents in it would be missing. To follow it again with its full history, run sync subscribe ${collection} (or collection_create ${collection}), then write again.`);
    this.name = 'CollectionLeftError';
  }
}

const COLLECTIONS_BACKFILL_ID = '__collections_backfill__';

/**
 * Collections to pull from the start of their history on the next pull (a
 * collection followed again after leaving it): kept until a pull of it
 * succeeds, so an offline moment can't leave it with only recent docs.
 */
export async function getPendingBackfills(): Promise<string[]> {
  try {
    const r = await getDocumentsByFilter('global', { type: { $eq: 'collections_backfill' } }, 1);
    return String(r[0]?.metadata.collections ?? '').split(',').filter(Boolean);
  } catch {
    return [];
  }
}

async function writePendingBackfills(names: string[]): Promise<void> {
  await getOrCreateCollection('global');
  await addDocument('global', COLLECTIONS_BACKFILL_ID, 'collections to backfill', {
    type: 'collections_backfill',
    collections: [...new Set(names)].sort().join(','),
  });
}

export async function addPendingBackfill(name: string): Promise<void> {
  await withDocLock('global', COLLECTIONS_BACKFILL_ID, async () => {
    const p = await getPendingBackfills();
    if (!p.includes(name)) await writePendingBackfills([...p, name]);
  });
}

export async function clearPendingBackfill(name: string): Promise<void> {
  await withDocLock('global', COLLECTIONS_BACKFILL_ID, async () => {
    const p = await getPendingBackfills();
    if (p.includes(name)) await writePendingBackfills(p.filter(n => n !== name));
  });
}

/**
 * Follow a collection left earlier again: no longer left, subscribed, and
 * marked for a full-history backfill on the next pull. No-op for a name
 * that was not left.
 */
export async function rejoinCollection(name: string): Promise<boolean> {
  if (!(await getLeftCollections()).includes(name)) return false;
  await clearLeftCollection(name);
  await addSyncSubscriptions([name]);
  await addPendingBackfill(name);
  return true;
}

/** The tool-reply note for a write that followed a redirect (empty when none). */
export function redirectNote(w: WriteCollection): string {
  return w.redirectedFrom
    ? `"${w.redirectedFrom}" was merged into "${w.collection}" on this machine, so this was written to "${w.collection}".`
    : '';
}
