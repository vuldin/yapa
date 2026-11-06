/**
 * The findings backlog: your open findings older than two days that nobody
 * has given a disposition. `sweepFindings` asks the curation model which of
 * them are only progress notes (a review round, a push, a release) or are
 * superseded by a newer typed memory, and lists them; `applySweep` resolves
 * a reviewed list as no-action, checking each one again first.
 *
 * @module @yapa/core/memory/sweep
 */
import { getDocumentsByFilter, getDocumentsByIds, queryDocuments, type DocumentResult } from '../store/index.js';
import { CHUNK_OVERLAP, getConfig } from '../config.js';
import { isReadOnlyDoc } from '../sync/syncable.js';
import { callCurationLLM } from '../curation/provider.js';
import { updateMemory } from './update.js';

const DAY = 86400;

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).map(s => s.trim()).filter(Boolean);

const author = (m: Record<string, any>) => String(m.origin_user ?? m.username ?? '');
const mine = (m: Record<string, any>, me: string) => author(m).toLowerCase() === me.toLowerCase();

const isStale = (m: Record<string, any>) => m.archived !== true && (m.status ?? 'open') === 'open' && !m.disposition;

/** Open findings older than `minAgeDays` with no disposition: yours, unless `allOwners`. */
export async function staleFindings(
  collection: string, opts: { minAgeDays?: number; allOwners?: boolean; now?: number } = {},
): Promise<DocumentResult[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const me = getConfig().USERNAME;
  const docs = await getDocumentsByFilter(collection, { type: 'memory', kind: 'finding' }, 5000).catch(() => []);
  return docs.filter(f => isStale(f.metadata) && Number(f.metadata.created_at ?? now) <= now - (opts.minAgeDays ?? 2) * DAY
    && Number(f.metadata.chunk_index ?? 0) === 0 && (opts.allOwners || mine(f.metadata, me)));
}

export const SWEEP_PROMPT_VERSION = 'v1';
const BATCH_ITEMS = 10;
const BATCH_CHARS = 12_000;
const ITEM_CHARS = 4_000;
const NEIGHBOR_MAX_DISTANCE = 0.5;
const NEIGHBOR_KINDS = ['finding', 'decision', 'limitation'];

export const SWEEP_SYSTEM_PROMPT = `You clean up a team's open findings. A finding should be knowledge that stays true after the work moves on: a result, a root cause, a trap, a retraction. Some were recorded wrongly and only report progress. For each finding, answer one verdict:
- "progress": it only records that work happened or where it stood at a moment (a review round, a commit pushed, a PR opened or merged, a release tagged, tests passing, next steps), and nothing in it stays useful or still needs deciding.
- "superseded": the NEWER note shown with it carries all of this finding's knowledge (it says the same thing, or corrects it), so closing this finding loses nothing. If the newer note is about something else, covers only part of it, or you would have to add "but" or "though", answer "keep".
- "keep": anything else, including a result or root cause that stays useful (even inside a progress report), something still unresolved, or when you are not sure.
reason: one short sentence.

OUTPUT: valid JSON only, no commentary, no fences. One entry per finding:
[{"id": "<finding id>", "verdict": "progress" | "superseded" | "keep", "reason": "<short sentence>"}]`;

export type SweepVerdict = 'progress' | 'superseded' | 'keep';

export interface SweepItem {
  id: string;
  verdict: SweepVerdict;
  reason: string;
  superseded_by?: string;
  content: string;
  truncated?: boolean;
  applied?: boolean;
  /** Why an item that was to be closed was left open. */
  skipped?: string;
  error?: string;
}

export interface SweepResult {
  collection: string;
  considered: number;
  items: SweepItem[];
  applied: boolean;
}

export interface SweepDeps {
  call: typeof callCurationLLM;
  updateMemory: typeof updateMemory;
  queryDocuments: typeof queryDocuments;
}

interface Candidate {
  id: string;
  content: string;
  truncated: boolean;
  created: number;
  newer?: { id: string; content: string };
}

async function wholeText(collection: string, f: DocumentResult): Promise<string> {
  if (!f.metadata.parent_id) return f.content;
  const parts = await getDocumentsByFilter(collection, { parent_id: f.metadata.parent_id }, 1000).catch(() => [f]);
  return parts.sort((a, b) => Number(a.metadata.chunk_index ?? 0) - Number(b.metadata.chunk_index ?? 0))
    .map((p, i) => (i ? p.content.slice(CHUNK_OVERLAP) : p.content)).join('');
}

