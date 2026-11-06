/**
 * Follow-through: keep typed memories current as the work moves. After each
 * turn, the open decisions, questions, findings, limitations and ideas the
 * turn is about (near it semantically, or waited on by the task this session
 * holds) are judged against it, and the ones it settles are updated:
 *
 *   decision needed|proposed  -> accepted (the person chose; note = the choice)
 *                                or rejected
 *   question open             -> answered (note = the answer)
 *   finding open              -> resolved, with a disposition
 *   limitation open           -> mitigated | closed
 *   idea proposed             -> adopted | dropped
 *
 * A task waiting on a decision becomes ready again on its own (tasks/close.ts
 * openWaits), so a person answering in chat is enough to move the work on.
 *
 * Guard rails, enforced here rather than trusted to the model: only items
 * that were shown can change; every change is validated like an agent's
 * (memory/kinds.ts); every change quotes the words of the turn that settle
 * it; a decision with an owner is settled only in a turn of that owner (an
 * owner unknown here may be a teammate, so a decision for someone outside
 * YAPA is recorded by hand); a question whose owner is another YAPA user only
 * in a turn of that user, one for someone outside YAPA by their reported
 * answer.
 * Same aux-LLM route as the extractor; one call, only when there are open
 * items to judge.
 *
 * @module @yapa/core/curation/follow-through
 */
import { getDocumentsByIds, listCollections, queryDocuments, type DocumentResult } from '../store/index.js';
import { getConfig } from '../config.js';
import { isOpenTyped, normalizeTyped, type MemoryKind } from '../memory/kinds.js';
import { updateMemory } from '../memory/update.js';
import { includesUser, resolveOwner } from '../memory/owners.js';
import { knownUsers } from '../memory/known-users.js';
import { callCurationLLM } from './provider.js';

export const FOLLOW_THROUGH_PROMPT_VERSION = 'v2';

/** How close (cosine) an open item must be to the turn to be judged. */
export const FOLLOW_THROUGH_MAX_DISTANCE = 0.75;
const MAX_ITEMS = 8;
const WAITS_MAX = 4;
const NEAR_FETCH = 40;
const LINKED_TIE = 0.02;
const UNLINKED_KEEP = 2;

export const FOLLOW_THROUGH_SYSTEM_PROMPT = `You keep a team's open items current. You get a list of OPEN items (decisions waiting on a choice, open questions, open findings, open limitations, proposed ideas) and ONE conversation turn between a person and their assistant. Report only the items this turn settles. Most turns settle nothing: [] is the common, correct answer.

Settle an item only on clear evidence in the turn:
- decision -> "accepted" when the PERSON states the choice or explicitly approves one option (or the recommendation); "rejected" when the person rules the decision out entirely. Never settle a decision on the assistant's word alone. note: the choice, in a short sentence.
- question -> "answered" when the turn contains the answer (the person gives it, or the assistant reports an answer it found or was given). A question "for" someone is answered only by that someone's answer, reported in the turn: the person's own choice or plan does not answer it. note: the answer.
- finding -> "resolved" when the turn decides what becomes of it. Give "disposition": "no-action" with "disposition_reason", or "task" / "decision" / "limitation" with "disposition_ids" naming ids that appear in the turn.
- limitation -> "mitigated" (worked around) or "closed" (no longer true), when the turn shows it. note: how.
- idea -> "adopted" (the person commits to it) or "dropped". note: why.
Do not settle an item the turn merely mentions, discusses or plans to address.
Leave out every item the turn does not talk about. Never list an item to say the turn does not address it: "no-action" means the turn decided that nothing more is needed.
"evidence" is required: the words from the turn that settle the item, copied exactly (at most 200 characters).

OUTPUT: valid JSON only, no commentary, no fences. An array:
[{"id": "<item id>", "status": "<new status>", "note": "<short sentence>", "evidence": "<exact words from the turn>", "disposition": "...", "disposition_ids": ["..."], "disposition_reason": "..."}]
Omit the disposition fields except for a finding. If nothing is settled, return exactly: []`;

export interface OpenItem {
  id: string;
  collection: string;
  kind: MemoryKind;
  status: string;
  owner?: string;
  content: string;
  options?: string[];
  recommendation?: string;
}

export interface ItemChange {
  id: string;
  status: string;
  note: string;
  disposition?: string;
  disposition_ids?: string[];
  disposition_reason?: string;
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).map(s => s.trim()).filter(Boolean);

function toItem(collection: string, d: { id: string; content: string; metadata: Record<string, any> }): OpenItem {
  const m = d.metadata;
  return {
    id: m.parent_id ?? d.id, collection, kind: m.kind, status: m.status, content: d.content.slice(0, 600),
    ...(m.owner ? { owner: String(m.owner) } : {}),
    ...(list(m.options).length ? { options: list(m.options) } : {}),
    ...(m.recommendation ? { recommendation: String(m.recommendation) } : {}),
  };
}

