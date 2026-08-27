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
 * @module yapa/scope
 */
import { listCollections } from '@yapa/core';

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
}

/**
 * Infer the active collection from the session cwd: first path segment under a
 * configured project root, prefixed per the module rule above.
 */
export async function detectCollection(
  cwd: string | undefined,
  roots: string[],
  customers: string[] = [],
): Promise<CollectionDetection> {
  if (!cwd) return { collection: 'global' };
  for (const root of roots) {
    if (!cwd.startsWith(root)) continue;
    const relative = cwd.slice(root.length).replace(/^\/+/, '');
    const segment = relative.split('/')[0];
    if (!segment || segment.startsWith('.')) return { collection: 'global' };
    const existing = (await listCollections().catch(() => [])).map(c => c.name);
    const hasCustomer = existing.includes(`customer-${segment}`);
    const hasProject = existing.includes(`project-${segment}`);
    if (hasCustomer && hasProject) {
      return {
        collection: `project-${segment}`,
        ambiguous: [`project-${segment}`, `customer-${segment}`],
      };
    }
    if (hasCustomer) return { collection: `customer-${segment}` };
    if (hasProject) return { collection: `project-${segment}` };
    if (customers.includes(segment)) return { collection: `customer-${segment}` };
    return { collection: `project-${segment}` };
  }
  return { collection: 'global' };
}
