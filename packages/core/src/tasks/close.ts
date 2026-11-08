/**
 * Capture at the moment work closes. Completing a task, or setting it aside,
 * is when what was learned is freshest, so the same call records it:
 *
 *   learned          typed memories (findings, decisions, limitations,
 *                    questions, ideas), each linked to the task
 *   follow_ups       new tasks, noting the task they came from
 *   decision_needed  a choice only a person can make: recorded as a decision
 *                    that is needed, and the task waits on it (pending, with
 *                    `waits_on`), so the agent can take other work and the
 *                    task comes back by itself once the decision is recorded
 *
 * @module @yapa/core/tasks/close
 */
import { getDocumentsByIds, listCollections } from '../store/index.js';
import { isOpenTyped, normalizeTyped, type TypedFields } from '../memory/kinds.js';
import { storeMemory } from '../memory/store.js';
import { resolveWriteCollection } from '../sync/sentinel.js';
import { KEPT_AS_NOTE_REASON, keepsRecordsElsewhere, RecordsElsewhereError } from '../memory/records-elsewhere.js';
import { createTask, type TaskOptions } from './create.js';
import { checkSeriesUpdate, getTask, updateTask, type TaskUpdateContext, type TaskUpdateResult } from './update.js';
import { isRecurring, recurrenceChanges, recurrenceSentence } from './recurrence.js';
import { forgetMemory } from '../memory/forget.js';
import { metadataList } from '../metadata-adapter.js';
import { formatDuration, formatTaskDate, formatTaskDay } from './dates.js';
import type { CompleteResult } from './update.js';
import type { ReleaseResult } from './claim.js';

export interface LearnedItem extends TypedFields {
  content: string;
  tags?: string[];
}

export interface FollowUp {
  title: string;
  priority?: TaskOptions['priority'];
  tags?: string[];
  notes?: string;
  /** Default: the task's collection. */
  collection?: string;
}

export interface DecisionNeeded {
  /** The question, in a line the person can answer. */
  question: string;
  options: string[];
  recommendation?: string;
  /** Who decides (default: anyone). */
  owner?: string;
  /** Background the person needs, below the question. */
  context?: string;
}

export interface Recorded {
  memories: string[];
  follow_ups: string[];
  /** Learned items stored as notes: the collection keeps its records elsewhere. */
  kept_as_notes?: string[];
}

/** The reply sentence for learned items stored as notes (empty if none). */
export function keptAsNotesLine(r: Recorded | undefined): string {
  const ids = r?.kept_as_notes ?? [];
  return ids.length ? `Kept ${ids.join(', ')} as ${ids.length === 1 ? 'a note' : 'notes'}, without a kind: ${KEPT_AS_NOTE_REASON}.` : '';
}


/**
 * Validate everything first, then store: a bad item refuses the whole call
 * (TypedMemoryError) before the task or anything else changes.
 */
export function validateLearned(items: LearnedItem[] = []): void {
  for (const it of items) {
    if (!it.content?.trim()) throw new Error('each learned item needs content');
    const { content: _c, tags: _t, ...typed } = it;
    normalizeTyped(typed);
  }
}

/**
 * For a host tool acting for a session in `folder`: refuse follow-ups that
 * would create a new shared collection the folder may not create, before
 * anything is written (see resolveWriteCollection).
 */
export async function checkFollowUpCollections(followUps: FollowUp[] | undefined, folder: string): Promise<void> {
  for (const f of followUps ?? []) if (f.collection) await resolveWriteCollection(f.collection, { folder });
}

export async function recordForTask(
  task: { id: string; collection: string },
  input: { learned?: LearnedItem[]; follow_ups?: FollowUp[] },
): Promise<Recorded> {
  const out: Recorded = { memories: [], follow_ups: [] };
  for (const it of input.learned ?? []) {
    const { content, tags, ...typed } = it;
    const r = await storeMemory(content, {
      collection: task.collection,
      tags,
      typed: { ...typed, task_ids: [...new Set([task.id, ...(typed.task_ids ?? [])])] },
    });
    const id = r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, '') : r.ids[0];
    out.memories.push(id);
    if (r.kept_as_note) (out.kept_as_notes ??= []).push(id);
  }
  for (const f of input.follow_ups ?? []) {
    if (!f.title?.trim()) continue;
    const notes = [f.notes?.trim(), `From ${task.id}.`].filter(Boolean).join('\n');
    out.follow_ups.push(await createTask(f.title.trim(), { priority: f.priority, tags: f.tags, notes }, f.collection ?? task.collection));
  }
  return out;
}

/**
 * Record a decision only a person can make, and set the task to wait on it:
 * pending with the decision in `waits_on` (a claim is released as pending).
 */
export async function requestDecision(
  taskId: string,
  d: DecisionNeeded,
  ctx: TaskUpdateContext = {},
  extra: Record<string, any> = {},
): Promise<TaskUpdateResult & { decision: string }> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!d.question?.trim()) throw new Error('decision_needed needs a question');
  if (await keepsRecordsElsewhere(task.collection)) throw new RecordsElsewhereError(task.collection, 'decision_needed (a YAPA decision the task waits on)', 'set the task to blocked with a blocked_reason that names the record');
  // An update that would be refused is refused before the decision is stored.
  recurrenceChanges(task.id, task.metadata, extra);
  await checkSeriesUpdate(task, { ...extra, status: 'pending' });
  const content = [d.question.trim(), d.context?.trim()].filter(Boolean).join('\n\n');
  const typed = normalizeTyped({
    kind: 'decision', status: 'needed', options: d.options, task_ids: [task.id],
    ...(d.recommendation ? { recommendation: d.recommendation } : {}),
    ...(d.owner ? { owner: d.owner } : {}),
  });
  const r = await storeMemory(content, { collection: task.collection, typed });
  const decision = r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, '') : r.ids[0];
  const waits = [...new Set([...metadataList(task.metadata.waits_on), decision])];
  try {
    const u = await updateTask(task.id, { ...extra, status: 'pending', waits_on: waits }, ctx);
    return { ...u, decision };
  } catch (e) {
    // Refused after all (the task changed since the check above): no decision without a task waiting on it.
    await forgetMemory(decision).catch(() => undefined);
    throw e;
  }
}