/**
 * The open items a turn may settle, at most MAX_ITEMS: first what the tasks
 * this session holds wait on (`waits_on`: a short reply often settles those),
 * then the open typed memories nearest the turn (records the held tasks
 * collected, `memory_ids`, win near-ties but never take every slot), then, if
 * there is room, the rest of the waits and the tasks' most recently linked
 * records. A long-running task collects many records, mostly about the same
 * work as the turn; listing them first would crowd out what the turn settles.
 */
export async function findOpenItems(collection: string, text: string, taskIds: string[] = []): Promise<OpenItem[]> {
  const out = new Map<string, OpenItem>();
  const names = (await listCollections().catch(() => [])).map(c => c.name);
  const linked: string[] = [];
  const waits: string[] = [];
  for (const tid of taskIds) {
    const [t] = await getDocumentsByIds(collection, [tid]).catch(() => []);
    waits.push(...list(t?.metadata.waits_on));
    linked.push(...list(t?.metadata.memory_ids));
  }
  const addById = async (mid: string) => {
    for (const name of [collection, ...names.filter(n => n !== collection)]) {
      const direct = await getDocumentsByIds(name, [mid]).catch((): DocumentResult[] => []);
      const [doc] = direct.length ? direct : await getDocumentsByIds(name, [`${mid}-0`]).catch((): DocumentResult[] => []);
      if (doc) {
        if (isOpenTyped(doc.metadata) && doc.metadata.archived !== true) out.set(mid, toItem(name, doc));
        return;
      }
    }
  };
  const uniqueWaits = [...new Set(waits)];
  for (const mid of uniqueWaits) {
    if (out.size >= WAITS_MAX) break;
    await addById(mid);
  }
  if (text.trim()) {
    const isLinked = new Set(linked);
    const near = (await queryDocuments(collection, text.slice(0, 4000), NEAR_FETCH, { type: 'memory' }).catch(() => []))
      .filter(n => n.distance < FOLLOW_THROUGH_MAX_DISTANCE && n.metadata.archived !== true && isOpenTyped(n.metadata))
      .map(n => ({ item: toItem(collection, n), linked: isLinked.has(n.metadata.parent_id ?? n.id), rank: n.distance }))
      .map(c => ({ ...c, rank: c.rank - (c.linked ? LINKED_TIE : 0) }))
      .sort((a, b) => a.rank - b.rank)
      .filter((c, i, all) => !out.has(c.item.id) && all.findIndex(x => x.item.id === c.item.id) === i);
    const unlinked = near.filter(c => !c.linked).length;
    const linkedCap = MAX_ITEMS - out.size - Math.min(UNLINKED_KEEP, unlinked);
    let linkedTaken = 0;
    const skipped: typeof near = [];
    for (const c of near) {
      if (out.size >= MAX_ITEMS) break;
      if (c.linked && linkedTaken >= linkedCap) { skipped.push(c); continue; }
      out.set(c.item.id, c.item);
      if (c.linked) linkedTaken++;
    }
    for (const c of skipped) {
      if (out.size >= MAX_ITEMS) break;
      out.set(c.item.id, c.item);
    }
  }
  for (const mid of [...uniqueWaits, ...[...new Set(linked)].reverse()]) {
    if (out.size >= MAX_ITEMS) break;
    if (!out.has(mid)) await addById(mid);
  }
  return [...out.values()];
}

export function buildFollowThroughPrompt(items: OpenItem[], turn: { user: string; userText: string; assistantText: string }): string {
  const lines = ['[OPEN ITEMS]'];
  for (const i of items) {
    lines.push(`- id: ${i.id}`, `  kind: ${i.kind} (${i.status})${i.owner ? `, for ${i.owner}` : ''}`, `  text: ${i.content.replace(/\s+/g, ' ')}`);
    if (i.options?.length) lines.push(`  options: ${i.options.join(' | ')}`);
    if (i.recommendation) lines.push(`  recommended: ${i.recommendation}`);
  }
  lines.push('', `[PERSON: ${turn.user}]`, turn.userText.trim() || '(none)', '', '[ASSISTANT]', turn.assistantText.trim() || '(none)');
  return lines.join('\n');
}

const flat = (s: string) => s.toLowerCase()
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-')
  .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

