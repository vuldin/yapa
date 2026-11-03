import { getConfig } from '../config.js';
import { captureNudge, recordForTask, validateLearned, type FollowUp, type LearnedItem, type Recorded } from './close.js';
import { updateDocument, getDocumentsByIds, listCollections, addDocument } from '../store/index.js';
import { fromChroma } from '../metadata-adapter.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable } from '../sync/syncable.js';

import type { TaskOptions } from './create.js';
import { createTask } from './create.js';
import { claimTask, releaseTaskClaim, TaskClaimedError, type ClaimOptions, type ClaimResult, type ReleaseResult } from './claim.js';
import { pushDocsNow } from '../sync/push.js';

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
export async function updateTask(
  id: string,
  updates: Partial<TaskOptions> & { title?: string; blockedReason?: string; waits_on?: string[]; memory_ids?: string[] },
  ctx: TaskUpdateContext = {},
): Promise<TaskUpdateResult> {
  let task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  assertWritable(id, task.metadata);
  const prevStatus = task.metadata.status;
  const result: TaskUpdateResult = { id };

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
  const structuralKeys = ['status', 'priority', 'title', 'notes', 'tags', 'due_date', 'customer', 'project', 'depends_on', 'blocks', 'is_recurring', 'recurrence_pattern', 'completed_at', 'duration_minutes', 'claim_scope', 'blockedReason', 'waits_on', 'memory_ids'];
  const hasStructuralChange = getConfig().SYNC_ENABLED && Object.keys(updates).some(k => structuralKeys.includes(k));

  // The write itself, under the task's lock and over the task as it is now:
  // another session's change since the read above is kept, not reverted.
  const t = task;
  const prev = await withDocLock(t.collection, t.id, async () => {
    const cur = (await getDocumentsByIds(t.collection, [t.id]))[0];
    if (!cur) throw new Error(`Task ${t.id} not found`);
    const updatedMetadata: Record<string, any> = {
      ...cur.metadata,
      ...updates,
      updated_at: Math.floor(Date.now() / 1000),
    };
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
      await updateDocument(t.collection, t.id, updatedMetadata);
    }
    return cur.metadata.status as string | undefined;
  });
  result.previousStatus = prev;

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

/** Mark task as complete. Handles recurring regeneration. */
export async function completeTask(
  id: string,
  durationMinutes?: number,
  ctx: TaskUpdateContext = {},
  record: { learned?: LearnedItem[]; follow_ups?: FollowUp[] } = {},
): Promise<{ regeneratedId?: string; release?: ReleaseResult; recorded?: Recorded; nudge?: string }> {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  validateLearned(record.learned);

  const completionUpdates: Partial<TaskOptions> = {
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

  const { release, previousStatus } = await updateTask(id, completionUpdates, ctx);
  const recorded = record.learned?.length || record.follow_ups?.length
    ? await recordForTask({ id: task.id, collection: task.collection }, record)
    : undefined;
  const nudge = captureNudge(task.id, task.metadata, recorded);
  const extras = { ...(release ? { release } : {}), ...(recorded ? { recorded } : {}), ...(nudge ? { nudge } : {}) };

  // Handle recurring tasks: once, by whichever completion found it still open
  // (two sessions completing it at once must not create two next occurrences).
  if (task.metadata.is_recurring && task.metadata.recurrence_pattern && previousStatus !== 'complete') {
    const nextDue = computeNextDue(
      task.metadata.due_date ?? Math.floor(Date.now() / 1000),
      task.metadata.recurrence_pattern,
    );

    // Intentionally omit completed_at/duration_minutes — the new occurrence starts fresh.
    const newId = await createTask(task.title, {
      priority: task.metadata.priority,
      tags: Array.isArray(task.metadata.tags)
        ? task.metadata.tags
        : (task.metadata.tags ?? '').split(',').filter(Boolean),
      notes: task.metadata.notes,
      customer: task.metadata.customer,
      project: task.metadata.project,
      due_date: nextDue,
      is_recurring: true,
      recurrence_pattern: task.metadata.recurrence_pattern,
    }, task.collection);

    return { regeneratedId: newId, ...extras };
  }

  return extras;
}

function computeNextDue(currentDue: number, pattern: string): number {
  const d = new Date(currentDue * 1000);
  switch (pattern) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
  }
  return Math.floor(d.getTime() / 1000);
}