const lasting = (m: Record<string, any>) => NEIGHBOR_KINDS.includes(m.kind) && m.archived !== true
  && m.source !== 'compaction' && !list(m.tags).some(t => t === 'journal' || t === 'compaction');

async function newerNeighbor(collection: string, f: DocumentResult, text: string, q: typeof queryDocuments): Promise<Candidate['newer']> {
  const created = Number(f.metadata.created_at ?? 0);
  const near = await q(collection, text.slice(0, 2000), 8, { type: 'memory' }).catch(() => []);
  const own = f.metadata.parent_id ?? f.id;
  const n = near.find(d => (d.metadata.parent_id ?? d.id) !== own && d.distance < NEIGHBOR_MAX_DISTANCE
    && lasting(d.metadata) && Number(d.metadata.created_at ?? 0) > created);
  return n ? { id: n.metadata.parent_id ?? n.id, content: n.content.slice(0, 600) } : undefined;
}

function prompt(batch: Candidate[]): string {
  const lines: string[] = [];
  for (const c of batch) {
    lines.push(`- id: ${c.id}`, `  recorded: ${new Date(c.created * 1000).toISOString().slice(0, 10)}`,
      `  text${c.truncated ? ' (truncated)' : ''}: ${c.content.replace(/\s+/g, ' ')}`);
    if (c.newer) lines.push(`  newer note (${c.newer.id}): ${c.newer.content.replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
}

function batches(candidates: Candidate[]): Candidate[][] {
  const out: Candidate[][] = [];
  let cur: Candidate[] = [];
  let size = 0;
  for (const c of candidates) {
    const n = c.content.length + (c.newer?.content.length ?? 0);
    if (cur.length && (cur.length >= BATCH_ITEMS || size + n > BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function parseSweep(raw: string, batch: Candidate[]): Map<string, { verdict: SweepVerdict; reason: string }> {
  const out = new Map<string, { verdict: SweepVerdict; reason: string }>();
  const s = raw.replace(/```(?:json)?/g, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  let parsed: unknown;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? s.slice(start, end + 1) : s);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  const byId = new Map(batch.map(c => [c.id, c]));
  for (const e of parsed) {
    const c = e && typeof e === 'object' ? byId.get(String((e as any).id)) : undefined;
    if (!c || out.has(c.id)) continue;
    const v = String((e as any).verdict);
    const verdict: SweepVerdict = !c.truncated && (v === 'progress' || (v === 'superseded' && c.newer)) ? v : 'keep';
    out.set(c.id, { verdict, reason: String((e as any).reason ?? '').trim() });
  }
  return out;
}

/** Notes a closed finding was superseded by: closing one of them would lose that finding's knowledge. */
async function supersedingIds(collection: string): Promise<Set<string>> {
  const out = new Set<string>();
  const docs = await getDocumentsByFilter(collection, { type: 'memory', kind: 'finding' }, 5000).catch(() => []);
  for (const { metadata: m } of docs) {
    if (m.status !== 'resolved') continue;
    const reason = String(m.disposition_reason ?? '');
    const named = /^superseded by (\S+?)[:\s]/.exec(`${reason} `)?.[1];
    if (named) out.add(named);
    if (named || m.disposition !== 'no-action') for (const id of list(m.disposition_ids)) out.add(id);
  }
  return out;
}

/** A finding superseded by a note that is itself being closed keeps its knowledge open. */
function keepSupersededChains(items: SweepItem[]): void {
  for (let changed = true; changed;) {
    changed = false;
    const closing = new Set(items.filter(i => i.verdict !== 'keep').map(i => i.id));
    for (const i of items) {
      if (i.verdict === 'superseded' && i.superseded_by && closing.has(i.superseded_by)) {
        i.verdict = 'keep';
        i.reason = `its newer note ${i.superseded_by} is being closed too`;
        delete i.superseded_by;
        changed = true;
      }
    }
  }
}

export async function sweepFindings(
  opts: { collection: string; apply?: boolean; limit?: number; minAgeDays?: number; allOwners?: boolean },
  deps: Partial<SweepDeps> = {},
): Promise<SweepResult> {
  const d: SweepDeps = { call: callCurationLLM, updateMemory, queryDocuments, ...deps };
  const stale = (await staleFindings(opts.collection, { minAgeDays: opts.minAgeDays, allOwners: opts.allOwners }))
    .filter(f => !isReadOnlyDoc(f.metadata))
    .sort((a, b) => Number(a.metadata.created_at ?? 0) - Number(b.metadata.created_at ?? 0))
    .slice(0, opts.limit ?? Infinity);
  const candidates: Candidate[] = [];
  for (const f of stale) {
    const text = await wholeText(opts.collection, f);
    candidates.push({
      id: f.metadata.parent_id ?? f.id, content: text.slice(0, ITEM_CHARS), truncated: text.length > ITEM_CHARS,
      created: Number(f.metadata.created_at ?? 0), newer: await newerNeighbor(opts.collection, f, text, d.queryDocuments),
    });
  }

  const items: SweepItem[] = [];
  for (const batch of batches(candidates)) {
    let verdicts = new Map<string, { verdict: SweepVerdict; reason: string }>();
    let error: string | undefined;
    try {
      const raw = await d.call({
        messages: [{ role: 'system', content: SWEEP_SYSTEM_PROMPT }, { role: 'user', content: prompt(batch) }],
        temperature: 0, max_tokens: 1500, json_mode: true,
      });
      verdicts = parseSweep(raw, batch);
    } catch (e) {
      error = String(e);
    }
    for (const c of batch) {
      const v = verdicts.get(c.id) ?? { verdict: 'keep' as const, reason: error ? '' : 'no verdict' };
      items.push({
        id: c.id, verdict: v.verdict, reason: v.reason, content: c.content,
        ...(c.truncated ? { truncated: true } : {}),
        ...(v.verdict === 'superseded' ? { superseded_by: c.newer!.id } : {}),
        ...(error ? { error } : {}),
      });
    }
  }
  const held = await supersedingIds(opts.collection);
  for (const i of items) {
    if (i.verdict !== 'keep' && held.has(i.id)) {
      i.verdict = 'keep';
      i.reason = 'a finding closed earlier was superseded by it';
      delete i.superseded_by;
    }
  }
  keepSupersededChains(items);
  if (opts.apply) await applySweep(opts.collection, items, { allOwners: opts.allOwners }, d);
  return { collection: opts.collection, considered: candidates.length, items, applied: !!opts.apply };
}

async function findDoc(collection: string, id: string): Promise<DocumentResult | undefined> {
  const [doc] = await getDocumentsByIds(collection, [id]).catch(() => []);
  if (doc) return doc;
  const [chunk] = await getDocumentsByIds(collection, [`${id}-0`]).catch(() => []);
  return chunk;
}

/**
 * Resolve reviewed sweep items as no-action, exactly as listed (no new
 * judgement). Each is checked again first: still an open finding of yours
 * with no disposition, writable, and for a superseded one, its newer note
 * still there and not closed by this run.
 */
export async function applySweep(
  collection: string, items: SweepItem[], opts: { allOwners?: boolean } = {}, deps: Partial<Pick<SweepDeps, 'updateMemory'>> = {},
): Promise<SweepItem[]> {
  const update = deps.updateMemory ?? updateMemory;
  const me = getConfig().USERNAME;
  const closing = new Set(items.filter(i => i.verdict !== 'keep').map(i => i.id));
  const held = await supersedingIds(collection);
  for (const it of items) {
    if (it.verdict === 'keep') continue;
    if (held.has(it.id)) { it.skipped = 'a finding closed earlier was superseded by it'; continue; }
    const doc = await findDoc(collection, it.id);
    const m = doc?.metadata;
    if (!m || m.type !== 'memory' || m.kind !== 'finding' || !isStale(m)) { it.skipped = 'no longer an open finding'; continue; }
    if (isReadOnlyDoc(m)) { it.skipped = 'read-only'; continue; }
    if (!opts.allOwners && !mine(m, me)) { it.skipped = `recorded by ${author(m) || 'someone else'}`; continue; }
    if (it.verdict === 'superseded') {
      const n = it.superseded_by ? (await findDoc(collection, it.superseded_by))?.metadata : undefined;
      if (!n || !lasting(n) || closing.has(it.superseded_by!)) { it.skipped = 'its newer note is gone or being closed'; continue; }
    }
    const why = it.verdict === 'progress'
      ? `progress note, not a finding${it.reason ? `: ${it.reason}` : ''}`
      : `superseded by ${it.superseded_by}${it.reason ? `: ${it.reason}` : ''}`;
    try {
      await update(it.id, {
        status: 'resolved', disposition: 'no-action', disposition_reason: why, note: `Swept: ${why}`,
        ...(it.verdict === 'superseded' ? { disposition_ids: [it.superseded_by!] } : {}),
      }, collection);
      it.applied = true;
      if (it.verdict === 'superseded') held.add(it.superseded_by!);
    } catch (e) {
      it.error = String(e);
    }
  }
  return items;
}
