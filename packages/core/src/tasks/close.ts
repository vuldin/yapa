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
import { createTask, type TaskOptions } from './create.js';
import { getTask, updateTask, type TaskUpdateContext, type TaskUpdateResult } from './update.js';

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
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).filter(Boolean);

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
    out.memories.push(r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, '') : r.ids[0]);
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
  const content = [d.question.trim(), d.context?.trim()].filter(Boolean).join('\n\n');
  const typed = normalizeTyped({
    kind: 'decision', status: 'needed', options: d.options, task_ids: [task.id],
    ...(d.recommendation ? { recommendation: d.recommendation } : {}),
    ...(d.owner ? { owner: d.owner } : {}),
  });
  const r = await storeMemory(content, { collection: task.collection, typed });
  const decision = r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, '') : r.ids[0];
  const waits = [...new Set([...list(task.metadata.waits_on), decision])];
  const u = await updateTask(task.id, { ...extra, status: 'pending', waits_on: waits }, ctx);
  return { ...u, decision };
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
  for (const start of list(metadata.waits_on)) {
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
  if (recorded?.memories.length || recorded?.follow_ups.length || list(metadata.memory_ids).length) return undefined;
  return `Nothing was recorded for ${taskId}: if it produced a finding, a decision or a follow-up, record it (memory_store with task_ids: ["${taskId}"], or task_create).`;
}
