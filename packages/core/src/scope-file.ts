/**
 * This machine's folder rules, in one JSON file in YAPA's state folder
 * (SCOPE_FILE, default ~/.local/share/yapa/scope.json):
 *
 *   project_roots   folders whose subfolders are projects (project-/customer-
 *                   collections), and the only folders a session may create
 *                   a new shared collection from
 *   customers       folder names under a root that are customers
 *   collection_map  folder → collection, checked first (how a folder gets a
 *                   private-* scope)
 *
 * The file is the only place these are set. `yapa scope` and the scope
 * tools edit it; every reader sees a change on its next call.
 *
 * @module @yapa/core/scope-file
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { lockFileFor, withFileLock, writeJsonAtomic } from './fs-lock.js';
import { isSyncableCollection, looksPrivateButShared } from './sync/syncable.js';

export interface ScopeSettings {
  project_roots: string[];
  customers: string[];
  /** Absolute folder → collection. */
  collection_map: Record<string, string>;
}

export type ScopeEdit =
  | { op: 'add_root' | 'remove_root'; dir: string }
  | { op: 'add_customer' | 'remove_customer'; name: string }
  | { op: 'map'; dir: string; collection: string }
  | { op: 'unmap'; dir: string };

/** Chroma's collection name rule. */
const COLLECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/;

const empty = (): ScopeSettings => ({ project_roots: [], customers: [], collection_map: {} });

export class ScopeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeFileError';
  }
}

/** `~` expanded, resolved against `base`, without a trailing separator. */
export function scopePath(dir: string, base: string = process.cwd()): string {
  const expanded = dir.trim().replace(/^~(?=[\\/]|$)/, homedir());
  return path.resolve(base, expanded);
}

function parse(text: string, file: string): ScopeSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ScopeFileError(`${file} is not valid JSON (${(e as Error).message}); fix or remove it`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScopeFileError(`${file} must hold a JSON object`);
  const o = raw as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const v = o[key] ?? [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new ScopeFileError(`${file}: "${key}" must be a list of strings`);
    return v as string[];
  };
  const map = o.collection_map ?? {};
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(x => typeof x !== 'string')) {
    throw new ScopeFileError(`${file}: "collection_map" must map folders to collection names`);
  }
  return normalize({ project_roots: strings('project_roots'), customers: strings('customers'), collection_map: map as Record<string, string> }, file);
}

function normalize(s: ScopeSettings, file: string): ScopeSettings {
  const abs = (dir: string, key: string) => {
    const d = dir.trim().replace(/^~(?=[\\/]|$)/, homedir());
    if (!path.isAbsolute(d)) throw new ScopeFileError(`${file}: "${key}" entry "${dir}" must be an absolute path or start with ~`);
    return path.resolve(d);
  };
  const collection_map: Record<string, string> = {};
  for (const [dir, c] of Object.entries(s.collection_map)) {
    const name = c.trim();
    if (!COLLECTION_NAME_RE.test(name)) throw new ScopeFileError(`${file}: "${name}" (mapped from ${dir}) is not a valid collection name`);
    collection_map[abs(dir, 'collection_map')] = name;
  }
  return {
    project_roots: [...new Set(s.project_roots.map(r => abs(r, 'project_roots')))].sort(),
    customers: [...new Set(s.customers.map(c => c.trim()).filter(Boolean))].sort(),
    collection_map: Object.fromEntries(Object.entries(collection_map).sort(([a], [b]) => a.localeCompare(b))),
  };
}

let cache: { file: string; key: string; value: ScopeSettings } | undefined;
const warned = new Set<string>();

const copy = (s: ScopeSettings): ScopeSettings => ({
  project_roots: [...s.project_roots], customers: [...s.customers], collection_map: { ...s.collection_map },
});

/**
 * The folder rules, read fresh whenever the file changed. A missing file is
 * no rules. An unreadable or invalid one is also treated as no rules (every
 * folder is `global`, nothing new is shared), with one warning on stderr per
 * problem; `strict` throws instead.
 */
