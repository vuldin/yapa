import { getConfig } from '../config.js';
import { captureNudge, recordForTask, validateLearned, type FollowUp, type LearnedItem, type Recorded } from './close.js';
import { getDocumentsByFilter, getDocumentsByIds, listCollections, addDocument, metadataDelta, patchDocument } from '../store/index.js';
import { fromChroma } from '../metadata-adapter.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable } from '../sync/syncable.js';

import type { TaskOptions } from './create.js';
import { createTaskWithMetadata } from './create.js';
import { claimTask, releaseTaskClaim, TaskClaimedError, type ClaimOptions, type ClaimResult, type ReleaseResult } from './claim.js';
import { pushDocsNow } from '../sync/push.js';
import {
  isRecurring, leadDays, nextRecurrenceDue, occurrenceSlot, opensAt, RECURRENCE_KEYS, RecurrenceError, recurrenceChanges, recurrenceInterval,
  opensAtOf, SERIES_PARAMS, seriesChanged, seriesZone, todayDue, type RecurrencePattern, type RecurrenceUpdate,
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

/** For completeTask: runs under the lock with the task as this update will write it; what it returns is written too. */
interface UpdateHooks {
  beforeWrite?: (projected: { content: string; metadata: Record<string, any>; previousStatus?: string }) => Promise<Record<string, any>>;
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
  await checkSeriesTarget(task, updates);
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
      Object.assign(updatedMetadata, await hooks.beforeWrite({
        content: updates.title ?? cur.content, metadata: updatedMetadata, previousStatus: cur.metadata.status,
      }));
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
  regeneratedId?: string;
  next?: { due_date: number; opens_at: number };
  release?: ReleaseResult;
  recorded?: Recorded;
  nudge?: string;
  /** The completed task's metadata as written. */
  metadata?: Record<string, any>;
  /** The collection the task is in. */
  collection?: string;
}

/**
 * Mark task as complete. Handles recurring regeneration. `fields` are other
 * task_update fields, written in the same write (a refused one stops the
 * completion); the next occurrence follows the task as written.
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
  const { status: _s, ...rest } = fields;
  const duration = durationMinutes != null ? { duration_minutes: durationMinutes } : {};

  let updates: TaskUpdates;
  if (task.metadata.status === 'complete') {
    // Already complete: only the fields passed, nothing about closing it again (and no next occurrence).
    updates = { ...rest, ...duration };
    if (!Object.keys(updates).length) return { metadata: task.metadata, collection: task.collection };
  } else {
    updates = { ...rest, ...duration, status: 'complete', salience: (task.metadata.salience ?? 2.0) * 0.5 };
    // Set completed_at exactly once (first-completion-wins). A later reopen -> re-complete
    // preserves the original close time, and editing duration later never moves it.
    if (task.metadata.completed_at == null) updates.completed_at = Math.floor(Date.now() / 1000);
  }

  // A recurring task gets its next occurrence on the move to complete, before that is written and under the same lock.
  let successor: { id: string; due_date: number; opens_at: number } | undefined;
  const u = await updateTask(id, updates, ctx, {
    beforeWrite: async ({ content, metadata, previousStatus }) => {
      if (previousStatus === 'complete' || metadata.status !== 'complete' || !isRecurring(metadata)) return {};
      successor = await findSuccessorOf(task.collection, task.id) ?? await createSuccessor(task.collection, task.id, content, metadata);
      return { next_occurrence: successor.id };
    },
  });
  const recorded = record.learned?.length || record.follow_ups?.length
    ? await recordForTask({ id: task.id, collection: task.collection }, record)
    : undefined;
  const nudge = u.previousStatus !== 'complete' && u.metadata?.status === 'complete' ? captureNudge(task.id, task.metadata, recorded) : undefined;
  return {
    metadata: u.metadata, collection: task.collection,
    ...(u.release ? { release: u.release } : {}), ...(recorded ? { recorded } : {}), ...(nudge ? { nudge } : {}),
    ...(successor ? { regeneratedId: successor.id, next: { due_date: successor.due_date, opens_at: successor.opens_at } } : {}),
  };
}

/**
 * The occurrence that follows `id` in its collection: the task whose
 * previous_occurrence is `id` (next_occurrence on `id` is only a pointer to
 * it, and goes stale if the successor is re-keyed).
 */
async function findSuccessorOf(collection: string, id: string): Promise<{ id: string; due_date: number; opens_at: number } | undefined> {
  const docs = await getDocumentsByFilter(collection, { type: 'task', previous_occurrence: id }, 5).catch(() => []);
  const d = docs.find(x => x.metadata.archived !== true);
  return d ? { id: d.id, due_date: Number(d.metadata.due_date), opens_at: opensAtOf(d.metadata) } : undefined;
}

/** Create the next occurrence of `id`, from the task as the completion is about to write it. */
async function createSuccessor(collection: string, id: string, title: string, m: Record<string, any>) {
  const pattern = m.recurrence_pattern as RecurrencePattern;
  const interval = recurrenceInterval(m);
  const lead = leadDays(m);
  const tz = seriesZone(m);
  const slot = occurrenceSlot(m);
  const anchor = Number(m.recurrence_anchor) > 0 ? Number(m.recurrence_anchor) : slot || todayDue();
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
    recurrence_tz: tz,
    lead_days: lead,
    recurrence_notes: template,
    recurrence_series: m.recurrence_series || id,
    previous_occurrence: id,
  }, collection);
  return { id: made.id, due_date: nextDue, opens_at: opensAt(nextDue, lead, tz) };
}

/** A series change on a completed occurrence belongs on the open one: refused, naming it. */
async function checkSeriesTarget(task: TaskResult, updates: TaskUpdates): Promise<void> {
  if (!seriesChanged(updates) || task.metadata.status !== 'complete') return;
  if (updates.status !== undefined && updates.status !== 'complete') return;
  let at = task.id;
  for (let hops = 0; hops < 50; hops++) {
    const next = await findSuccessorOf(task.collection, at);
    if (!next) break;
    const t = (await getDocumentsByIds(task.collection, [next.id]))[0];
    if (t && t.metadata.status !== 'complete') {
      throw new RecurrenceError(`${task.id} is a completed occurrence: change the series on ${t.id}, its open occurrence`);
    }
    at = next.id;
  }
  throw new RecurrenceError(`${task.id} is complete and no open occurrence follows it: there is no series left to change`);
}

