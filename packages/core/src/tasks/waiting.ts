/**
 * Everything waiting on a person: decisions someone has to make, questions
 * someone has to answer, task steps only a person can take, and blocked
 * tasks. Recording these (instead of mentioning them in chat) is what lets
 * an agent move on to other work and lets the person find them later.
 *
 *   decisions  decision memories that are needed or proposed (for: owner)
 *   questions  open question memories (for: owner)
 *              (an owner who is no YAPA user: whoever recorded it, to ask them)
 *   actions    open tasks tagged needs-human or needs:<user>
 *              (for: the needs:<user> tags; none means anyone may)
 *   blocked    blocked tasks (for: the task's owner), with age and reason
 *
 * @module @yapa/core/tasks/waiting
 */
import { getDocumentsByFilter, listCollections } from '../store/index.js';
import { DEFAULT_STATUS, isOpenTyped, type MemoryKind } from '../memory/kinds.js';
import { isSyncableCollection } from '../sync/syncable.js';
import { includesUser, ownerWaitsOn } from '../memory/owners.js';
import { knownUsers, usersIn } from '../memory/known-users.js';
import { getConfig } from '../config.js';
import { isUpcoming } from './recurrence.js';

export interface WaitingItem {
  id: string;
  collection: string;
  /** decision | question | action | blocked */
  what: 'decision' | 'question' | 'action' | 'blocked';
  title: string;
  /** Who it waits on; empty means anyone. */
  for: string[];
  /** Someone outside YAPA the person in `for` has to ask. */
  ask?: string;
  /** Who wrote it. */
  by: string;
  /** Unix seconds since it has been waiting. */
  since: number;
  status?: string;
  options?: string[];
  recommendation?: string;
  reason?: string;
  /** Tasks that wait on this decision or question (`waits_on`). */
  waiting_tasks?: string[];
}

export interface WaitingResult {
  decisions: WaitingItem[];
  questions: WaitingItem[];
  actions: WaitingItem[];
  blocked: WaitingItem[];
}

export interface WaitingOptions {
  /** One collection; default every collection. */
  collection?: string;
  /** Only items for this user or for anyone. */
  user?: string;
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).map(s => s.trim()).filter(Boolean);

