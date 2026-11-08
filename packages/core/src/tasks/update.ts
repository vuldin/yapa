import { getConfig } from '../config.js';
import { captureNudge, recordForTask, validateLearned, type FollowUp, type LearnedItem, type Recorded } from './close.js';
import { getDocumentsByFilter, getDocumentsByIds, listCollections, addDocument, metadataDelta, patchDocument } from '../store/index.js';
import { fromChroma } from '../metadata-adapter.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable } from '../sync/syncable.js';

import type { TaskOptions } from './create.js';
import { createTaskWithMetadata, freshTaskId, getNextTaskId } from './create.js';
import { resolveWriteCollection } from '../sync/sentinel.js';
import { claimTask, releaseTaskClaim, TaskClaimedError, type ClaimOptions, type ClaimResult, type ReleaseResult } from './claim.js';
import { pushDocsNow } from '../sync/push.js';
import {
  isRecurring, leadDays, nextRecurrenceDue, occurrenceSlot, opensAt, RECURRENCE_KEYS, RecurrenceError, recurrenceChanges, recurrenceInterval,
  metaTime, opensAtOf, SERIES_PARAMS, seriesChanged, seriesZone, storedZone, todayDue, type RecurrencePattern, type RecurrenceUpdate,
} from './recurrence.js';
import { metadataList } from '../metadata-adapter.js';

export interface TaskResult {
  id: string;
  title: string;
  metadata: Record<string, any>;
  collection: string;
}

