import { getTask, updateTask } from './update.js';
import { assertWritable, isReadOnlyDoc } from '../sync/syncable.js';

/** Add a dependency: taskId depends on dependsOnId. Updates both tasks. */
export async function addDependency(taskId: string, dependsOnId: string): Promise<void> {
  const task = await getTask(taskId);
  const dep = await getTask(dependsOnId);

  if (!task || !dep) {
    throw new Error('One or both tasks not found');
  }
  assertWritable(taskId, task.metadata);

  // Update task with new dependency
  const taskDeps: string[] = Array.isArray(task.metadata.depends_on)
    ? task.metadata.depends_on
    : (task.metadata.depends_on ?? '').split(',').filter(Boolean);

  if (!taskDeps.includes(dependsOnId)) {
    taskDeps.push(dependsOnId);
    await updateTask(taskId, { depends_on: taskDeps });
  }

  // Update dep with blocker info (a read-only dep keeps the remote's version;
  // the edge lives on taskId alone)
  if (isReadOnlyDoc(dep.metadata)) return;
  const depBlocks: string[] = Array.isArray(dep.metadata.blocks)
    ? dep.metadata.blocks
    : (dep.metadata.blocks ?? '').split(',').filter(Boolean);

  if (!depBlocks.includes(taskId)) {
    depBlocks.push(taskId);
    await updateTask(dependsOnId, { blocks: depBlocks });
  }
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
    const taskDeps = toList(task.metadata.depends_on);
    if (taskDeps.includes(dependsOnId)) {
      await updateTask(taskId, { depends_on: taskDeps.filter(id => id !== dependsOnId) });
    }
  }

  if (dep && !isReadOnlyDoc(dep.metadata)) {
    const depBlocks = toList(dep.metadata.blocks);
    if (depBlocks.includes(taskId)) {
      await updateTask(dependsOnId, { blocks: depBlocks.filter(id => id !== taskId) });
    }
  }
}

const toList = (x: unknown): string[] => Array.isArray(x) ? x : String(x ?? '').split(',').filter(Boolean);
