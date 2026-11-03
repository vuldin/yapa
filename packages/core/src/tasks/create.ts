import { getConfig } from '../config.js';
import { addDocument, getOrCreateCollection, getDocumentsByFilter, getDocumentsByIds, listCollections } from '../store/index.js';
import { getSyncBackend, isSyncConfigured, resolveSyncUsername } from '../sync/backend.js';
import { resolveWriteCollection } from '../sync/sentinel.js';
import { localCoordination } from '../sync/coordination.js';


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
  duration_minutes?: number;
  completed_at?: number;
  /** Soft scope: what the task touches. The ready queue ranks tasks near live claims last. */
  claim_scope?: string[];
}

const PRIORITY_SALIENCE: Record<string, number> = {
  critical: 3.0,
  high: 2.5,
  medium: 2.0,
  low: 1.5,
};

/**
 * Get next sequential task ID for user. Format: {username}-{n}. `localOnly`
 * skips the service lookups (a retry after a taken id: the service, if it
 * answered, would have skipped it already, and if it didn't, asking again
 * only costs another timeout).
 */
export async function getNextTaskId(floor = 0, localOnly = false): Promise<string> {
  // With the sync service, ids must carry the server-assigned username
  // (from the Google account); learn it first, bounded like the remote max.
  if (isSyncConfigured() && !localOnly) {
    await Promise.race([
      resolveSyncUsername(),
      new Promise<void>(resolve => setTimeout(resolve, 3000).unref()),
    ]).catch(() => undefined);
  }
  const collections = await listCollections();
  let maxId = floor;

  for (const collection of collections) {
    try {
      const tasks = await getDocumentsByFilter(collection.name, { type: 'task' }, 1000);
      for (const task of tasks) {
        const match = task.id.match(new RegExp(`^${getConfig().USERNAME}-(\\d+)$`));
        if (match) {
          maxId = Math.max(maxId, parseInt(match[1]));
        }
      }
    } catch {
      continue;
    }
  }

  // The service hands out task numbers from one atomic per-user counter,
  // floored by this store's max and its own, so two sessions (or machines)
  // of one user never mint the same id. Bounded like the lookups above.
  if (isSyncConfigured() && !localOnly) {
    try {
      const backend = await getSyncBackend();
      if (backend?.coordination) {
        const id = await Promise.race([
          backend.coordination.nextTaskId(maxId),
          new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000).unref()),
        ]);
        if (id && id.startsWith(`${getConfig().USERNAME}-`)) return id;
      }
    } catch {
      // older service or offline: fall back to max + 1 below
    }
  }

  // Fallback: a wiped store, or this user's other machine, may already have
  // used higher numbers on the shared database; reusing one would overwrite
  // that task remotely. Best-effort: an unreachable remote falls back to local
  // numbering (push still refuses to overwrite a different task, see sync/push.ts).
  if (isSyncConfigured() && !localOnly) {
    try {
      const backend = await getSyncBackend();
      const remote = !backend ? 0 : await Promise.race([
        backend.maxTaskNumber(),
        new Promise<number>(resolve => setTimeout(() => resolve(0), 3000).unref()),
      ]);
      maxId = Math.max(maxId, remote);
    } catch {
      // fall back to local numbering
    }
  }

  // This machine's counter (sync/local-coordination.ts), floored by every
  // number seen: two sessions here never get the same id, online or not.
  try {
    const id = await localCoordination().nextTaskId(maxId);
    if (id.startsWith(`${getConfig().USERNAME}-`)) return id;
  } catch {
    // coordination state busy or unreadable: plain max + 1
  }
  return `${getConfig().USERNAME}-${maxId + 1}`;
}

/** Is `id` already a document in any collection? (an older YAPA process, or another machine offline, may have used it) */
async function idTaken(id: string): Promise<boolean> {
  for (const c of await listCollections().catch(() => [])) {
    try {
      if ((await getDocumentsByIds(c.name, [id])).length) return true;
    } catch {
      // unreadable collection: not evidence either way
    }
  }
  return false;
}

const ID_ATTEMPTS = 5;

/** A task id no document uses yet: getNextTaskId, skipping any number found taken. */
async function freshTaskId(): Promise<string> {
  let floor = 0;
  let id = await getNextTaskId();
  for (let i = 1; i < ID_ATTEMPTS && (await idTaken(id)); i++) {
    floor = Math.max(floor, Number(id.slice(id.lastIndexOf('-') + 1)) || 0);
    id = await getNextTaskId(floor, true);
  }
  return id;
}

/** Create a new task. Returns the task ID. */
export async function createTask(
  title: string,
  options: TaskOptions = {},
  requested: string = 'global',
): Promise<string> {
  // A collection merged away here is followed, never recreated.
  const { collection } = await resolveWriteCollection(requested);
  await getOrCreateCollection(collection);
  const id = await freshTaskId();
  const now = Math.floor(Date.now() / 1000);

  const metadata: Record<string, any> = {
    type: 'task',
    id,
    username: getConfig().USERNAME,
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
    ...(options.claim_scope?.length ? { claim_scope: options.claim_scope } : {}),
    is_recurring: options.is_recurring ?? false,
    recurrence_pattern: options.recurrence_pattern,
    created_at: now,
    updated_at: now,
    accessed_at: now,
    completed_at: options.completed_at ?? null,
    duration_minutes: options.duration_minutes ?? null,
    salience: options.salience ?? PRIORITY_SALIENCE[options.priority ?? 'medium'],
    sector: 'semantic',
  };
  metadata.is_synced = false;

  await addDocument(collection, id, title, metadata);
  return id;
}