export function readScopeSettings(opts: { file?: string; strict?: boolean } = {}): ScopeSettings {
  const file = opts.file ?? getConfig().SCOPE_FILE;
  let key: string;
  try {
    const st = statSync(file);
    key = `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return empty();
  }
  if (cache?.file === file && cache.key === key) return copy(cache.value);
  try {
    const value = parse(readFileSync(file, 'utf8'), file);
    cache = { file, key, value };
    return copy(value);
  } catch (e) {
    if (opts.strict) throw e;
    const msg = (e as Error).message;
    if (!warned.has(msg)) {
      warned.add(msg);
      process.stderr.write(`[yapa] ${msg}. Folder rules are off until then.\n`);
    }
    return empty();
  }
}

/** Collection-map entries in `matchCollectionMap`'s `path=collection` form. */
export function collectionMapEntries(s: ScopeSettings): string[] {
  return Object.entries(s.collection_map).map(([dir, c]) => `${dir}=${c}`);
}

/**
 * Apply one change to the scope file under its lock. Relative folders
 * resolve against `base`. Refuses to rewrite a file it can't read.
 */
export async function editScopeSettings(edit: ScopeEdit, opts: { file?: string; base?: string } = {}): Promise<{ changed: boolean; settings: ScopeSettings; warning?: string }> {
  const file = opts.file ?? getConfig().SCOPE_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(lockFileFor(file), () => {
    const before = existsSync(file) ? parse(readFileSync(file, 'utf8'), file) : empty();
    const s = copy(before);
    let warning: string | undefined;
    switch (edit.op) {
      case 'add_root': s.project_roots.push(scopePath(edit.dir, opts.base)); break;
      case 'remove_root': {
        const dir = scopePath(edit.dir, opts.base);
        s.project_roots = s.project_roots.filter(r => r !== dir);
        break;
      }
      case 'add_customer': {
        const name = edit.name.trim();
        if (!name || /[\\/]/.test(name)) throw new ScopeFileError(`"${edit.name}" is not a folder name`);
        s.customers.push(name);
        break;
      }
      case 'remove_customer': s.customers = s.customers.filter(c => c !== edit.name.trim()); break;
      case 'map': {
        const name = edit.collection.trim();
        if (!COLLECTION_NAME_RE.test(name)) throw new ScopeFileError(`"${name}" is not a valid collection name`);
        if (looksPrivateButShared(name)) warning = `"${name}" is a shared collection name and syncs; local-only names start with lowercase "private-" or "local-"`;
        s.collection_map[scopePath(edit.dir, opts.base)] = name;
        break;
      }
      case 'unmap': delete s.collection_map[scopePath(edit.dir, opts.base)]; break;
    }
    const after = normalize(s, file);
    const changed = JSON.stringify(after) !== JSON.stringify(before);
    if (changed) writeJsonAtomic(file, after, 0o644);
    cache = undefined;
    return { changed, settings: after, ...(warning ? { warning } : {}) };
  });
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
 * The collection-map entry whose path holds `cwd`, longest path first.
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

/** True when `dir` is `root` or inside it. */
export function pathWithin(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The folder a host's session works in, for the new-shared-collection rule:
 * Claude Code's project folder when set (the MCP server and the agent's
 * shell both get it), else the process's.
 */
export function sessionFolder(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.CLAUDE_PROJECT_DIR || process.cwd());
}

/** A write that would create a shared collection from a folder that may not. */
export class SharedCollectionNotAllowedError extends Error {
  readonly code = 'shared_collection_not_allowed';
  constructor(readonly collection: string, readonly folder: string) {
    const local = `private-${collection.replace(/^(project|customer)-/, '')}`;
    super(
      `Refused: "${collection}" does not exist here, and creating it would start a new shared collection that syncs to the team remote. `
      + `New shared collections are only created from a session under a project root, and ${folder} is not under one. `
      + `Use a local-only collection such as "${local}" instead. If "${collection}" already exists on the remote, run sync subscribe ${collection} first. `
      + 'Only if the user explicitly asks, allow this folder with the scope tool (add_root for a folder of projects, or map this folder to the collection), then write again.',
    );
    this.name = 'SharedCollectionNotAllowedError';
  }
}

/**
 * Whether a session in `folder` may create the shared collection
 * `collection`: the folder is at or under a project root, or is mapped to
 * exactly that collection. Local-only names are always allowed.
 */
export function mayCreateSharedFrom(folder: string, collection: string, s: ScopeSettings = readScopeSettings()): boolean {
  if (!isSyncableCollection(collection)) return true;
  const dir = path.resolve(folder);
  if (s.project_roots.some(r => pathWithin(dir, r))) return true;
  return matchCollectionMap(dir, collectionMapEntries(s)) === collection;
}

/** Human-readable listing of the scope file. */
export function formatScopeSettings(s: ScopeSettings, file: string = getConfig().SCOPE_FILE): string {
  const lines = [`Folder rules (${file}):`];
  lines.push(`- project_roots: ${s.project_roots.length ? s.project_roots.join(', ') : '(none: every folder is "global", and no new shared collection can be created)'}`);
  lines.push(`- customers: ${s.customers.length ? s.customers.join(', ') : '(none)'}`);
  const map = Object.entries(s.collection_map);
  lines.push(`- collection_map:${map.length ? '' : ' (none)'}`);
  for (const [dir, c] of map) lines.push(`  - ${dir} → ${c}${isSyncableCollection(c) ? ' (shared)' : ' (local only)'}`);
  return lines.join('\n');
}
