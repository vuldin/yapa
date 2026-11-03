/**
 * Session-scope inference: map the session cwd to the YAPA collection all
 * memory/task calls should use. Lives in its own module (no cordis/dsh
 * imports) so the rule stays trivially testable.
 *
 * The rule, per the operator's model — almost every folder under a project
 * root is a project; some folders are customer names:
 *
 *   1. Only `customer-{segment}` exists  → customer- (established customer scope stays sticky)
 *   2. Only `project-{segment}` exists   → project-
 *   3. Both exist                        → genuinely ambiguous: default reads to
 *      project-, but flag `ambiguous` so the injector can tell the agent to ASK
 *      the user which collection to use before storing
 *   4. Neither exists                    → `customers` config list decides
 *      (known customer folders), else project- (the common case); a customer
 *      folder becomes sticky the first time its customer- collection exists
 *
 * Anything outside the configured roots (or a dot-folder) → `global`.
 *
 * Before any of that, an explicit `COLLECTION_MAP` entry (`path=collection`)
 * decides: the longest path that holds the cwd wins, and its collection is
 * used as-is (never ambiguous). This is how a folder gets a `private-*` or
 * `local-*` scope, which the roots rule never produces.
 *
 * Last, a collection merged away on this machine (`collection_merge`) is
 * followed to its target, so a folder keeps landing where its notes went.
 *
 * Shared by every host: the Claude Code hooks (roots/customers/map from
 * `YAPA_PROJECT_ROOTS` / `YAPA_CUSTOMERS` / `YAPA_COLLECTION_MAP`) and the
 * DSH plugin (its own config).
 *
 * @module @yapa/core/scope
 */
import { getConfig } from './config.js';
import { listCollections } from './store/index.js';
import { getCollectionRedirects, resolveCollectionRedirect } from './sync/sentinel.js';
import { isSyncableCollection } from './sync/syncable.js';

/** Outcome of scope inference for one session cwd. */
export interface CollectionDetection {
  /**
   * Collection to use for reads/background writes. On ambiguity this is the
   * project- candidate; the agent switches both read and write scope to the
   * user's answer.
   */
  collection: string;
  /**
   * Set when both a `customer-` and a `project-` collection exist for the
   * segment: the two candidates, project first. The injector surfaces this so
   * the agent asks the user instead of silently picking one.
   */
  ambiguous?: [string, string];
  /** The cwd matched a `COLLECTION_MAP` entry. */
  mapped?: true;
  /**
   * The folder's collection was merged into `collection` on this machine;
   * this is its old name.
   */
  redirectedFrom?: string;
}

/**
 * The `COLLECTION_MAP` entry whose path holds `cwd` (path boundaries
 * respected: `/a/acme` never claims `/a/acme-old`), longest path first.
 * Entries without `=`, or with an empty side, are ignored.
 */
export function matchCollectionMap(cwd: string, entries: string[]): string | undefined {
  let best: { path: string; collection: string } | undefined;
  for (const entry of entries) {
    const eq = entry.lastIndexOf('=');
    if (eq < 0) continue;
    const path = entry.slice(0, eq).trim().replace(/(.)\/+$/, '$1');
    const collection = entry.slice(eq + 1).trim();
    if (!path || !collection) continue;
    const prefix = path.endsWith('/') ? path : `${path}/`;
    if (cwd !== path && !cwd.startsWith(prefix)) continue;
    if (!best || path.length > best.path.length) best = { path, collection };
  }
  return best?.collection;
}

/**
 * Infer the active collection from the session cwd: a `COLLECTION_MAP` entry
 * first, else the first path segment under a configured project root,
 * prefixed per the module rule above; then follow local merge redirects.
 */
export async function detectCollection(
  cwd: string | undefined,
  roots: string[] = getConfig().PROJECT_ROOTS,
  customers: string[] = getConfig().CUSTOMERS,
  map: string[] = getConfig().COLLECTION_MAP,
): Promise<CollectionDetection> {
  if (!cwd) return { collection: 'global' };
  const mapped = matchCollectionMap(cwd, map);
  if (mapped) return follow({ collection: mapped, mapped: true }, await getCollectionRedirects());
  for (const rawRoot of roots) {
    const root = rawRoot.replace(/\/+$/, '');
    // Path-boundary match: root /a/proj must not claim /a/projects-x.
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    const relative = cwd.slice(root.length).replace(/^\/+/, '');
    const segment = relative.split('/')[0];
    if (!segment || segment.startsWith('.')) return { collection: 'global' };
    const existing = (await listCollections().catch(() => [])).map(c => c.name);
    const redirects = await getCollectionRedirects();
    // A collection merged away still counts as this folder's (a customer-
    // folder stays sticky after its collection moved), and is then followed.
    const known = (name: string) => existing.includes(name) || Object.prototype.hasOwnProperty.call(redirects, name);
    const hasCustomer = known(`customer-${segment}`);
    const hasProject = known(`project-${segment}`);
    if (hasCustomer && hasProject) {
      return follow({
        collection: `project-${segment}`,
        ambiguous: [`project-${segment}`, `customer-${segment}`],
      }, redirects);
    }
    if (hasCustomer) return follow({ collection: `customer-${segment}` }, redirects);
    if (hasProject) return follow({ collection: `project-${segment}` }, redirects);
    if (customers.includes(segment)) return follow({ collection: `customer-${segment}` }, redirects);
    return follow({ collection: `project-${segment}` }, redirects);
  }
  return { collection: 'global' };
}

/**
 * Notes for a host's `**Scope:**` line, with a leading space (empty if none):
 * a local-only collection says it never syncs (`global` is everyone's
 * default and goes unremarked), and a redirected folder names its old
 * collection.
 */
export function scopeNotes(d: CollectionDetection): string {
  const notes: string[] = [];
  if (d.collection !== 'global' && !isSyncableCollection(d.collection)) notes.push('(local only, never synced)');
  if (d.redirectedFrom) notes.push(`(merged from \`${d.redirectedFrom}\`)`);
  return notes.length ? ` ${notes.join(' ')}` : '';
}

/** Apply merge redirects to a detection (both ambiguity candidates too). */
function follow(d: CollectionDetection, redirects: Record<string, string>): CollectionDetection {
  const { collection, redirectedFrom } = resolveCollectionRedirect(d.collection, redirects);
  const out: CollectionDetection = { ...d, collection };
  if (redirectedFrom) out.redirectedFrom = redirectedFrom;
  if (d.ambiguous) {
    const [a, b] = d.ambiguous.map(n => resolveCollectionRedirect(n, redirects).collection);
    if (a === b) delete out.ambiguous;
    else out.ambiguous = [a, b];
  }
  return out;
}