/** Get a single task by ID. Searches all collections. */
export async function getTask(id: string): Promise<TaskResult | null> {
  const collections = await listCollections();

  for (const collection of collections) {
    try {
      const results = await getDocumentsByIds(collection.name, [id]);
      if (results.length > 0) {
        return {
          id: results[0].id,
          title: results[0].content,
          metadata: results[0].metadata,
          collection: collection.name,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** How a status change was coordinated (see tasks/claim.ts). */
export interface TaskUpdateResult {
  /** The task's id after the update (a claim can push a task created offline, which may re-key it). */
  id: string;
  claim?: ClaimResult;
  release?: ReleaseResult;
  /** The status the task had just before this update was written (read under the lock). */
  previousStatus?: string;
  /** The task's metadata as this update wrote it. */
  metadata?: Record<string, any>;
  /** The collection the task is in. */
  collection?: string;
}

/** Caller context for an update: who is acting, and claim options for a move to in_progress. */
export type TaskUpdateContext = ClaimOptions;

const RELEASE_OUTCOME: Record<string, string> = { complete: 'done', blocked: 'blocked', pending: 'pending' };

/**
 * Update task fields. Setting status `in_progress` on a task in a shared
 * collection claims it first (a lease on its id): refused when someone else
 * holds it (TaskClaimedError, nothing written). Moving it out of
 * `in_progress` releases this session's claim.
 */
export type TaskUpdates = Omit<Partial<TaskOptions>, (typeof RECURRENCE_KEYS)[number]> & {
  title?: string; blockedReason?: string; waits_on?: string[]; memory_ids?: string[];
  recurrence_interval?: number;
  lead_days?: number;
  /** A pattern sets or changes recurrence (re-anchored at the due date); "none" stops it. */
  recurrence_pattern?: RecurrencePattern | 'none';
  /** Replaces the series template; `notes` changes only this occurrence. */
  series_notes?: string;
};

/**
 * For completeTask: runs under the lock with the task as it is (`current`)
 * and as this update will write it; what it returns is written too, and
 * null writes nothing.
 */
interface UpdateHooks {
  beforeWrite?: (task: { current: Record<string, any>; content: string; metadata: Record<string, any> }) => Promise<Record<string, any> | null>;
}

export async function updateTask(
  id: string,
  updates: TaskUpdates,
  ctx: TaskUpdateContext = {},
  hooks: UpdateHooks = {},
): Promise<TaskUpdateResult> {
  let task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  assertWritable(id, task.metadata);
  const prevStatus = task.metadata.status;
  const result: TaskUpdateResult = { id, collection: task.collection };
  // Refused before a claim is taken: nothing to undo.
  await checkSeriesUpdate(task, updates);
  recurrenceChanges(task.id, task.metadata, updates as RecurrenceUpdate);

  if (updates.status === 'in_progress') {
    const claim = await claimTask(task.id, task.collection, task.metadata, ctx);
    if (claim.kind === 'refused') throw new TaskClaimedError(claim);
    result.claim = claim;
    if (claim.id !== task.id) {
      // Pushed and re-keyed on the way: continue with the task's new id.
      task = await getTask(claim.id);
      if (!task) throw new Error(`Task ${claim.id} not found after re-key`);
      result.id = task.id;
    }
  }

  // Structural fields that should trigger re-sync (not salience/accessed_at)
  const structuralKeys = ['status', 'priority', 'title', 'notes', 'tags', 'due_date', 'customer', 'project', 'depends_on', 'blocks', 'is_recurring', ...SERIES_PARAMS, 'completed_at', 'duration_minutes', 'claim_scope', 'blockedReason', 'waits_on', 'memory_ids'];
  const hasStructuralChange = getConfig().SYNC_ENABLED && Object.keys(updates).some(k => structuralKeys.includes(k));

  // The write itself, under the task's lock and over the task as it is now:
  // another session's change since the read above is kept, not reverted.
  const t = task;
  const fields: Record<string, any> = { ...updates };
  for (const k of RECURRENCE_KEYS) delete fields[k];
  const prev = await withDocLock(t.collection, t.id, async () => {
    const cur = (await getDocumentsByIds(t.collection, [t.id]))[0];
    if (!cur) throw new Error(`Task ${t.id} not found`);
    // Again on the task as it is now: a series change refused before the lock is refused here too.
    await checkSeriesUpdate({ id: t.id, collection: t.collection, metadata: cur.metadata }, updates);
    const updatedMetadata: Record<string, any> = {
      ...cur.metadata,
      ...fields,
      ...recurrenceChanges(t.id, cur.metadata, updates as RecurrenceUpdate),
      updated_at: Math.floor(Date.now() / 1000),
    };
    // First completion wins, judged on the task as it is now (two sessions
    // completing it at once keep the earlier close time).
    if (updates.completed_at != null && cur.metadata.completed_at != null) updatedMetadata.completed_at = cur.metadata.completed_at;
    if (hasStructuralChange) updatedMetadata.is_synced = false;
    // A reason belongs to the block: leaving blocked clears it ('' because a store update merges keys).
    if (updates.status !== undefined && updates.status !== 'blocked' && updates.blockedReason === undefined && cur.metadata.blockedReason) {
      updatedMetadata.blockedReason = '';
    }
    // Local-only marker: an offline claim to retry once sync is back.
    if (result.claim?.kind === 'unshared') updatedMetadata.claim_unshared = result.claim.session;
    // Cleared with '' rather than deleted: a store update merges metadata keys.
    else if (updates.status !== undefined && updatedMetadata.claim_unshared) updatedMetadata.claim_unshared = '';

    if (hooks.beforeWrite) {
      const extra = await hooks.beforeWrite({ current: cur.metadata, content: updates.title ?? cur.content, metadata: updatedMetadata });
      if (extra === null) return { status: cur.metadata.status as string | undefined, metadata: cur.metadata };
      Object.assign(updatedMetadata, extra);
    }

    // The title is the document content (what search embeds): rewrite the doc
    // so the embedding follows, instead of only the metadata copy.
    if (updates.title !== undefined && updates.title !== cur.content) {
      await addDocument(t.collection, t.id, updates.title, updatedMetadata);
    } else {
      // As a patch over the task as it is now: a field written meanwhile
      // without this lock (a boost, a push marker) is kept too.
      await patchDocument(t.collection, t.id, metadataDelta(cur.metadata, updatedMetadata));
    }
    return { status: cur.metadata.status as string | undefined, metadata: updatedMetadata };
  }).catch(async e => {
    // The task changed meanwhile and the update no longer applies: give back a claim just taken for it.
    if (result.claim?.kind === 'granted' && !result.claim.renewed) await releaseTaskClaim(t.id, t.collection, 'pending', ctx.session).catch(() => undefined);
    throw e;
  });
  result.previousStatus = prev.status;
  result.metadata = prev.metadata;

  // A granted claim is visible to teammates at once, not after the debounce.
  if (result.claim?.kind === 'granted') {
    await pushDocsNow(task.collection, [task.id]).catch(() => undefined);
  }

  const outcome = updates.status !== undefined ? RELEASE_OUTCOME[updates.status] : undefined;
  if (outcome && prevStatus === 'in_progress') {
    result.release = await releaseTaskClaim(task.id, task.collection, outcome, ctx.session).catch(() => undefined);
  }
  return result;
}

export interface CompleteResult {
  /** The next occurrence this completion created. */
  regeneratedId?: string;
  next?: { due_date: number; opens_at: number };
  /** The open next occurrence that already existed (the task was reopened and completed again). */
  existingNext?: string;
  release?: ReleaseResult;
  recorded?: Recorded;
  nudge?: string;
  /** The completed task's metadata as written. */
  metadata?: Record<string, any>;
  /** The collection the task is in. */
  collection?: string;
}

interface Successor { id: string; due_date: number; opens_at: number; status: string; created: boolean }

/**
 * Mark task as complete. Handles recurring regeneration. `fields` are other
 * task_update fields, written in the same write (a refused one stops the
 * completion); the next occurrence follows the task as written. Whether the
 * task is being closed or was already complete is judged under its lock.
 */
export async function completeTask(
  id: string,
  durationMinutes?: number,
  ctx: TaskUpdateContext = {},
  record: { learned?: LearnedItem[]; follow_ups?: FollowUp[] } = {},
  fields: TaskUpdates = {},
): Promise<CompleteResult> {
  validateLearned(record.learned);
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  // Refused here (a collection removed from this machine) before anything is written.
  const { collection } = await resolveWriteCollection(task.collection);
  const { status: _s, ...rest } = fields;
  const given = { ...rest, ...(durationMinutes != null ? { duration_minutes: durationMinutes } : {}) };

  // The next occurrence's id, allocated before the lock (allocation may ask the sync service), and only if one may be needed.
  const willRecur = rest.recurrence_pattern !== undefined ? rest.recurrence_pattern !== 'none' : isRecurring(task.metadata);
  const nextId = task.metadata.status !== 'complete' && willRecur && !(await successorOf(collection, task.id)) ? await freshTaskId() : undefined;

  let closing = false;
  let successor: Successor | undefined;
  const u = await updateTask(id, { ...given, status: 'complete' }, ctx, {
    beforeWrite: async ({ current, content, metadata }) => {
      // Already complete: only the fields passed (nothing at all without any), and no next occurrence.
      if (current.status === 'complete') return Object.keys(given).length ? {} : null;
      closing = true;
      // completed_at is set once: a reopened task completed again keeps its first close time.
      const close = { salience: (current.salience ?? 2.0) * 0.5, completed_at: current.completed_at ?? Math.floor(Date.now() / 1000) };
      if (!isRecurring(metadata)) return close;
      successor = await successorOf(collection, task.id)
        ?? await createSuccessor(collection, task.id, content, { ...metadata, ...close }, nextId ?? await getNextTaskId(0, true));
      return { ...close, next_occurrence: successor.id };
    },
  });
  const recorded = record.learned?.length || record.follow_ups?.length
    ? await recordForTask({ id: task.id, collection }, record)
    : undefined;
  const nudge = closing ? captureNudge(task.id, task.metadata, recorded) : undefined;
  return {
    metadata: u.metadata, collection,
    ...(u.release ? { release: u.release } : {}), ...(recorded ? { recorded } : {}), ...(nudge ? { nudge } : {}),
    ...(successor?.created ? { regeneratedId: successor.id, next: { due_date: successor.due_date, opens_at: successor.opens_at } } : {}),
    ...(successor && !successor.created && successor.status !== 'complete' ? { existingNext: successor.id } : {}),
  };
}

/**
 * The occurrence that follows `id` in its collection: the task whose
 * previous_occurrence is `id` (next_occurrence on `id` is only a pointer to
 * it). A store error propagates: "no successor" must mean none.
 */
async function successorOf(collection: string, id: string): Promise<Successor | undefined> {
  const d = (await getDocumentsByFilter(collection, { type: 'task', previous_occurrence: id }, 5)).find(x => x.metadata.archived !== true);
  return d && { id: d.id, due_date: metaTime(d.metadata.due_date), opens_at: opensAtOf(d.metadata), status: String(d.metadata.status ?? 'pending'), created: false };
}

/** Create the next occurrence of `id` under `newId` (or the next free one), from the task as the completion is about to write it. */
async function createSuccessor(collection: string, id: string, title: string, m: Record<string, any>, newId: string): Promise<Successor> {
  const pattern = m.recurrence_pattern as RecurrencePattern;
  const interval = recurrenceInterval(m);
  const lead = leadDays(m);
  const tz = seriesZone(m);
  const slot = occurrenceSlot(m);
  const anchor = metaTime(m.recurrence_anchor) || slot || todayDue();
  // The calendar slot is kept: late completion skips missed slots, early completion takes the one after this
  // occurrence's slot (where it was scheduled, even if its due date was moved).
  const nextDue = nextRecurrenceDue(anchor, pattern, interval, Math.max(slot, Math.floor(Date.now() / 1000)), tz);
  // Series created before templates start from their last notes.
  const template = m.recurrence_notes !== undefined ? String(m.recurrence_notes) : String(m.notes ?? '');
  // Intentionally omit completed_at/duration_minutes — the new occurrence starts fresh.
  const made = await createTaskWithMetadata(title, {
    priority: m.priority,
    tags: metadataList(m.tags),
    notes: template,
    customer: m.customer,
    project: m.project,
    due_date: nextDue,
    is_recurring: true,
    recurrence_pattern: pattern,
    recurrence_interval: interval,
    recurrence_anchor: anchor,
    // The stored zone as it is, even one this machine doesn't know.
    recurrence_tz: storedZone(m),
    lead_days: lead,
    recurrence_notes: template,
    recurrence_series: m.recurrence_series || id,
    previous_occurrence: id,
  }, collection, { id: newId });
  return { id: made.id, due_date: nextDue, opens_at: opensAt(nextDue, lead, tz), status: 'pending', created: true };
}

/**
 * A series change on a completed occurrence belongs on the open one: refused
 * naming it, also when the same call reopens this one. With nothing open,
 * reopening makes this the open one; otherwise there is no series to change.
 */
export async function checkSeriesUpdate(task: { id: string; collection: string; metadata: Record<string, any> }, updates: TaskUpdates): Promise<void> {
  if (!seriesChanged(updates) || task.metadata.status !== 'complete') return;
  const series = task.metadata.recurrence_series || task.id;
  const open = (await getDocumentsByFilter(task.collection, { type: 'task', recurrence_series: series }, 100_000))
    .find(d => d.id !== task.id && d.metadata.status !== 'complete' && d.metadata.archived !== true);
  if (open) throw new RecurrenceError(`${task.id} is a completed occurrence: change the series on ${open.id}, its open occurrence`);
  if (updates.status !== undefined && updates.status !== 'complete') return;
  throw new RecurrenceError(`${task.id} is complete and no open occurrence follows it: there is no series left to change`);
}
