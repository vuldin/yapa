import { getConfig } from '../config.js';
import { captureNudge, recordForTask, validateLearned, type FollowUp, type LearnedItem, type Recorded } from './close.js';
import { getDocumentsByIds, listCollections, addDocument, metadataDelta, patchDocument } from '../store/index.js';
import { fromChroma } from '../metadata-adapter.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable } from '../sync/syncable.js';

import type { TaskOptions } from './create.js';
import { createTaskWithMetadata, reserveTaskId } from './create.js';
import { claimTask, releaseTaskClaim, TaskClaimedError, type ClaimOptions, type ClaimResult, type ReleaseResult } from './claim.js';
import { pushDocsNow } from '../sync/push.js';
import {
  isRecurring, leadDays, nextRecurrenceDue, occurrenceSlot, opensAt, RECURRENCE_KEYS, RecurrenceError, recurrenceChanges, recurrenceInterval,
  RegenerationError, SERIES_PARAMS, seriesChanged, seriesZone, todayDue, type RecurrencePattern, type RecurrenceUpdate,
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

export async function updateTask(
  id: string,
  updates: TaskUpdates,
  ctx: TaskUpdateContext = {},
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

  let written: Record<string, any> | undefined;
  let release: ReleaseResult | undefined;
  let movedToComplete = false;
  if (task.metadata.status === 'complete') {
    // Already complete (a retry of its next occurrence, say): only the fields passed, nothing about closing it again.
    const extra: TaskUpdates = { ...rest, ...(durationMinutes != null ? { duration_minutes: durationMinutes } : {}) };
    written = Object.keys(extra).length ? (await updateTask(id, extra, ctx)).metadata : task.metadata;
  } else {
    const completionUpdates: TaskUpdates = {
      ...rest,
      status: 'complete',
      salience: (task.metadata.salience ?? 2.0) * 0.5,
    };
    // Set completed_at exactly once (first-completion-wins). A later reopen -> re-complete
    // preserves the original close time, and editing duration later never moves it.
    if (task.metadata.completed_at == null) {
      completionUpdates.completed_at = Math.floor(Date.now() / 1000);
    }
    if (durationMinutes != null) {
      completionUpdates.duration_minutes = durationMinutes;
    }
    const u = await updateTask(id, completionUpdates, ctx);
    written = u.metadata;
    release = u.release;
    movedToComplete = u.previousStatus !== 'complete';
  }
  const recorded = record.learned?.length || record.follow_ups?.length
    ? await recordForTask({ id: task.id, collection: task.collection }, record)
    : undefined;
  const nudge = movedToComplete ? captureNudge(task.id, task.metadata, recorded) : undefined;
  const m = written ?? task.metadata;
  const extras = { metadata: m, collection: task.collection, ...(release ? { release } : {}), ...(recorded ? { recorded } : {}), ...(nudge ? { nudge } : {}) };
  if (!isRecurring(m)) return extras;
  const regenerated = await nextOccurrence(task, rest.title, movedToComplete);
  return regenerated ? { ...extras, ...regenerated, metadata: { ...m, next_occurrence: regenerated.regeneratedId } } : extras;
}

/**
 * Create a completed recurring task's next occurrence, under its lock. The
 * successor's id is reserved and written as next_occurrence first, then the
 * task is created with that id. So it is created when this call completed
 * the task and none is reserved, or when one was reserved but never created
 * (a failed create, retried by completing again); never twice, and never for
 * a task completed before 1.19 and completed again.
 */
async function nextOccurrence(task: TaskResult, title: string | undefined, movedToComplete: boolean) {
  return withDocLock(task.collection, task.id, async () => {
    const doc = (await getDocumentsByIds(task.collection, [task.id]))[0];
    const cur = doc?.metadata;
    if (!cur || !isRecurring(cur) || cur.status !== 'complete') return undefined;
    let nextId: string | undefined = typeof cur.next_occurrence === 'string' && cur.next_occurrence ? cur.next_occurrence : undefined;
    if (nextId) {
      if (await getTask(nextId)) return undefined;
    } else {
      if (!movedToComplete) return undefined;
      nextId = await reserveTaskId();
      await patchDocument(task.collection, task.id, { next_occurrence: nextId, updated_at: Math.floor(Date.now() / 1000), ...(getConfig().SYNC_ENABLED ? { is_synced: false } : {}) });
    }
    const pattern = cur.recurrence_pattern as RecurrencePattern;
    const interval = recurrenceInterval(cur);
    const lead = leadDays(cur);
    const tz = seriesZone(cur);
    const slot = occurrenceSlot(cur);
    const anchor = Number(cur.recurrence_anchor) > 0 ? Number(cur.recurrence_anchor) : slot || todayDue();
    // The calendar slot is kept: late completion skips missed slots, early completion takes the one after this
    // occurrence's slot (where it was scheduled, even if its due date was moved).
    const nextDue = nextRecurrenceDue(anchor, pattern, interval, Math.max(slot, Math.floor(Date.now() / 1000)), tz);
    // Series created before templates start from their last notes.
    const template = cur.recurrence_notes !== undefined ? String(cur.recurrence_notes) : String(cur.notes ?? '');
    try {
      // Intentionally omit completed_at/duration_minutes — the new occurrence starts fresh.
      await createTaskWithMetadata(title ?? doc.content, {
        priority: cur.priority,
        tags: metadataList(cur.tags),
        notes: template,
        customer: cur.customer,
        project: cur.project,
        due_date: nextDue,
        is_recurring: true,
        recurrence_pattern: pattern,
        recurrence_interval: interval,
        recurrence_anchor: anchor,
        recurrence_tz: tz,
        lead_days: lead,
        recurrence_notes: template,
        recurrence_series: cur.recurrence_series || task.id,
        previous_occurrence: task.id,
      }, task.collection, { id: nextId });
    } catch (e) {
      throw new RegenerationError(task.id, e);
    }
    return { regeneratedId: nextId, next: { due_date: nextDue, opens_at: opensAt(nextDue, lead, tz) } };
  });
}

/** A series change on a completed occurrence belongs on the open one: refused, naming it. */
async function checkSeriesTarget(task: TaskResult, updates: TaskUpdates): Promise<void> {
  if (!seriesChanged(updates) || task.metadata.status !== 'complete') return;
  if (updates.status !== undefined && updates.status !== 'complete') return;
  let next: unknown = task.metadata.next_occurrence;
  for (let hops = 0; typeof next === 'string' && next && hops < 50; hops++) {
    const t = await getTask(next);
    if (!t) break;
    if (t.metadata.status !== 'complete') {
      throw new RecurrenceError(`${task.id} is a completed occurrence: change the series on ${t.id}, its open occurrence`);
    }
    next = t.metadata.next_occurrence;
  }
  throw new RecurrenceError(`${task.id} is complete and no open occurrence follows it: there is no series left to change`);
}

