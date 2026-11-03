import { addDocument, getOrCreateCollection, getDocumentsByFilter } from '../store/index.js';

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
  const redirects = await getCollectionRedirects();
  redirects[from] = into;
  delete redirects[into];
  await writeCollectionRedirects(redirects);
}

/** Forget the redirect for `name` (the user wants that collection back). No-op without one. */
export async function clearCollectionRedirect(name: string): Promise<void> {
  const redirects = await getCollectionRedirects();
  if (!(name in redirects)) return;
  delete redirects[name];
  await writeCollectionRedirects(redirects);
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
  while (Object.prototype.hasOwnProperty.call(redirects, current)) {
    const next = redirects[current];
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === name ? { collection: name } : { collection: current, redirectedFrom: name };
}
