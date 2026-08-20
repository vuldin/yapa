import { getDocumentsByFilter, listCollections, type Collection } from '../store/index.js';
import type { TaskStatus, TaskPriority } from './create.js';

const PRIORITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface TaskListResult {
  id: string;
  title: string;
  collection: string;
  metadata: Record<string, any>;
}

export interface TaskListFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  customer?: string;
  project?: string;
  collection?: string;
  includeComplete?: boolean;
}

/** List tasks with optional filtering. Sorted by priority desc, then salience desc. */
export async function listTasks(filters: TaskListFilters = {}): Promise<TaskListResult[]> {
  const collectionNames = filters.collection
    ? [filters.collection]
    : (await listCollections()).map((c: Collection) => c.name);

  const allTasks: TaskListResult[] = [];

  for (const name of collectionNames) {
    const where: Record<string, any> = { type: 'task' };
    if (filters.status) where.status = filters.status;
    if (filters.priority) where.priority = filters.priority;
    if (filters.customer) where.customer = filters.customer;
    if (filters.project) where.project = filters.project;

    try {
      const tasks = await getDocumentsByFilter(name, where, 100);
      for (const task of tasks) {
        if (!filters.includeComplete && task.metadata.status === 'complete') continue;
        allTasks.push({
          id: task.id,
          title: task.content,
          collection: name,
          metadata: task.metadata,
        });
      }
    } catch {
      continue;
    }
  }

  return allTasks.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.metadata.priority] ?? 0;
    const pB = PRIORITY_ORDER[b.metadata.priority] ?? 0;
    if (pB !== pA) return pB - pA;
    return (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0);
  });
}

/** Get tasks that are due today or overdue. */
export async function getDueTasks(includeOverdue: boolean = true): Promise<Array<TaskListResult & { daysUntil: number }>> {
  const now = Math.floor(Date.now() / 1000);
  const tasks = await listTasks({ includeComplete: false });

  return tasks
    .filter(t => t.metadata.due_date)
    .map(t => {
      const daysUntil = Math.ceil((t.metadata.due_date - now) / (24 * 60 * 60));
      return { ...t, daysUntil };
    })
    .filter(t => includeOverdue || t.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil);
}
