/**
 * The findings backlog: open findings older than two days that nobody has
 * given a disposition. `sweepFindings` asks the curation model which of them
 * are only progress notes (a review round, a push, a release) or are
 * superseded by a newer note, and resolves those as no-action; everything
 * else is kept for a person or an agent to decide. Dry run unless `apply`.
 *
 * @module @yapa/core/memory/sweep
 */
import { getDocumentsByFilter, queryDocuments, type DocumentResult } from '../store/index.js';
import { isReadOnlyDoc } from '../sync/syncable.js';
import { callCurationLLM } from '../curation/provider.js';
import { updateMemory } from './update.js';

const DAY = 86400;

export async function staleFindings(collection: string, minAgeDays = 2, now = Math.floor(Date.now() / 1000)): Promise<DocumentResult[]> {
  const docs = await getDocumentsByFilter(collection, { type: 'memory', kind: 'finding' }, 5000).catch(() => []);
  return docs.filter(f => f.metadata.archived !== true && (f.metadata.status ?? 'open') === 'open' && !f.metadata.disposition
    && Number(f.metadata.created_at ?? now) <= now - minAgeDays * DAY && Number(f.metadata.chunk_index ?? 0) === 0);
}

export const SWEEP_PROMPT_VERSION = 'v1';
const BATCH = 10;
const NEIGHBOR_MAX_DISTANCE = 0.5;

export const SWEEP_SYSTEM_PROMPT = `You clean up a team's open findings. A finding should be knowledge that stays true after the work moves on: a result, a root cause, a trap, a retraction. Some were recorded wrongly and only report progress. For each finding, answer one verdict:
- "progress": it only records that work happened or where it stood at a moment (a review round, a commit pushed, a PR opened or merged, a release tagged, tests passing, next steps), and nothing in it stays useful or still needs deciding.
- "superseded": the NEWER note shown with it says the same thing or makes it obsolete.
- "keep": anything else, including a result or root cause that stays useful, something still unresolved, or when you are not sure.
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
  applied?: boolean;
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
  created: number;
  newer?: { id: string; content: string };
}

async function newerNeighbor(collection: string, f: DocumentResult, q: typeof queryDocuments): Promise<Candidate['newer']> {
  const created = Number(f.metadata.created_at ?? 0);
  const near = await q(collection, f.content.slice(0, 2000), 5, { type: 'memory' }).catch(() => []);
  const own = f.metadata.parent_id ?? f.id;
  const n = near.find(d => (d.metadata.parent_id ?? d.id) !== own && d.distance < NEIGHBOR_MAX_DISTANCE
    && d.metadata.archived !== true && Number(d.metadata.created_at ?? 0) > created);
  return n ? { id: n.metadata.parent_id ?? n.id, content: n.content.slice(0, 600) } : undefined;
}

function prompt(batch: Candidate[]): string {
  const lines: string[] = [];
  for (const c of batch) {
    lines.push(`- id: ${c.id}`, `  recorded: ${new Date(c.created * 1000).toISOString().slice(0, 10)}`, `  text: ${c.content.replace(/\s+/g, ' ')}`);
    if (c.newer) lines.push(`  newer note (${c.newer.id}): ${c.newer.content.replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
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
    const verdict: SweepVerdict = v === 'progress' || (v === 'superseded' && c.newer) ? v : 'keep';
    out.set(c.id, { verdict, reason: String((e as any).reason ?? '').trim() });
  }
  return out;
}

export async function sweepFindings(
  opts: { collection: string; apply?: boolean; limit?: number; minAgeDays?: number },
  deps: Partial<SweepDeps> = {},
): Promise<SweepResult> {
  const d: SweepDeps = { call: callCurationLLM, updateMemory, queryDocuments, ...deps };
  const stale = (await staleFindings(opts.collection, opts.minAgeDays ?? 2))
    .filter(f => !isReadOnlyDoc(f.metadata))
    .sort((a, b) => Number(a.metadata.created_at ?? 0) - Number(b.metadata.created_at ?? 0))
    .slice(0, opts.limit ?? Infinity);
  const candidates: Candidate[] = [];
  for (const f of stale) {
    candidates.push({
      id: f.metadata.parent_id ?? f.id, content: f.content.slice(0, 600), created: Number(f.metadata.created_at ?? 0),
      newer: await newerNeighbor(opts.collection, f, d.queryDocuments),
    });
  }

  const items: SweepItem[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    let verdicts = new Map<string, { verdict: SweepVerdict; reason: string }>();
    try {
      const raw = await d.call({
        messages: [{ role: 'system', content: SWEEP_SYSTEM_PROMPT }, { role: 'user', content: prompt(batch) }],
        temperature: 0, max_tokens: 1500, json_mode: true,
      });
      verdicts = parseSweep(raw, batch);
    } catch (e) {
      for (const c of batch) items.push({ id: c.id, verdict: 'keep', reason: '', content: c.content, error: String(e) });
      continue;
    }
    for (const c of batch) {
      const v = verdicts.get(c.id) ?? { verdict: 'keep' as const, reason: 'no verdict' };
      items.push({ id: c.id, verdict: v.verdict, reason: v.reason, content: c.content, ...(v.verdict === 'superseded' ? { superseded_by: c.newer!.id } : {}) });
    }
  }

  if (opts.apply) {
    for (const it of items) {
      if (it.verdict === 'keep') continue;
      const why = it.verdict === 'progress'
        ? `progress note, not a finding${it.reason ? `: ${it.reason}` : ''}`
        : `superseded by ${it.superseded_by}${it.reason ? `: ${it.reason}` : ''}`;
      try {
        await d.updateMemory(it.id, { status: 'resolved', disposition: 'no-action', disposition_reason: why, note: `Swept: ${why}` }, opts.collection);
        it.applied = true;
      } catch (e) {
        it.error = String(e);
      }
    }
  }
  return { collection: opts.collection, considered: candidates.length, items, applied: !!opts.apply };
}
