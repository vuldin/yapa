import { getDocumentsByFilter, listCollections, type Collection } from '../store/index.js';
import type { TaskStatus, TaskPriority } from './create.js';
import { isUpcoming } from './recurrence.js';
import { metadataList } from '../metadata-adapter.js';

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
  /** Also tasks archived here after their owner deleted them on the sync service. */
  includeArchived?: boolean;
  /** Also recurring occurrences that haven't opened yet (see tasks/recurrence.ts). */
  includeUpcoming?: boolean;
  /** Only tasks carrying every one of these tags (applied before upcoming ones are counted). */
  tags?: string[];
  /** Return at most this many (after sorting). Default: all of them. */
  limit?: number;
}

/** Task documents read per collection: all of them, in practice. */
const READ_LIMIT = 10_000;

/** List tasks with optional filtering. Sorted by priority desc, then salience desc. */
export async function listTasks(filters: TaskListFilters = {}): Promise<TaskListResult[]> {
  return (await listTasksCounted(filters)).tasks;
}

/** listTasks, plus how many upcoming occurrences it left out (0 with includeUpcoming). */
export async function listTasksCounted(filters: TaskListFilters = {}): Promise<{ tasks: TaskListResult[]; upcomingHidden: number }> {
  const collectionNames = filters.collection
    ? [filters.collection]
    : (await listCollections()).map((c: Collection) => c.name);

  const allTasks: TaskListResult[] = [];
  const now = Math.floor(Date.now() / 1000);
  let upcomingHidden = 0;

  for (const name of collectionNames) {
    const where: Record<string, any> = { type: 'task' };
    if (filters.status) where.status = filters.status;
    if (filters.priority) where.priority = filters.priority;
    if (filters.customer) where.customer = filters.customer;
    if (filters.project) where.project = filters.project;

    try {
      // Read every task: completed ones count against a read limit too, and a
      // limit of 100 here hid most open tasks in a busy collection.
      const tasks = await getDocumentsByFilter(name, where, READ_LIMIT);
      for (const task of tasks) {
        if (!filters.includeComplete && task.metadata.status === 'complete') continue;
        // Deleted on the sync service by its owner, kept here archived.
        if (task.metadata.archived === true && !filters.includeArchived) continue;
        if (filters.tags?.length) {
          const tags = metadataList(task.metadata.tags);
          if (!filters.tags.every(t => tags.includes(t))) continue;
        }
        if (!filters.includeUpcoming && isUpcoming(task.metadata, now)) {
          upcomingHidden++;
          continue;
        }
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

  const sorted = allTasks.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.metadata.priority] ?? 0;
    const pB = PRIORITY_ORDER[b.metadata.priority] ?? 0;
    if (pB !== pA) return pB - pA;
    return (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0);
  });
  return { tasks: filters.limit !== undefined ? sorted.slice(0, filters.limit) : sorted, upcomingHidden };
}

/**
 * Open tasks with a due date, soonest first (overdue ones too, unless not
 * `includeOverdue`). Recurring occurrences that haven't opened yet are
 * included: they are what is coming.
 */
export async function getDueTasks(includeOverdue: boolean = true): Promise<Array<TaskListResult & { daysUntil: number }>> {
  const now = Math.floor(Date.now() / 1000);
  const tasks = await listTasks({ includeComplete: false, includeUpcoming: true });

  return tasks
    .filter(t => t.metadata.due_date)
    .map(t => {
      const daysUntil = Math.ceil((t.metadata.due_date - now) / (24 * 60 * 60));
      return { ...t, daysUntil };
    })
    .filter(t => includeOverdue || t.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil);
}
