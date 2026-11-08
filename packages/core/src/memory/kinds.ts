/**
 * Typed memories: a memory may say what kind of knowledge it holds and where
 * it stands, so that open decisions, questions and findings can be listed and
 * waited on instead of getting lost in chat.
 *
 *   finding     a result, root cause, retraction or trap: open | resolved
 *   decision    a choice: needed (a person must make it) | proposed |
 *               accepted | superseded | rejected
 *   limitation  something that can't be done yet: open | mitigated |
 *               accepted | closed
 *   question    for a person or another team: open | answered
 *   idea        proposed | adopted | dropped
 *
 * A memory with no `kind` is an ordinary note, as before. All fields live in
 * flat metadata (store metadata must be scalar or a list), and the remote
 * treats them as opaque, so older clients keep them on pull.
 *
 * @module @yapa/core/memory/kinds
 */
import { metadataList } from '../metadata-adapter.js';

export const MEMORY_KINDS = ['finding', 'decision', 'limitation', 'question', 'idea'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const KIND_STATUSES: Record<MemoryKind, readonly string[]> = {
  finding: ['open', 'resolved'],
  decision: ['needed', 'proposed', 'accepted', 'superseded', 'rejected'],
  limitation: ['open', 'mitigated', 'accepted', 'closed'],
  question: ['open', 'answered'],
  idea: ['proposed', 'adopted', 'dropped'],
};

export const DEFAULT_STATUS: Record<MemoryKind, string> = {
  finding: 'open',
  decision: 'proposed',
  limitation: 'open',
  question: 'open',
  idea: 'proposed',
};

/** Statuses that still wait on something (never compacted or decayed away). */
export const OPEN_STATUSES: Record<MemoryKind, readonly string[]> = {
  finding: ['open'],
  decision: ['needed', 'proposed'],
  limitation: ['open'],
  question: ['open'],
  idea: ['proposed'],
};

export const DISPOSITIONS = ['decision', 'task', 'limitation', 'no-action'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The typed fields a caller may set on a memory. */
export interface TypedFields {
  kind?: MemoryKind;
  status?: string;
  /** Who decides (decision) or is asked (question). Absent: anyone. */
  owner?: string;
  /** Tasks this memory belongs to or came from. */
  task_ids?: string[];
  /** decision: the options on the table. */
  options?: string[];
  /** decision: what the writer recommends. */
  recommendation?: string;
  /** finding: what became of it. */
  disposition?: Disposition;
  disposition_ids?: string[];
  disposition_reason?: string;
  /** limitation: what would close it. */
  exit_criteria?: string;
  /** A key for a record kept outside YAPA (e.g. a file in a project's repo). */
  external_ref?: string;
}

/** Metadata keys owned by typed memories (carried over by every rewrite). */
export const TYPED_KEYS = [
  'kind', 'status', 'owner', 'task_ids', 'options', 'recommendation',
  'disposition', 'disposition_ids', 'disposition_reason', 'exit_criteria', 'external_ref',
] as const;

const KIND_ONLY: Partial<Record<(typeof TYPED_KEYS)[number], MemoryKind>> = {
  options: 'decision',
  recommendation: 'decision',
  disposition: 'finding',
  disposition_ids: 'finding',
  disposition_reason: 'finding',
  exit_criteria: 'limitation',
};

export class TypedMemoryError extends Error {
  readonly code = 'typed_memory_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'TypedMemoryError';
  }
}

export function isMemoryKind(k: unknown): k is MemoryKind {
  return typeof k === 'string' && (MEMORY_KINDS as readonly string[]).includes(k);
}

/**
 * Validate typed fields as they will be stored (`current` is the existing
 * metadata on an update) and return the metadata to write. Fills the default
 * status for a new kind. Throws TypedMemoryError with a message meant for the
 * agent.
 */
export function normalizeTyped(fields: TypedFields, current: Record<string, any> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of TYPED_KEYS) {
    const v = (fields as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = k === 'task_ids' || k === 'options' || k === 'disposition_ids' ? metadataList(v) : typeof v === 'string' ? v.trim() : v;
  }
  if (!Object.keys(out).length) return out;

  const curKind = isMemoryKind(current.kind) ? current.kind : undefined;
  if (out.kind !== undefined && !isMemoryKind(out.kind)) {
    throw new TypedMemoryError(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
  }
  if (out.kind && curKind && out.kind !== curKind) {
    throw new TypedMemoryError(`this memory is a ${curKind}; store a new ${out.kind} instead of changing its kind`);
  }
  const kind: MemoryKind | undefined = out.kind ?? curKind;
  const kindSpecific = Object.keys(out).filter(k => k !== 'task_ids' && k !== 'external_ref' && k !== 'owner');
  if (!kind && kindSpecific.length) {
    throw new TypedMemoryError(`${kindSpecific.join(', ')} need a kind (${MEMORY_KINDS.join(', ')})`);
  }
  if (kind) {
    for (const k of Object.keys(out) as Array<keyof typeof KIND_ONLY>) {
      const only = KIND_ONLY[k];
      if (only && only !== kind) throw new TypedMemoryError(`${k} applies to a ${only}, not a ${kind}`);
    }
    if (out.kind && out.status === undefined && current.status === undefined) out.status = DEFAULT_STATUS[kind];
    const status = out.status ?? current.status;
    if (!KIND_STATUSES[kind].includes(status)) {
      throw new TypedMemoryError(`a ${kind}'s status is one of ${KIND_STATUSES[kind].join(', ')}`);
    }
    const merged = { ...current, ...out };
    if (kind === 'decision' && status === 'needed' && metadataList(merged.options).length < 2) {
      throw new TypedMemoryError('a decision that is needed lists at least two options (and ideally a recommendation)');
    }
    if (kind === 'finding' && status === 'resolved') {
      const d = merged.disposition;
      if (!(DISPOSITIONS as readonly string[]).includes(d)) {
        throw new TypedMemoryError(`a resolved finding says what became of it: disposition ${DISPOSITIONS.join(', ')}`);
      }
      if (d === 'no-action' && !String(merged.disposition_reason ?? '').trim()) {
        throw new TypedMemoryError('a no-action disposition gives disposition_reason');
      }
      if (d !== 'no-action' && !metadataList(merged.disposition_ids).length) {
        throw new TypedMemoryError(`a ${d} disposition names it in disposition_ids`);
      }
    }
  }
  return out;
}

/** True for a typed memory that still waits on something. */
export function isOpenTyped(meta: Record<string, any> | undefined | null): boolean {
  if (!meta || !isMemoryKind(meta.kind)) return false;
  return OPEN_STATUSES[meta.kind].includes(meta.status ?? DEFAULT_STATUS[meta.kind]);
}

/** The typed fields of `meta`, for copying onto a memory that replaces it. */
export function carryTyped(meta: Record<string, any> | undefined | null): Record<string, any> {
  const out: Record<string, any> = {};
  if (!meta) return out;
  for (const k of TYPED_KEYS) if (meta[k] !== undefined && meta[k] !== '') out[k] = meta[k];
  return out;
}

/** Who a typed memory waits on: its owner, or [] for anyone. */
export function waitsOnPeople(meta: Record<string, any>): string[] {
  return meta.owner ? [String(meta.owner)] : [];
}

/** "[decision, needed, for josh]" (empty for an untyped memory). */
export function typedLabel(meta: Record<string, any> | undefined | null): string {
  if (!meta || !isMemoryKind(meta.kind)) return '';
  const parts: string[] = [meta.kind, meta.status ?? DEFAULT_STATUS[meta.kind as MemoryKind]];
  if (meta.owner && (meta.kind === 'decision' || meta.kind === 'question')) parts.push(`for ${meta.owner}`);
  return `[${parts.join(', ')}]`;
}
