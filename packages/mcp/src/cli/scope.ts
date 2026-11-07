/**
 * `yapa scope`: the collection YAPA uses for a folder, decided in one place
 * (the scope file: collection_map, then project_roots), for project scripts
 * that must not name their own. Prints JSON, or `--text`: the name, tagged
 * `(local only)` when it never leaves this machine.
 *
 * Subcommands list and change the scope file: list, add-root DIR,
 * remove-root DIR, add-customer NAME, remove-customer NAME,
 * map DIR COLLECTION, unmap DIR.
 */
import { resolve } from 'node:path';
import { detectCollection, getConfig, isSyncableCollection, readScopeSettings, runScopeAction, type ScopeAction } from '@yapa/core';

export interface ScopeResult {
  json: Record<string, unknown>;
  text: string;
  exit?: number;
}

export const SCOPE_USAGE =
  'Usage: yapa scope [--cwd DIR] [--text]        the collection YAPA uses for a folder\n' +
  '       yapa scope list [--cwd DIR]             the folder rules (scope file) and what they mean for a folder\n' +
  '       yapa scope add-root DIR | remove-root DIR\n' +
  '       yapa scope add-customer NAME | remove-customer NAME\n' +
  '       yapa scope map DIR COLLECTION | unmap DIR\n' +
  'Subcommands print text; --json prints the resulting file as JSON.\n' +
  'Project roots are folders whose subfolders are projects; new shared collections are only created from sessions under one.\n';

const ACTIONS: Record<string, ScopeAction> = {
  list: 'show', 'add-root': 'add_root', 'remove-root': 'remove_root', 'add-customer': 'add_customer',
  'remove-customer': 'remove_customer', map: 'map', unmap: 'unmap',
};

export async function runScope(args: string[], cwdDefault = process.cwd()): Promise<ScopeResult> {
  const [sub, ...rest] = args;
  if (sub === 'help' || sub === '--help') return { json: { ok: true }, text: SCOPE_USAGE.trimEnd(), exit: 0 };
  if (sub && !sub.startsWith('--')) {
    const action = ACTIONS[sub];
    if (!action) return { json: { ok: false, error: `unknown subcommand "${sub}"` }, text: SCOPE_USAGE.trimEnd(), exit: 2 };
    const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--cwd');
    const folder = scopeCwd(rest, cwdDefault);
    try {
      const r = await runScopeAction({
        action,
        ...(action === 'add_customer' || action === 'remove_customer' ? { name: positional[0] } : { dir: positional[0] }),
        ...(action === 'map' ? { collection: positional[1] } : {}),
      }, folder);
      return { json: { ok: true, file: getConfig().SCOPE_FILE, ...readScopeSettings({ strict: true }) }, text: r.text, exit: 0 };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { json: { ok: false, error }, text: error, exit: 1 };
    }
  }
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