const firstLine = (s: string) => {
  const line = s.split('\n').find(l => l.trim()) ?? '';
  const t = line.replace(/^#+\s*/, '').trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
};

/** Who a task step waits on: `needs:<user>` tags, or [] for anyone. Undefined: not a person's step. */
export function taskNeedsPeople(tags: string[]): string[] | undefined {
  const named = tags.filter(t => t.startsWith('needs:')).map(t => t.slice('needs:'.length)).filter(Boolean);
  if (named.length) return named;
  return tags.includes('needs-human') ? [] : undefined;
}

export async function waitingOn(opts: WaitingOptions = {}): Promise<WaitingResult> {
  const names = opts.collection ? [opts.collection] : (await listCollections().catch(() => [])).map(c => c.name);
  const out: WaitingResult = { decisions: [], questions: [], actions: [], blocked: [] };
  const read = await Promise.all(names.map(async collection => {
    const [decisions, questions, tasks] = await Promise.all([
      getDocumentsByFilter(collection, { type: 'memory', kind: 'decision' }, 2000).catch(() => []),
      getDocumentsByFilter(collection, { type: 'memory', kind: 'question' }, 2000).catch(() => []),
      getDocumentsByFilter(collection, { type: 'task' }, 5000).catch(() => []),
    ]);
    return { collection, decisions, questions, tasks };
  }));
  const known = new Set(opts.collection ? await knownUsers() : [getConfig().USERNAME]);
  if (opts.user) known.add(opts.user);
  for (const r of read) for (const u of usersIn([...r.decisions, ...r.questions, ...r.tasks])) known.add(u);

  for (const { collection, decisions, questions, tasks } of read) {
    const now = Math.floor(Date.now() / 1000);
    const open = tasks.filter(t => t.metadata.status !== 'complete' && t.metadata.archived !== true && !isUpcoming(t.metadata, now));
    const waitingOnIt = new Map<string, string[]>();
    for (const t of open) for (const m of list(t.metadata.waits_on)) waitingOnIt.set(m, [...(waitingOnIt.get(m) ?? []), t.id]);

    const seen = new Set<string>();
    for (const d of [...decisions, ...questions]) {
      const m = d.metadata;
      if (m.archived === true || !isOpenTyped(m)) continue;
      const id = m.parent_id ?? d.id;
      if (seen.has(id) || (m.parent_id && (m.chunk_index ?? 0) !== 0)) continue;
      seen.add(id);
      const by = m.origin_user ?? m.username ?? '';
      const item: WaitingItem = {
        id, collection, what: m.kind as 'decision' | 'question', title: firstLine(d.content), ...ownerWaitsOn(m.owner, by, known),
        by, since: Number(m.updated_at ?? m.created_at ?? 0), status: m.status ?? DEFAULT_STATUS[m.kind as MemoryKind],
        ...(list(m.options).length ? { options: list(m.options) } : {}),
        ...(m.recommendation ? { recommendation: String(m.recommendation) } : {}),
        ...(waitingOnIt.get(id)?.length ? { waiting_tasks: waitingOnIt.get(id) } : {}),
      };
      (m.kind === 'decision' ? out.decisions : out.questions).push(item);
    }

    for (const t of open) {
      const m = t.metadata;
      const owner = m.origin_user ?? m.username ?? '';
      const people = taskNeedsPeople(list(m.tags));
      if (people) {
        out.actions.push({
          id: t.id, collection, what: 'action', title: t.content, for: people, by: owner,
          since: Number(m.updated_at ?? m.created_at ?? 0), status: m.status,
          ...(m.notes ? { reason: String(m.notes).slice(0, 300) } : {}),
        });
      } else if (m.status === 'blocked') {
        out.blocked.push({
          id: t.id, collection, what: 'blocked', title: t.content, for: owner ? [owner] : [], by: owner,
          since: Number(m.updated_at ?? m.created_at ?? 0), status: 'blocked',
          ...(m.blockedReason || m.blocked_reason ? { reason: String(m.blockedReason ?? m.blocked_reason) } : {}),
        });
      }
    }
  }

  const forUser = (i: WaitingItem) => !opts.user || i.for.length === 0 || includesUser(i.for, opts.user);
  const oldest = (a: WaitingItem, b: WaitingItem) => a.since - b.since;
  return {
    decisions: out.decisions.filter(forUser).sort(oldest),
    questions: out.questions.filter(forUser).sort(oldest),
    actions: out.actions.filter(forUser).sort(oldest),
    // Blocked tasks belong to whoever owns them.
    blocked: out.blocked.filter(i => !opts.user || includesUser(i.for, opts.user)).sort(oldest),
  };
}

/**
 * The session-start fence for waiting items, like the recall fence: in a
 * shared scope, items from `private-*`/`local-*` collections are left out
 * (their titles would sit in front of an agent writing to a shared
 * collection); `hidden` counts them. In `global` or a private scope nothing
 * is fenced. The `waiting` tool itself is an explicit ask and is not fenced.
 */
export function fenceWaiting(w: WaitingResult, activeCollection: string): { waiting: WaitingResult; hidden: number } {
  if (!isSyncableCollection(activeCollection)) return { waiting: w, hidden: 0 };
  const open = (i: WaitingItem) => i.collection === 'global' || isSyncableCollection(i.collection);
  const waiting: WaitingResult = {
    decisions: w.decisions.filter(open),
    questions: w.questions.filter(open),
    actions: w.actions.filter(open),
    blocked: w.blocked.filter(open),
  };
  return { waiting, hidden: waitingCount(w) - waitingCount(waiting) };
}

/** Count of items, total. */
export const waitingCount = (w: WaitingResult) => w.decisions.length + w.questions.length + w.actions.length + w.blocked.length;

// ------------------------------------------------- text
// Shared by the MCP `waiting` tool, `yapa waiting --text`, session start and DSH.

function age(since: number, now = Math.floor(Date.now() / 1000)): string {
  if (!since) return '';
  const d = Math.floor((now - since) / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor((now - since) / 3600);
  return h >= 1 ? `${h}h` : 'new';
}

const who = (i: WaitingItem) => (i.for.length ? i.for.join(', ') : 'anyone');

export function waitingLine(i: WaitingItem, opts: { collection?: boolean } = {}): string {
  const where = opts.collection ? ` (${i.collection})` : '';
  const tag = i.what === 'decision' ? `decision ${i.status}` : i.what === 'question' ? 'question' : i.what === 'action' ? 'needs a person' : 'blocked';
  const ask = i.ask ? `, ask ${i.ask}` : '';
  const head = `- **${i.id}**${where} [${tag}, for ${who(i)}${ask}, ${age(i.since)}] ${i.title}`;
  const extra: string[] = [];
  if (i.options?.length) extra.push(`options: ${i.options.join(' | ')}`);
  if (i.recommendation) extra.push(`recommended: ${i.recommendation}`);
  if (i.waiting_tasks?.length) extra.push(`waiting: ${i.waiting_tasks.join(', ')}`);
  if (i.reason && i.what === 'blocked') extra.push(`reason: ${i.reason}`);
  return extra.length ? `${head}\n  ${extra.join('; ')}` : head;
}

export function formatWaiting(w: WaitingResult, opts: { collection?: boolean } = {}): string {
  const sections: Array<[string, WaitingItem[]]> = [
    ['Decisions', w.decisions],
    ['Questions', w.questions],
    ['Steps only a person can take', w.actions],
    ['Blocked', w.blocked],
  ];
  const parts = sections.filter(([, items]) => items.length).map(([title, items]) =>
    `## ${title} (${items.length})\n${items.map(i => waitingLine(i, opts)).join('\n')}`);
  return parts.length ? parts.join('\n\n') : 'Nothing is waiting on anyone.';
}
