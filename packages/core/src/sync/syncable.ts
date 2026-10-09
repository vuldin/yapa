/**
 * Collections that never leave this machine: `private-*`, `local-*`, and
 * `global` (personal, cross-cutting notes such as preferences, PTO and
 * writing style). Team-wide knowledge belongs in a shared collection such as
 * `project-cs-team`.
 */
export function isSyncableCollection(name: string): boolean {
  return name !== 'global' && !name.startsWith('private-') && !name.startsWith('local-');
}
