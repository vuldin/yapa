import { updateDocument, getDocumentsByIds, listCollections, getCollectionId, addDocument } from '../chroma.js';
import { fromChroma } from '../metadata-adapter.js';
import { CHROMA_URL } from '../config.js';
import type { TaskOptions } from './create.js';
import { createTask } from './create.js';

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

/** Update task fields. */
export async function updateTask(
  id: string,
  updates: Partial<TaskOptions> & { title?: string; blockedReason?: string },
): Promise<void> {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);

  const updatedMetadata = {
    ...task.metadata,
    ...updates,
    updated_at: Math.floor(Date.now() / 1000),
  };

  await updateDocument(task.collection, id, updatedMetadata);
}

/** Mark task as complete. Handles recurring regeneration. */
export async function completeTask(id: string): Promise<{ regeneratedId?: string }> {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);

  await updateTask(id, {
    status: 'complete',
    salience: (task.metadata.salience ?? 2.0) * 0.5,
  });

  // Handle recurring tasks
  if (task.metadata.is_recurring && task.metadata.recurrence_pattern) {
    const nextDue = computeNextDue(
      task.metadata.due_date ?? Math.floor(Date.now() / 1000),
      task.metadata.recurrence_pattern,
    );

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

    return { regeneratedId: newId };
  }

  return {};
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
