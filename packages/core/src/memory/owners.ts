/**
 * Who a typed memory's `owner` names. Owners are free text, so a name is a
 * YAPA user only when it matches one (case-insensitively, or by an email's
 * local part); anyone else is outside YAPA, and the item waits on whoever
 * recorded it to go and ask them.
 *
 * Pure, so the reference remote resolves owners the same way.
 *
 * @module @yapa/core/owners
 */

export interface ResolvedOwner {
  /** The YAPA user the owner names. */
  user?: string;
  /** The owner as written, when it names no YAPA user. */
  external?: string;
}

export function resolveOwner(raw: unknown, knownUsers: Iterable<string>): ResolvedOwner {
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!s) return {};
  const users = new Map<string, string>();
  for (const u of knownUsers) if (u && !users.has(u.toLowerCase())) users.set(u.toLowerCase(), u);
  const k = s.toLowerCase().replace(/^@/, '');
  const hit = users.get(k) ?? (k.includes('@') ? users.get(k.slice(0, k.indexOf('@'))) : undefined);
  return hit ? { user: hit } : { external: s };
}

/**
 * Who an open decision or question waits on: the user its owner names, else
 * the person who recorded it (to ask the owner), else anyone.
 */
export function ownerWaitsOn(owner: unknown, recorder: string | undefined, knownUsers: Iterable<string>): { for: string[]; ask?: string } {
  const r = resolveOwner(owner, knownUsers);
  if (r.user) return { for: [r.user] };
  if (r.external) return { for: recorder ? [recorder] : [], ask: r.external };
  return { for: [] };
}

/** Case-insensitive membership, for matching a user against `for`. */
export function includesUser(people: string[], user: string): boolean {
  const u = user.toLowerCase();
  return people.some(p => p.toLowerCase() === u);
}
