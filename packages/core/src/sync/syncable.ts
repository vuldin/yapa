/**
 * Collections that never leave this machine: `private-*`, `local-*`, and
 * `global` (personal, cross-cutting notes such as preferences, PTO and
 * writing style). Team-wide knowledge belongs in a shared collection such as
 * `project-cs-team`.
 */
export function isSyncableCollection(name: string): boolean {
  return name !== 'global' && !name.startsWith('private-') && !name.startsWith('local-');
}

/**
 * A name that looks meant to be local-only but is not, so it syncs: a case
 * variant (`Private-acme`, `LOCAL-x`), an underscore (`private_acme`) or a
 * near-miss prefix (`privat-`, `priv-`, `locl-`). Used to warn about a
 * mapped folder's collection.
 */
export function looksPrivateButShared(name: string): boolean {
  return isSyncableCollection(name) && /^(private|privat|privte|prvate|priv|prv|local|locl|lcoal)[-_]/i.test(name);
}

/**
 * A document the remote owns and serves with `metadata.read_only: true`
 * (docs/sync-api.md, "Read-only documents"). It is pulled like any other doc
 * but never edited, deleted, pushed or queued for a remote delete from here.
 */
export function isReadOnlyDoc(metadata: Record<string, any> | undefined | null): boolean {
  return metadata?.read_only === true;
}

/** Throw the user-facing refusal for a read-only doc. */
export function assertWritable(id: string, metadata: Record<string, any> | undefined | null): void {
  if (isReadOnlyDoc(metadata)) throw new Error(`${id} is read-only: owned by the remote service`);
}
