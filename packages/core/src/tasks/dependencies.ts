import { getTask, updateTask } from './update.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable, isReadOnlyDoc } from '../sync/syncable.js';

const toList = (x: unknown): string[] => Array.isArray(x) ? x : String(x ?? '').split(',').filter(Boolean);

/**
 * Change one edge list of task `id` under its lock, from the list as it is
 * now: two sessions adding edges to one task at once both land.
 */
async function editEdges(id: string, field: 'depends_on' | 'blocks', edit: (cur: string[]) => string[] | undefined): Promise<void> {
  const t = await getTask(id);
  if (!t) return;
  await withDocLock(t.collection, t.id, async () => {
    const now = await getTask(id);
    if (!now) return;
    const next = edit(toList(now.metadata[field]));
    if (next) await updateTask(id, { [field]: next });
  });
}

/** Add a dependency: taskId depends on dependsOnId. Updates both tasks. */
export async function addDependency(taskId: string, dependsOnId: string): Promise<void> {
  const task = await getTask(taskId);
  const dep = await getTask(dependsOnId);

  if (!task || !dep) {
    throw new Error('One or both tasks not found');
  }
  assertWritable(taskId, task.metadata);

  await editEdges(taskId, 'depends_on', cur => (cur.includes(dependsOnId) ? undefined : [...cur, dependsOnId]));

  // Update dep with blocker info (a read-only dep keeps the remote's version;
  // the edge lives on taskId alone)
  if (isReadOnlyDoc(dep.metadata)) return;
  await editEdges(dependsOnId, 'blocks', cur => (cur.includes(taskId) ? undefined : [...cur, taskId]));
}

/**
 * Remove a dependency: taskId no longer depends on dependsOnId. Clears both
 * sides; when the other task is gone (deleted, or not on this machine), the
 * dangling edge on the task that still exists is removed anyway.
 */
export async function removeDependency(taskId: string, dependsOnId: string): Promise<void> {
  const task = await getTask(taskId);
  const dep = await getTask(dependsOnId);

  if (!task && !dep) {
    throw new Error('Neither task found');
  }

  if (task) {
    await editEdges(taskId, 'depends_on', cur => (cur.includes(dependsOnId) ? cur.filter(id => id !== dependsOnId) : undefined));
  }

  if (dep && !isReadOnlyDoc(dep.metadata)) {
    await editEdges(dependsOnId, 'blocks', cur => (cur.includes(taskId) ? cur.filter(id => id !== taskId) : undefined));
  }
}
