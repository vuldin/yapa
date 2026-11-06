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
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { getConfig } from './config.js';
import { listCollections } from './store/index.js';
import { getCollectionRedirects, getLeftCollections, resolveCollectionRedirect } from './sync/sentinel.js';
import { isSyncableCollection, looksPrivateButShared } from './sync/syncable.js';

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
  /** The collection was removed from this machine (collection_delete, scope local): writes to it are refused. */
  left?: true;
}

/** Path handling for `matchCollectionMap`; tests pass `path.win32` and a stub realpath. */
export interface PathOptions {
  path?: typeof path;
  /** The real path of an existing path, else undefined. */
  realpath?: (p: string) => string | undefined;
}

const realpathOrUndefined = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/**
 * The `COLLECTION_MAP` entry whose path holds `cwd`, longest path first.
 * Paths are compared resolved, on separator boundaries (`/a/acme` never
 * claims `/a/acme-old`), case-insensitively on Windows, and through
 * symlinks: the cwd and each entry that exists also match by their real
 * path. Entries without `=`, with an empty side, or relative are ignored
 * (config parsing already warned about them).
 */
export function matchCollectionMap(cwd: string, entries: string[], opts: PathOptions = {}): string | undefined {
  const P = opts.path ?? path;
  const real = opts.realpath ?? realpathOrUndefined;
  const fold = P.sep === '\\' ? (s: string) => s.toLowerCase() : (s: string) => s;
  const forms = (p: string) => [...new Set([p, real(p)].filter((x): x is string => !!x).map(fold))];
  const here = forms(P.resolve(cwd));
  const holds = (dir: string, c: string) => c === dir || c.startsWith(dir.endsWith(P.sep) ? dir : dir + P.sep);
  let best: { length: number; collection: string } | undefined;
  for (const entry of entries) {
    const eq = entry.lastIndexOf('=');
    if (eq < 0) continue;
    const dir = entry.slice(0, eq).trim();
    const collection = entry.slice(eq + 1).trim();
    if (!dir || !collection || !P.isAbsolute(dir)) continue;
    const resolved = P.resolve(dir);
    if (!forms(resolved).some(d => here.some(c => holds(d, c)))) continue;
    if (!best || resolved.length > best.length) best = { length: resolved.length, collection };
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
  const d = await detect(cwd, roots, customers, map);
  if (d.collection !== 'global' && (await getLeftCollections()).includes(d.collection)) d.left = true;
  return d;
}

async function detect(cwd: string | undefined, roots: string[], customers: string[], map: string[]): Promise<CollectionDetection> {
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
    const known = (name: string) => existing.includes(name) || Object.hasOwn(redirects, name);
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
  else if (d.mapped && looksPrivateButShared(d.collection)) {
    notes.push('(shared: this name syncs; local-only names start with lowercase `private-` or `local-`)');
  }
  if (d.redirectedFrom) notes.push(`(merged from \`${d.redirectedFrom}\`)`);
  if (d.left) notes.push(`(removed from this machine: writes to it are refused; \`sync subscribe ${d.collection}\` follows it again)`);
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

/**
 * True when a detection cached by a long-lived host (the DSH injector keeps
 * one per session) no longer matches this machine's merge redirects: its
 * collection was merged away since, or the redirect it followed was dropped.
 * Re-run `detectCollection` then.
 */
export async function isDetectionStale(d: CollectionDetection): Promise<boolean> {
  const redirects = await getCollectionRedirects();
  if (Object.hasOwn(redirects, d.collection)) return true;
  if (d.redirectedFrom && !Object.hasOwn(redirects, d.redirectedFrom)) return true;
  return !!d.ambiguous?.some(n => Object.hasOwn(redirects, n));
}
