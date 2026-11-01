/**
 * Memories that index records kept outside YAPA. A project whose canonical
 * records live elsewhere (files in its own repo, a tracker) can publish the
 * ones that matter to YAPA's views, such as a decision a person must make,
 * keyed by `external_ref`. Putting the same ref again updates that memory
 * instead of adding a second one, so a project's tooling can re-run the
 * export as often as it likes.
 *
 * @module @yapa/core/memory/external
 */
import { getDocumentsByFilter, getOrCreateCollection } from '../store/index.js';
import { carryTyped, normalizeTyped, type TypedFields } from './kinds.js';
import { storeMemory } from './store.js';
import { chunkText } from '../chunking.js';
import { updateMemory } from './update.js';

export interface ExternalPut {
  content: string;
  typed: TypedFields;
  tags?: string[];
}

export interface ExternalPutResult {
  id: string;
  action: 'created' | 'updated' | 'unchanged';
}

/** The memory for `ref` in `collection`, if any (its first chunk). */
export async function findExternal(collection: string, ref: string) {
  const docs = await getDocumentsByFilter(collection, { type: 'memory', external_ref: ref }, 50).catch(() => []);
  return docs.find(d => d.metadata.archived !== true) ?? null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function putExternal(collection: string, ref: string, put: ExternalPut): Promise<ExternalPutResult> {
  if (!ref.trim()) throw new Error('external_ref is required');
  const typed = normalizeTyped({ ...put.typed, external_ref: ref });
  await getOrCreateCollection(collection);
  const existing = await findExternal(collection, ref);
  if (!existing) {
    const r = await storeMemory(put.content, { collection, tags: put.tags, typed });
    return { id: r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, '') : r.ids[0], action: 'created' };
  }
  const id = existing.metadata.parent_id ?? existing.id;
  const cur = carryTyped(existing.metadata);
  const typedChanged = Object.keys(typed).some(k => !same(typed[k], cur[k]));
  const tagsChanged = put.tags !== undefined && !same(put.tags, existing.metadata.tags);
  // A chunked memory's text is compared on its first chunk only: the index
  // carries short summaries, so a changed long body re-stores it.
  const contentChanged = existing.metadata.parent_id ? !put.content.startsWith(existing.content) : put.content !== existing.content;
  if (contentChanged && !existing.metadata.parent_id && chunkText(put.content).length === 1) {
    await updateMemory(id, { ...typed, content: put.content, ...(tagsChanged ? { tags: put.tags } : {}) }, collection);
    return { id, action: 'updated' };
  }
  if (contentChanged) {
    // Too long for one chunk: a new memory supersedes this one (anything
    // waiting on the old id follows superseded_by).
    const r = await storeMemory(put.content, { collection, tags: put.tags ?? existing.metadata.tags, typed: { ...cur, ...typed }, supersedes: id });
    return { id: r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, '') : r.ids[0], action: 'updated' };
  }
  if (!typedChanged && !tagsChanged) return { id, action: 'unchanged' };
  await updateMemory(id, { ...typed, ...(tagsChanged ? { tags: put.tags } : {}) }, collection);
  return { id, action: 'updated' };
}
