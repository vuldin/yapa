/**
 * Links between typed memories and tasks, kept on both sides: a memory lists
 * the tasks it came from (`task_ids`), and each task lists what was recorded
 * for it (`memory_ids`), the way task dependencies keep `depends_on` and
 * `blocks`. A task's `memory_ids` is how "nothing was recorded for this task"
 * is noticed at close.
 *
 * @module @yapa/core/memory/links
 */
import { withDocLock } from '../doc-lock.js';
import { getDocumentsByIds, listCollections, updateDocument } from '../store/index.js';

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).filter(Boolean);

async function findDoc(id: string): Promise<{ collection: string; metadata: Record<string, any> } | null> {
  for (const c of await listCollections().catch(() => [])) {
    const [d] = await getDocumentsByIds(c.name, [id]).catch(() => []);
    if (d) return { collection: c.name, metadata: d.metadata };
  }
  return null;
}

/**
 * Add `memoryId` to each task's `memory_ids`. A task that can't be found (a
 * typo, or not pulled yet) is skipped and returned, never an error: the
 * memory itself is already stored.
 */
export async function linkMemoryToTasks(memoryId: string, taskIds: string[]): Promise<{ linked: string[]; missing: string[] }> {
  const out = { linked: [] as string[], missing: [] as string[] };
  for (const tid of [...new Set(taskIds)]) {
    const t = await findDoc(tid);
    if (!t || t.metadata.type !== 'task' || t.metadata.read_only === true) {
      out.missing.push(tid);
      continue;
    }
    // Under the task's lock, onto its metadata as it is now: writing back the
    // copy found above would revert a status or claim set meanwhile.
    const present = await withDocLock(t.collection, tid, async () => {
      const fresh = (await getDocumentsByIds(t.collection, [tid]))[0];
      if (!fresh) return false;
      const cur = list(fresh.metadata.memory_ids);
      if (cur.includes(memoryId)) return true;
      await updateDocument(t.collection, tid, {
        ...fresh.metadata,
        memory_ids: [...cur, memoryId],
        updated_at: Math.floor(Date.now() / 1000),
        is_synced: false,
      });
      return true;
    });
    (present ? out.linked : out.missing).push(tid);
  }
  return out;
}
