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
 * Before any of that, an explicit `collection_map` entry (folder → collection)
 * decides: the longest path that holds the cwd wins, and its collection is
 * used as-is (never ambiguous). This is how a folder gets a `private-*` or
 * `local-*` scope, which the roots rule never produces.
 *
 * Last, a collection merged away on this machine (`collection_merge`) is
 * followed to its target, so a folder keeps landing where its notes went.
 *
 * Roots, customers and the map come from the scope file (scope-file.ts),
 * shared by every host.
 *
 * @module @yapa/core/scope
 */
import { collectionMapEntries, editScopeSettings, formatScopeSettings, matchCollectionMap, mayCreateSharedFrom, pathWithin, readScopeSettings, scopePath, type ScopeEdit } from './scope-file.js';
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
  /** The cwd matched a `collection_map` entry. */
  mapped?: true;
  /**
   * The folder's collection was merged into `collection` on this machine;
   * this is its old name.
   */
  redirectedFrom?: string;
  /** The collection was removed from this machine (collection_delete, scope local): writes to it are refused. */
  left?: true;
}

/**
 * Infer the active collection from the session cwd: a `collection_map` entry
 * first, else the first path segment under a configured project root,
 * prefixed per the module rule above; then follow local merge redirects.
 */
export async function detectCollection(
  cwd: string | undefined,
  roots?: string[],
  customers?: string[],
  map?: string[],
): Promise<CollectionDetection> {
  const s = roots && customers && map ? undefined : readScopeSettings();
  const d = await detect(cwd, roots ?? s!.project_roots, customers ?? s!.customers, map ?? collectionMapEntries(s!));
  if (d.collection !== 'global' && (await getLeftCollections()).includes(d.collection)) d.left = true;
  return d;
}

async function detect(cwd: string | undefined, roots: string[], customers: string[], map: string[]): Promise<CollectionDetection> {
  if (!cwd) return { collection: 'global' };
  const mapped = matchCollectionMap(cwd, map);
  if (mapped) return follow({ collection: mapped, mapped: true }, await getCollectionRedirects());
  for (const rawRoot of roots) {
    const root = rawRoot.replace(/\/+$/, '') || '/';
    // Path-boundary match: root /a/proj must not claim /a/projects-x.
    if (!pathWithin(cwd, root)) continue;
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

export type ScopeAction = 'show' | 'add_root' | 'remove_root' | 'add_customer' | 'remove_customer' | 'map' | 'unmap';

/**
 * The scope tools' shared body (MCP `scope`, DSH `yapa_scope`, `yapa scope`):
 * show the folder rules and what they mean for `folder`, or change one.
 * Folders resolve against `folder`.
 */
export async function runScopeAction(
  a: { action: ScopeAction; dir?: string; name?: string; collection?: string },
  folder: string,
): Promise<{ ok: boolean; text: string }> {
  if (a.action === 'show') {
    const s = readScopeSettings({ strict: true });
    const d = await detectCollection(folder);
    const shared = s.project_roots.some(r => pathWithin(folder, r))
      ? 'may create new shared collections (it is under a project root)'
      : d.mapped && isSyncableCollection(d.collection) && mayCreateSharedFrom(folder, d.collection, s)
        ? `may create only its mapped shared collection, ${d.collection}`
        : 'may not create new shared collections (not under a project root)';
    return { ok: true, text: `${formatScopeSettings(s)}\n\nThis session's folder, ${folder}: collection ${d.collection}${scopeNotes(d)}; it ${shared}.` };
  }
  const need = (v: string | undefined, what: string) => {
    if (!v?.trim()) throw new Error(`${a.action} needs ${what}`);
    return v;
  };
  const edit: ScopeEdit = a.action === 'add_customer' || a.action === 'remove_customer'
    ? { op: a.action, name: need(a.name, 'a folder name (name)') }
    : a.action === 'map'
      ? { op: 'map', dir: need(a.dir, 'a folder (dir)'), collection: need(a.collection, 'a collection') }
      : { op: a.action, dir: need(a.dir, 'a folder (dir)') };
  const r = await editScopeSettings(edit, { base: folder });
  const target = 'dir' in edit ? scopePath(edit.dir, folder) : edit.name;
  const done: Record<Exclude<ScopeAction, 'show'>, [string, string]> = {
    add_root: [`Added project root ${target}: its subfolders now use project-<folder> collections, and sessions under it may create new shared collections.`, `${target} was already a project root.`],
    remove_root: [`Removed project root ${target}.`, `${target} was not a project root.`],
    add_customer: [`Folders named ${target} under a project root now use customer-${target}.`, `${target} was already a customer.`],
    remove_customer: [`${target} is no longer a customer.`, `${target} was not a customer.`],
    map: [`Mapped ${target} → ${edit.op === 'map' ? edit.collection.trim() : ''}.`, `${target} was already mapped to ${edit.op === 'map' ? edit.collection.trim() : ''}.`],
    unmap: [`Removed the mapping for ${target}.`, `${target} was not mapped.`],
  };
  const lines = [done[a.action][r.changed ? 0 : 1]];
  if (r.warning) lines.push(`⚠ ${r.warning}`);
  lines.push('', formatScopeSettings(r.settings));
  return { ok: true, text: lines.join('\n') };
}
