/**
 * Collections whose project keeps its canonical records (findings,
 * decisions, questions) in its own files: `records_elsewhere` in the scope
 * file. There a typed memory needs an `external_ref`, so the only typed
 * memories are the ones the project publishes (`yapa memory put --ref`).
 * Everything else, capture included, is stored as a plain note, and
 * "Waiting on you" and the findings backlog show only what the project put
 * there.
 *
 * @module @yapa/core/memory/records-elsewhere
 */
import { addDocument, getDocumentsByFilter, getDocumentsByIds, metadataDelta, patchDocument } from '../store/index.js';
import { getConfig } from '../config.js';
import { withDocLock } from '../doc-lock.js';
import { readScopeSettings } from '../scope-file.js';
import { getCollectionRedirects, resolveCollectionRedirect } from '../sync/sentinel.js';
import { isMemoryKind, TYPED_KEYS } from './kinds.js';

export const KEPT_AS_NOTE_REASON = 'this collection keeps its records in the project\'s own files, so only what the project publishes there (yapa memory put --ref) is typed';

/** A write refused because the collection keeps its records elsewhere. */
export class RecordsElsewhereError extends Error {
  readonly code = 'records_elsewhere';
  constructor(collection: string, what: string, next = '') {
    super(`Refused: ${what} in ${collection}: ${KEPT_AS_NOTE_REASON}. Record it in the project's own records instead, the way its instructions say${next ? `, then ${next}` : ''}.`);
    this.name = 'RecordsElsewhereError';
  }
}

/**
 * True when `collection` keeps its records elsewhere: it is listed, or a
 * listed collection was merged into it (the mark follows the merge).
 */
export async function keepsRecordsElsewhere(collection: string): Promise<boolean> {
  const listed = readScopeSettings().records_elsewhere;
  if (!listed.length) return false;
  if (listed.includes(collection)) return true;
  const redirects = await getCollectionRedirects();
  return listed.some(c => resolveCollectionRedirect(c, redirects).collection === collection);
}

/**
 * The typed fields to store for a new memory: unchanged, or, in a
 * records-elsewhere collection (`marked`) without an external_ref, only its
 * task links (`keptAsNote` then says the kind was dropped).
 */
export function typedForCollection(marked: boolean, typed: Record<string, any>): { typed: Record<string, any>; keptAsNote: boolean } {
  if (!marked || !isMemoryKind(typed.kind) || typed.external_ref) return { typed, keptAsNote: false };
  return { typed: typed.task_ids?.length ? { task_ids: typed.task_ids } : {}, keptAsNote: true };
}

/**
 * Refuse an update that would make an untyped memory typed in a
 * records-elsewhere collection (a status change on a published one, such as
 * a person's answer, still goes through).
 */
export async function assertMayType(collection: string, current: Record<string, any>, typed: Record<string, any>): Promise<void> {
  if (!isMemoryKind(typed.kind) || isMemoryKind(current.kind)) return;
  if (typed.external_ref || current.external_ref || !(await keepsRecordsElsewhere(collection))) return;
  throw new RecordsElsewhereError(collection, `giving ${current.parent_id ?? 'this memory'} a kind`);
}

export interface UntypeItem {
  id: string;
  kind: string;
  status?: string;
  content: string;
}

export interface UntypeResult {
  collection: string;
  dry_run: boolean;
  items: UntypeItem[];
  by_kind: Record<string, number>;
  /** Typed memories left alone: someone else's. */
  others: number;
}

const UNTYPED_KEYS = TYPED_KEYS.filter(k => k !== 'task_ids' && k !== 'external_ref');

/**
 * Turn your typed memories in a records-elsewhere collection that have no
 * external_ref into notes: kind, status, owner and the kind's fields are
 * dropped (task links stay), with a dated line saying why. For cleaning up
 * copies made before the collection was marked. Archived memories are left
 * as they are.
 */
export async function untypeCollection(requested: string, opts: { dryRun?: boolean } = {}): Promise<UntypeResult> {
  // A collection merged away here is followed: its memories moved with it.
  const collection = resolveCollectionRedirect(requested, await getCollectionRedirects()).collection;
  if (!(await keepsRecordsElsewhere(collection))) {
    throw new Error(`${collection} is not marked as keeping its records elsewhere: mark it first (yapa scope records-elsewhere add ${collection})`);
  }
  const me = getConfig().USERNAME;
  const docs = await getDocumentsByFilter(collection, { type: 'memory' }, 100_000);
  const groups = new Map<string, typeof docs>();
  for (const d of docs) {
    if (!isMemoryKind(d.metadata.kind) || d.metadata.external_ref || d.metadata.archived === true) continue;
    const id = d.metadata.parent_id ?? d.id;
    groups.set(id, [...(groups.get(id) ?? []), d]);
  }
  const result: UntypeResult = { collection, dry_run: !!opts.dryRun, items: [], by_kind: {}, others: 0 };
  for (const [id, parts] of groups) {
    const meta = parts[0].metadata;
    if (meta.username && meta.username !== me) {
      result.others++;
      continue;
    }
    parts.sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0));
    result.items.push({ id, kind: meta.kind, ...(meta.status ? { status: meta.status } : {}), content: parts.map(p => p.content).join('') });
    result.by_kind[meta.kind] = (result.by_kind[meta.kind] ?? 0) + 1;
    if (opts.dryRun) continue;
    await withDocLock(collection, id, async () => {
      const now = Math.floor(Date.now() / 1000);
      const day = new Date(now * 1000).toISOString().slice(0, 10);
      const fresh = meta.parent_id
        ? (await getDocumentsByFilter(collection, { parent_id: id }, 1000)).sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0))
        : await getDocumentsByIds(collection, [id]);
      for (const [i, d] of fresh.entries()) {
        const next: Record<string, any> = { ...d.metadata, updated_at: now, is_synced: false };
        for (const k of UNTYPED_KEYS) delete next[k];
        if (i === fresh.length - 1) {
          const note = `${day} ${me}: typed fields removed (was a ${d.metadata.kind}${d.metadata.status ? `, ${d.metadata.status}` : ''}): this collection keeps its records in the project's own files.`;
          await addDocument(collection, d.id, `${d.content}\n\n${note}`, next);
        }
        // addDocument may merge metadata into what is stored: drop the typed keys explicitly.
        await patchDocument(collection, d.id, metadataDelta(i === fresh.length - 1 ? { ...next, ...pick(d.metadata, UNTYPED_KEYS) } : d.metadata, next));
      }
    });
  }
  return result;
}

const pick = (m: Record<string, any>, keys: readonly string[]) => Object.fromEntries(keys.filter(k => m[k] !== undefined).map(k => [k, m[k]]));