const excerpt = (s: string) => flat(s).replace(/^["']+|["']+$/g, '').replace(/(\.\.\.|\u2026)$/, '').replace(/[.!?,;:]+$/, '').trim();

/** The excerpt, if it really is words of the turn (a short reply of the person's may be quoted whole). */
function quotes(evidence: unknown, turn: FollowThroughTurn): boolean {
  const e = excerpt(String(evidence ?? ''));
  if (!e) return false;
  const words = (x: string) => ` ${x.replace(/[.!?,;:]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const reply = excerpt(turn.userText ?? '');
  if (reply && (e === reply || (reply.split(' ').length <= 4 && words(e).trim() && words(reply).includes(words(e))))) return true;
  return e.length >= 8 && flat(turn.text).includes(e);
}

const DISCLAIMS = [
  /\b(the|this) (turn|conversation|exchange|discussion|message)\b[^.]*\b(does(?:n't| not)|did(?:n't| not)) (address|mention|discuss|decide|settle|cover)/i,
  /\bnot (addressed|mentioned|discussed|settled) in (the|this) (turn|conversation|exchange|discussion|message)\b/i,
];

export interface FollowThroughTurn {
  /** Everything the person and the assistant said, for checking evidence. */
  text: string;
  /** The person's words alone. */
  userText?: string;
  knownUsers?: Iterable<string>;
}

/** Parse and vet the judge's answer against the items it was shown. */
export function parseFollowThrough(raw: string, items: OpenItem[], user: string, turn: FollowThroughTurn): ItemChange[] {
  const s = raw.replace(/```(?:json)?/g, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  let parsed: unknown;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? s.slice(start, end + 1) : s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byId = new Map(items.map(i => [i.id, i]));
  const out: ItemChange[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== 'object') continue;
    const item = byId.get(String((e as any).id));
    if (!item) continue;
    if (!quotes((e as any).evidence, turn)) continue;
    const said = `${(e as any).note ?? ''} ${(e as any).disposition_reason ?? ''}`;
    if (DISCLAIMS.some(r => r.test(said))) continue;
    if (item.owner && (item.kind === 'decision' || item.kind === 'question')) {
      const owner = resolveOwner(item.owner, [user, ...(turn.knownUsers ?? [])]);
      // A decision's owner must be this user: an owner unknown here may be a teammate, not an outsider.
      if (item.kind === 'decision' ? !owner.user || !includesUser([owner.user], user) : owner.user && !includesUser([owner.user], user)) continue;
    }
    const change: ItemChange = {
      id: item.id,
      status: String((e as any).status ?? ''),
      note: String((e as any).note ?? '').trim(),
      ...(item.kind === 'finding' && (e as any).disposition ? { disposition: String((e as any).disposition) } : {}),
      ...(item.kind === 'finding' && Array.isArray((e as any).disposition_ids) ? { disposition_ids: (e as any).disposition_ids.map(String) } : {}),
      ...(item.kind === 'finding' && (e as any).disposition_reason ? { disposition_reason: String((e as any).disposition_reason) } : {}),
    };
    if (change.status === item.status) continue;
    try {
      const { note: _n, id: _i, ...typed } = change;
      normalizeTyped(typed as any, { kind: item.kind, status: item.status, ...(item.options ? { options: item.options } : {}) });
    } catch {
      continue; // an invalid move (e.g. a finding resolved without a disposition) is dropped
    }
    // Only forward moves out of the open set: never reopen or shuffle between open states.
    if (isOpenTyped({ kind: item.kind, status: change.status })) continue;
    out.push(change);
  }
  return out;
}

export interface FollowThroughDeps {
  findOpenItems: typeof findOpenItems;
  call: typeof callCurationLLM;
  updateMemory: typeof updateMemory;
  knownUsers: () => Promise<Iterable<string>>;
}

export interface FollowThroughResult {
  judged: number;
  changes: Array<ItemChange & { kind: string; collection: string }>;
}

/** Judge one turn against the open items it touches, and apply what it settles. */
export async function followThrough(
  turn: { collection: string; userText: string; assistantText: string; taskIds?: string[]; user?: string },
  deps: Partial<FollowThroughDeps> = {},
): Promise<FollowThroughResult> {
  const d: FollowThroughDeps = { findOpenItems, call: callCurationLLM, updateMemory, knownUsers, ...deps };
  const user = turn.user ?? getConfig().USERNAME;
  const items = await d.findOpenItems(turn.collection, `${turn.userText}\n${turn.assistantText}`, turn.taskIds ?? []);
  if (!items.length || !(turn.userText.trim() || turn.assistantText.trim())) return { judged: 0, changes: [] };
  const raw = await d.call({
    messages: [
      { role: 'system', content: FOLLOW_THROUGH_SYSTEM_PROMPT },
      { role: 'user', content: buildFollowThroughPrompt(items, { user, userText: turn.userText.slice(0, 6000), assistantText: turn.assistantText.slice(0, 6000) }) },
    ],
    temperature: 0,
    max_tokens: 800,
    json_mode: true,
  });
  const byId = new Map(items.map(i => [i.id, i]));
  const changes: FollowThroughResult['changes'] = [];
  const known = items.some(i => i.owner) ? await d.knownUsers() : [];
  for (const c of parseFollowThrough(raw, items, user, { text: `${turn.userText}\n${turn.assistantText}`, userText: turn.userText, knownUsers: known })) {
    const item = byId.get(c.id)!;
    const { id, note, ...typed } = c;
    try {
      await d.updateMemory(id, { ...(typed as any), ...(note ? { note } : {}) }, item.collection);
      changes.push({ ...c, kind: item.kind, collection: item.collection });
    } catch {
      // read-only or gone since: leave it
    }
  }
  return { judged: items.length, changes };
}
