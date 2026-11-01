/**
 * Text output for the MCP tools, close to the local plugin's format
 * (packages/mcp/src/tools.ts) plus attribution, since remote readers see the
 * whole team's rows. Sizes are bounded: 4 KiB of content per item and 64 KiB
 * per tool result.
 */
import type { DocRow } from './queries.js';

export const MAX_ITEM_CONTENT_BYTES = 4 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;

const TRUNCATED = ' …[truncated]';

/** Cut `s` to at most `max` UTF-8 bytes (never splitting a character) and mark it. */
export function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const budget = Math.max(0, max - Buffer.byteLength(TRUNCATED, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + TRUNCATED;
}

export function itemContent(s: string): string {
  return truncateBytes(s, MAX_ITEM_CONTENT_BYTES);
}

/**
 * Joins blocks until the result budget is reached, then notes how many were
 * left out. `footer` lines (cursors, hints) are always kept.
 */
export function joinBounded(blocks: string[], sep: string, footer: string[] = [], max = MAX_RESULT_BYTES): string {
  const tail = footer.length ? `\n\n${footer.join('\n')}` : '';
  const reserve = Buffer.byteLength(tail, 'utf8') + 120; // room for the omission note
  const out: string[] = [];
  let used = 0;
  for (const b of blocks) {
    const n = Buffer.byteLength(b, 'utf8') + (out.length ? Buffer.byteLength(sep, 'utf8') : 0);
    if (used + n > max - reserve) break;
    out.push(b);
    used += n;
  }
  let text = out.join(sep);
  const omitted = blocks.length - out.length;
  if (omitted > 0) text += `${out.length ? sep : ''}…[${omitted} more item(s) omitted: result size limit]`;
  return text + tail;
}

export function isoDate(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

export function isoMinute(secs: number): string {
  return `${new Date(secs * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** "by alice" or "by alice, edited by bob". */
export function author(r: Pick<DocRow, 'origin_user' | 'last_editor'>): string {
  const by = `by ${r.origin_user}`;
  return r.last_editor && r.last_editor !== r.origin_user ? `${by}, edited by ${r.last_editor}` : by;
}

export function list(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String).filter(Boolean);
  return (x ?? '').toString().split(',').map((s: string) => s.trim()).filter(Boolean);
}

export function salience(m: Record<string, any>): string {
  return typeof m.salience === 'number' ? m.salience.toFixed(2) : '?';
}

/** due_date 0 is core's "no due date" sentinel. */
export function dueDate(m: Record<string, any>): string | undefined {
  const d = Number(m.due_date);
  return Number.isFinite(d) && d > 0 ? isoDate(d) : undefined;
}

// ------------------------------------------------------- typed memories
// Same rules and text as @yapa/core's memory/kinds.ts and tasks/waiting.ts
// (kept local: those modules are newer than the @yapa/core this package
// builds against). Keep them in step.

export const MEMORY_KINDS = ['finding', 'decision', 'limitation', 'question', 'idea'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const DEFAULT_STATUS: Record<MemoryKind, string> = {
  finding: 'open',
  decision: 'proposed',
  limitation: 'open',
  question: 'open',
  idea: 'proposed',
};

/** Statuses that still wait on something. */
const OPEN_STATUSES: Record<MemoryKind, readonly string[]> = {
  finding: ['open'],
  decision: ['needed', 'proposed'],
  limitation: ['open'],
  question: ['open'],
  idea: ['proposed'],
};

export function isMemoryKind(k: unknown): k is MemoryKind {
  return typeof k === 'string' && (MEMORY_KINDS as readonly string[]).includes(k);
}

/** True for a typed memory that still waits on something. */
export function isOpenTyped(meta: Record<string, any> | undefined | null): boolean {
  if (!meta || !isMemoryKind(meta.kind)) return false;
  return OPEN_STATUSES[meta.kind].includes(meta.status ?? DEFAULT_STATUS[meta.kind]);
}

/** "[decision, needed, for alice]" (empty for an untyped memory). */
export function typedLabel(meta: Record<string, any> | undefined | null): string {
  if (!meta || !isMemoryKind(meta.kind)) return '';
  const parts: string[] = [meta.kind, meta.status ?? DEFAULT_STATUS[meta.kind as MemoryKind]];
  if (meta.owner && (meta.kind === 'decision' || meta.kind === 'question')) parts.push(`for ${meta.owner}`);
  return `[${parts.join(', ')}]`;
}

/** " [decision, needed, for alice]" or "" (for appending after an id). */
export function typedSuffix(meta: Record<string, any> | undefined | null): string {
  const label = typedLabel(meta);
  return label ? ` ${label}` : '';
}

/** Who a task step waits on: `needs:<user>` tags, or [] for anyone. Undefined: not a person's step. */
export function taskNeedsPeople(tags: string[]): string[] | undefined {
  const named = tags.filter(t => t.startsWith('needs:')).map(t => t.slice('needs:'.length)).filter(Boolean);
  if (named.length) return named;
  return tags.includes('needs-human') ? [] : undefined;
}

/** "needs a person (alex)" / "needs a person (anyone)", or undefined. */
export function needsPersonText(meta: Record<string, any>): string | undefined {
  const people = taskNeedsPeople(itemsOf(meta.tags));
  return people ? `needs a person (${people.length ? people.join(', ') : 'anyone'})` : undefined;
}

/** "waits on m-1, m-2", or undefined. */
export function waitsOnText(meta: Record<string, any>): string | undefined {
  const ids = itemsOf(meta.waits_on);
  return ids.length ? `waits on ${ids.join(', ')}` : undefined;
}

// ------------------------------------------------------------- waiting

export interface WaitingItem {
  id: string;
  collection: string;
  what: 'decision' | 'question' | 'action' | 'blocked';
  title: string;
  /** Who it waits on; empty means anyone. */
  for: string[];
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

export const waitingCount = (w: WaitingResult) => w.decisions.length + w.questions.length + w.actions.length + w.blocked.length;

export function firstLine(s: string): string {
  const line = s.split('\n').find(l => l.trim()) ?? '';
  const t = line.replace(/^#+\s*/, '').trim();
  return t.length > 160 ? `${t.slice(0, 159)}\u2026` : t;
}

function age(since: number, now = Math.floor(Date.now() / 1000)): string {
  if (!since) return '';
  const d = Math.floor((now - since) / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor((now - since) / 3600);
  return h >= 1 ? `${h}h` : 'new';
}

const who = (i: WaitingItem) => (i.for.length ? i.for.join(', ') : 'anyone');

export function waitingLine(i: WaitingItem, opts: { collection?: boolean; now?: number } = {}): string {
  const where = opts.collection ? ` (${i.collection})` : '';
  const tag = i.what === 'decision' ? `decision ${i.status}` : i.what === 'question' ? 'question' : i.what === 'action' ? 'needs a person' : 'blocked';
  const head = `- **${i.id}**${where} [${tag}, for ${who(i)}, ${age(i.since, opts.now)}] ${i.title}`;
  const extra: string[] = [];
  if (i.options?.length) extra.push(`options: ${i.options.join(' | ')}`);
  if (i.recommendation) extra.push(`recommended: ${i.recommendation}`);
  if (i.waiting_tasks?.length) extra.push(`waiting: ${i.waiting_tasks.join(', ')}`);
  if (i.reason && i.what === 'blocked') extra.push(`reason: ${i.reason}`);
  return extra.length ? `${head}\n  ${extra.join('; ')}` : head;
}

export function formatWaiting(w: WaitingResult, opts: { collection?: boolean; now?: number } = {}): string {
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

/** Like core's list(): arrays or comma strings, items trimmed. */
const itemsOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).map(s => s.trim()).filter(Boolean);

/**
 * What waits on a person, from decision/question memories and open tasks
 * (same sections and rules as core's waitingOn): decisions needed or
 * proposed and open questions (for: owner); open tasks tagged needs-human or
 * needs:<user> (for: the named users, none = anyone); blocked tasks (for:
 * their owner). `user` keeps items for that user or for anyone (blocked:
 * that user's only); undefined keeps everything. Oldest first.
 */
export function buildWaiting(memories: DocRow[], tasks: DocRow[], user?: string): WaitingResult {
  const out: WaitingResult = { decisions: [], questions: [], actions: [], blocked: [] };
  const open = tasks.filter(t => t.metadata.type === 'task' && t.metadata.status !== 'complete');
  // Per collection, as in core: a task waits on a memory of its own collection.
  const key = (collection: string, id: string) => `${collection}\u0000${id}`;
  const waitingOnIt = new Map<string, string[]>();
  for (const t of open) {
    for (const m of itemsOf(t.metadata.waits_on)) {
      const k = key(t.collection, m);
      waitingOnIt.set(k, [...(waitingOnIt.get(k) ?? []), t.id]);
    }
  }

  const seen = new Set<string>();
  for (const d of memories) {
    const m = d.metadata;
    if (m.type !== 'memory' || (m.kind !== 'decision' && m.kind !== 'question')) continue;
    if (m.archived === true || m.archived === 'true' || !isOpenTyped(m)) continue;
    const id = m.parent_id ? String(m.parent_id) : d.id;
    if (seen.has(key(d.collection, id)) || (m.parent_id && Number(m.chunk_index ?? 0) !== 0)) continue;
    seen.add(key(d.collection, id));
    const options = itemsOf(m.options);
    const waiting = waitingOnIt.get(key(d.collection, id));
    const item: WaitingItem = {
      id, collection: d.collection, what: m.kind, title: firstLine(d.content), for: m.owner ? [String(m.owner)] : [],
      by: d.origin_user, since: d.updated_at,
      // Core leaves status undefined here ("decision undefined"); use the kind default.
      status: m.status ?? DEFAULT_STATUS[m.kind as MemoryKind],
      ...(options.length ? { options } : {}),
      ...(m.recommendation ? { recommendation: String(m.recommendation) } : {}),
      ...(waiting?.length ? { waiting_tasks: waiting } : {}),
    };
    (m.kind === 'decision' ? out.decisions : out.questions).push(item);
  }

  for (const t of open) {
    const m = t.metadata;
    const owner = t.origin_user;
    const title = truncateBytes(t.content, 512);
    const people = taskNeedsPeople(itemsOf(m.tags));
    if (people) {
      out.actions.push({
        id: t.id, collection: t.collection, what: 'action', title, for: people, by: owner, since: t.updated_at, status: m.status,
        ...(m.notes ? { reason: String(m.notes).slice(0, 300) } : {}),
      });
    } else if (m.status === 'blocked') {
      const reason = m.blockedReason ?? m.blocked_reason;
      out.blocked.push({
        id: t.id, collection: t.collection, what: 'blocked', title, for: owner ? [owner] : [], by: owner, since: t.updated_at, status: 'blocked',
        ...(reason ? { reason: truncateBytes(String(reason), 1024) } : {}),
      });
    }
  }

  const forUser = (i: WaitingItem) => !user || i.for.length === 0 || i.for.includes(user);
  const oldest = (a: WaitingItem, b: WaitingItem) => a.since - b.since;
  return {
    decisions: out.decisions.filter(forUser).sort(oldest),
    questions: out.questions.filter(forUser).sort(oldest),
    actions: out.actions.filter(forUser).sort(oldest),
    // Blocked tasks belong to whoever owns them.
    blocked: out.blocked.filter(i => !user || i.for.includes(user)).sort(oldest),
  };
}
