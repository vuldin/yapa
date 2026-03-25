import { addDocument, getOrCreateCollection, getDocumentsByFilter, listCollections } from '../chroma.js';
import { USERNAME } from '../config.js';

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'complete';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface TaskOptions {
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: number;
  tags?: string[];
  notes?: string;
  customer?: string;
  project?: string;
  depends_on?: string[];
  blocks?: string[];
  is_recurring?: boolean;
  recurrence_pattern?: 'daily' | 'weekly' | 'monthly';
  salience?: number;
}

const PRIORITY_SALIENCE: Record<string, number> = {
  critical: 3.0,
  high: 2.5,
  medium: 2.0,
  low: 1.5,
};

/** Get next sequential task ID for user. Format: {username}-{n} */
export async function getNextTaskId(): Promise<string> {
  const collections = await listCollections();
  let maxId = 0;

  for (const collection of collections) {
    try {
      const tasks = await getDocumentsByFilter(collection.name, { type: 'task' }, 1000);
      for (const task of tasks) {
        const match = task.id.match(new RegExp(`^${USERNAME}-(\\d+)$`));
        if (match) {
          maxId = Math.max(maxId, parseInt(match[1]));
        }
      }
    } catch {
      continue;
    }
  }

  return `${USERNAME}-${maxId + 1}`;
}

/** Create a new task. Returns the task ID. */
export async function createTask(
  title: string,
  options: TaskOptions = {},
  collection: string = 'global',
): Promise<string> {
  await getOrCreateCollection(collection);
  const id = await getNextTaskId();
  const now = Math.floor(Date.now() / 1000);

  const metadata: Record<string, any> = {
    type: 'task',
    id,
    username: USERNAME,
    title,
    notes: options.notes ?? '',
    tags: options.tags ?? [],
    status: options.status ?? 'pending',
    priority: options.priority ?? 'medium',
    due_date: options.due_date,
    customer: options.customer,
    project: options.project,
    depends_on: options.depends_on ?? [],
    blocks: options.blocks ?? [],
    is_recurring: options.is_recurring ?? false,
    recurrence_pattern: options.recurrence_pattern,
    created_at: now,
    updated_at: now,
    accessed_at: now,
    salience: options.salience ?? PRIORITY_SALIENCE[options.priority ?? 'medium'],
    sector: 'semantic',
  };
  metadata.is_synced = false;

  await addDocument(collection, id, title, metadata);
  return id;
}
