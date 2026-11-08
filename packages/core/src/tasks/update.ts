import { getConfig } from '../config.js';
import { captureNudge, recordForTask, validateLearned, type FollowUp, type LearnedItem, type Recorded } from './close.js';
import { getDocumentsByIds, listCollections, addDocument, metadataDelta, patchDocument } from '../store/index.js';
import { fromChroma } from '../metadata-adapter.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable } from '../sync/syncable.js';

import type { TaskOptions } from './create.js';
import { createTask } from './create.js';
import { claimTask, releaseTaskClaim, TaskClaimedError, type ClaimOptions, type ClaimResult, type ReleaseResult } from './claim.js';
import { pushDocsNow } from '../sync/push.js';
import {
  isRecurring, leadDays, nextRecurrenceDue, occurrenceSlot, opensAt, RECURRENCE_KEYS, recurrenceChanges, recurrenceInterval, todayDue,
  type RecurrencePattern, type RecurrenceUpdate,
} from './recurrence.js';

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
  const result: TaskUpdateResult = { id };
  // Refused before a claim is taken: nothing to undo.
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
  const structuralKeys = ['status', 'priority', 'title', 'notes', 'tags', 'due_date', 'customer', 'project', 'depends_on', 'blocks', 'is_recurring', 'recurrence_pattern', 'recurrence_interval', 'lead_days', 'series_notes', 'completed_at', 'duration_minutes', 'claim_scope', 'blockedReason', 'waits_on', 'memory_ids'];
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

  const { release, previousStatus, metadata: written } = await updateTask(id, completionUpdates, ctx);
  const recorded = record.learned?.length || record.follow_ups?.length
    ? await recordForTask({ id: task.id, collection: task.collection }, record)
    : undefined;
  const nudge = captureNudge(task.id, task.metadata, recorded);
  const m = written ?? task.metadata;
  const extras = { metadata: m, ...(release ? { release } : {}), ...(recorded ? { recorded } : {}), ...(nudge ? { nudge } : {}) };

  // Handle recurring tasks: once, by whichever completion found it still open
  // (two sessions completing it at once must not create two next occurrences).
  if (isRecurring(m) && previousStatus !== 'complete') {
    const pattern = m.recurrence_pattern as RecurrencePattern;
    const interval = recurrenceInterval(m);
    const lead = leadDays(m);
    const slot = occurrenceSlot(m);
    const anchor = Number(m.recurrence_anchor) > 0 ? Number(m.recurrence_anchor) : slot || todayDue();
    // The calendar slot is kept: late completion skips missed slots, early completion takes the one after this
    // occurrence's slot (where it was scheduled, even if its due date was moved).
    const nextDue = nextRecurrenceDue(anchor, pattern, interval, Math.max(slot, Math.floor(Date.now() / 1000)));
    // Series created before templates start from their last notes.
    const template = m.recurrence_notes !== undefined ? String(m.recurrence_notes) : (m.notes ?? '');

    // Intentionally omit completed_at/duration_minutes — the new occurrence starts fresh.
    // The title as just written: a rename sent with the completion carries over.
    const newId = await createTask(String(m.title ?? task.title), {
      priority: m.priority,
      tags: Array.isArray(m.tags) ? m.tags : (m.tags ?? '').split(',').filter(Boolean),
      notes: template,
      customer: m.customer,
      project: m.project,
      due_date: nextDue,
      is_recurring: true,
      recurrence_pattern: pattern,
      recurrence_interval: interval,
      recurrence_anchor: anchor,
      lead_days: lead,
      recurrence_notes: template,
      recurrence_series: m.recurrence_series || task.id,
      previous_occurrence: task.id,
    }, task.collection);

    return { regeneratedId: newId, next: { due_date: nextDue, opens_at: opensAt(nextDue, lead) }, ...extras };
  }

  return extras;
}
