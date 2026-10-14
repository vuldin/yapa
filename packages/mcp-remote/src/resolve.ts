/**
 * Collections without the user having to know them. ADP and claude.ai users
 * ask "what's the status at Acme CT?", not "search customer-acme-ct", so:
 *
 * - `resolveCollection` accepts a collection id or a plain customer/project
 *   name ("globex", "Acme CT", "initech labs") wherever a tool
 *   takes `collection`.
 * - `inferCollection` finds the one customer/project a question names. Recall
 *   uses it to BOOST that collection, not to filter, so a wrong guess (an
 *   ordinary word that happens to be a customer name) only reorders results.
 */
import { ApiError } from '@yapa/service/lib';

const PREFIXES = ['customer-', 'project-'];

/** Lowercase letters and digits only: "Acme CT" and "acme-ct" both become "acmect". */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The part after customer-/project- (normalized), or the whole name. */
function baseKey(name: string): string {
  const p = PREFIXES.find(x => name.startsWith(x));
  return normalizeName(p ? name.slice(p.length) : name);
}

/**
 * An exact collection id, or the single collection whose name (with or
 * without its customer-/project- prefix) matches `input` once punctuation and
 * case are ignored. Ambiguous or unknown names are tool errors that list what
 * exists, so the model can retry.
 */
export function resolveCollection(input: string, names: string[]): string {
  const raw = input.trim();
  if (names.includes(raw)) return raw;
  const key = normalizeName(raw);
  if (!key) throw new ApiError('invalid_collection', 'collection is empty');
  const exact = names.filter(n => normalizeName(n) === key || baseKey(n) === key);
  // customer-x and project-x can both exist; prefer the customer.
  const pick = exact.length > 1 ? exact.filter(n => n.startsWith('customer-')) : exact;
  if (pick.length === 1) return pick[0];
  const close = names.filter(n => baseKey(n).includes(key) || key.includes(baseKey(n))).slice(0, 8);
  const hint = close.length
    ? ` Did you mean: ${close.join(', ')}?`
    : ' Call collection_list to see the shared collections, or omit collection to search all of them.';
  throw new ApiError('invalid_collection', `no shared collection matches "${raw}".${hint}`);
}

/**
 * The single customer/project named in `text`, matched on whole words and on
 * two- and three-word runs ("acme ct", "north star bank"). When one name
 * is contained in another match ("acme" vs "acme ct"), the longer wins;
 * if distinct customers remain, nothing is inferred (the question spans
 * several, so all collections are searched evenly).
 */
export function inferCollection(text: string, names: string[]): string | undefined {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= 3 && i + len <= words.length; len++) grams.add(words.slice(i, i + len).join(''));
  }
  const hits = names.filter(n => {
    const k = baseKey(n);
    return k.length >= 3 && grams.has(k);
  });
  const longest = hits.filter(h => !hits.some(o => o !== h && baseKey(o) !== baseKey(h) && baseKey(o).includes(baseKey(h))));
  const byKey = new Map<string, string[]>();
  for (const h of longest) byKey.set(baseKey(h), [...(byKey.get(baseKey(h)) ?? []), h]);
  if (byKey.size !== 1) return undefined;
  const [same] = byKey.values();
  return same.find(n => n.startsWith('customer-')) ?? same[0];
}
