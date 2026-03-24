import { getTask, updateTask } from './update.js';

/** Add a dependency: taskId depends on dependsOnId. Updates both tasks. */
export async function addDependency(taskId: string, dependsOnId: string): Promise<void> {
  const task = await getTask(taskId);
  const dep = await getTask(dependsOnId);

  if (!task || !dep) {
    throw new Error('One or both tasks not found');
  }

  // Update task with new dependency
  const taskDeps: string[] = Array.isArray(task.metadata.depends_on)
    ? task.metadata.depends_on
    : (task.metadata.depends_on ?? '').split(',').filter(Boolean);

  if (!taskDeps.includes(dependsOnId)) {
    taskDeps.push(dependsOnId);
    await updateTask(taskId, { depends_on: taskDeps });
  }

  // Update dep with blocker info
  const depBlocks: string[] = Array.isArray(dep.metadata.blocks)
    ? dep.metadata.blocks
    : (dep.metadata.blocks ?? '').split(',').filter(Boolean);

  if (!depBlocks.includes(taskId)) {
    depBlocks.push(taskId);
    await updateTask(dependsOnId, { blocks: depBlocks });
  }
}