// ------------------------------------------------- what a task waits on

async function findMemory(id: string, prefer?: string): Promise<{ collection: string; metadata: Record<string, any> } | null> {
  const names = (await listCollections().catch(() => [])).map(c => c.name);
  const order = prefer ? [prefer, ...names.filter(n => n !== prefer)] : names;
  for (const name of order) {
    const [d] = await getDocumentsByIds(name, [id]).catch(() => []);
    if (d) return { collection: name, metadata: d.metadata };
    const [chunk] = await getDocumentsByIds(name, [`${id}-0`]).catch(() => []);
    if (chunk) return { collection: name, metadata: chunk.metadata };
  }
  return null;
}

export interface OpenWait {
  id: string;
  kind: string;
  status: string;
  owner?: string;
}

/**
 * The memories in `waits_on` that are still open (a superseded one is
 * followed to its replacement). A memory that can't be found doesn't hold the
 * task back: it may not have been pulled yet, or was deleted.
 */
export async function openWaits(metadata: Record<string, any>, collection?: string): Promise<OpenWait[]> {
  const out: OpenWait[] = [];
  for (const start of metadataList(metadata.waits_on)) {
    let id = start;
    let found = await findMemory(id, collection);
    for (let hops = 0; found?.metadata.archived === true && found.metadata.superseded_by && hops < 5; hops++) {
      id = String(found.metadata.superseded_by);
      found = await findMemory(id, found.collection);
    }
    if (found && isOpenTyped(found.metadata)) {
      out.push({ id, kind: found.metadata.kind, status: found.metadata.status, ...(found.metadata.owner ? { owner: String(found.metadata.owner) } : {}) });
    }
  }
  return out;
}

export const describeWaits = (w: OpenWait[]) =>
  `waiting on ${w.map(x => `${x.kind} ${x.id} (${x.status}${x.owner ? `, for ${x.owner}` : ''})`).join(', ')}`;

/** The reply line when a task closes with nothing recorded for it. */
export function captureNudge(taskId: string, metadata: Record<string, any>, recorded?: Recorded): string | undefined {
  if (recorded?.memories.length || recorded?.follow_ups.length || metadataList(metadata.memory_ids).length) return undefined;
  return `Nothing was recorded for ${taskId}: if it produced a finding, a decision or a follow-up, record it (memory_store with task_ids: ["${taskId}"], or task_create).`;
}

// ------------------------------------------------- reply text
// Shared by the MCP tools, the DSH tools and the CLI.

/** What happened to a claim when its task left in_progress. */
export function releaseText(r: ReleaseResult | undefined): string {
  if (!r) return '';
  if (r.kind === 'released') return 'Claim released.';
  if (r.kind === 'held_by_other') return `Note: ${r.lease.holder.user} (session ${r.lease.holder.session.slice(0, 8)}) still holds a claim on it.`;
  if (r.kind === 'unshared') return `Claim release not shared (${r.reason}); it lapses on its own.`;
  return '';
}

/** What closing a task recorded, and the nudge when it recorded nothing. */
export function closeText(r: { recorded?: Recorded; nudge?: string }): string {
  return [
    r.recorded?.memories.length ? `Recorded ${r.recorded.memories.join(', ')}.` : '',
    r.recorded?.follow_ups.length ? `Follow-ups: ${r.recorded.follow_ups.join(', ')}.` : '',
    keptAsNotesLine(r.recorded),
    r.nudge ?? '',
  ].filter(Boolean).join('\n');
}

/**
 * "regenerated as X (recurring), due …, opens …" for a next occurrence the
 * completion created, "next occurrence X (already created)" for an open one
 * it found, or ''.
 */
export function nextOccurrenceText(result: CompleteResult): string {
  if (result.regeneratedId) {
    return `regenerated as ${result.regeneratedId} (recurring)${result.next ? `, due ${formatTaskDate(result.next.due_date)}, opens ${formatTaskDay(result.next.opens_at)}` : ''}`;
  }
  return result.existingNext ? `next occurrence ${result.existingNext} (already created)` : '';
}

/**
 * The reply to a completion: the next occurrence of a recurring task, the
 * claim release, what was recorded. With `seriesChanged` (recurrence fields
 * changed in the same call), what the series does now.
 */
export function completedText(id: string, result: CompleteResult, opts: { durationMinutes?: number; seriesChanged?: boolean } = {}): string {
  let text = `Completed task ${id}`;
  if (opts.durationMinutes != null) text += ` (effort: ${formatDuration(opts.durationMinutes)})`;
  const next = nextOccurrenceText(result);
  if (next) text += ` → ${next}`;
  const lines = [text];
  if (opts.seriesChanged && result.metadata) {
    lines.push(isRecurring(result.metadata) ? `${recurrenceSentence(result.metadata)}.` : 'Series stopped: no next occurrence.');
  }
  lines.push(releaseText(result.release), closeText(result));
  return lines.filter(Boolean).join('\n');
}
