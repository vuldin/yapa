/**
 * `yapa scope`: the collection YAPA uses for a folder, decided in one place
 * (the collection_map option, then project_roots), for project scripts that
 * must not name their own. Prints JSON, or `--text`: the name, tagged
 * `(local only)` when it never leaves this machine.
 */
import { resolve } from 'node:path';
import { detectCollection, isSyncableCollection } from '@yapa/core';

export interface ScopeResult {
  json: Record<string, unknown>;
  text: string;
}

export async function runScope(args: string[], cwdDefault = process.cwd()): Promise<ScopeResult> {
  const at = args.indexOf('--cwd');
  const cwd = resolve(at >= 0 && args[at + 1] ? args[at + 1] : cwdDefault);
  const d = await detectCollection(cwd);
  const localOnly = !isSyncableCollection(d.collection);
  return {
    json: {
      ok: true, cwd, collection: d.collection, local_only: localOnly, mapped: !!d.mapped,
      ...(d.redirectedFrom ? { redirected_from: d.redirectedFrom } : {}),
      ...(d.ambiguous ? { ambiguous: d.ambiguous } : {}),
    },
    text: `${d.collection}${localOnly ? ' (local only)' : ''}`,
  };
}

/** The folder `args` name with --cwd (else the current one). */
export function scopeCwd(args: string[], cwdDefault = process.cwd()): string {
  const at = args.indexOf('--cwd');
  return resolve(at >= 0 && args[at + 1] ? args[at + 1] : cwdDefault);
}
