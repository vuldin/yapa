/**
 * ChromaDB v2 only accepts primitive types (string, number, boolean).
 * Arrays and objects must be converted to strings.
 */
export interface RawMetadata {
  [key: string]: string | number | boolean;
}

/**
 * Convert JavaScript objects to ChromaDB-compatible format.
 * Arrays -> comma-separated strings, Objects -> JSON strings.
 */
export function toChroma(metadata: Record<string, any>): RawMetadata {
  const result: RawMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) {
      continue;
    } else if (Array.isArray(value)) {
      // A list whose items contain commas (free text, e.g. a decision's
      // options) is kept as JSON; fromChroma parses either form.
      result[key] = value.some(v => typeof v !== 'string' || v.includes(',') || v.startsWith('['))
        ? JSON.stringify(value)
        : value.join(',');
    } else if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/** List fields: comma-separated, or JSON when an item holds a comma. */
const ARRAY_FIELDS = new Set(['tags', 'depends_on', 'blocks', 'related_ids', 'claim_scope', 'task_ids', 'memory_ids', 'waits_on', 'options', 'disposition_ids']);
/** Free text: always a string, even when it looks like JSON ("[2026] plan", a template starting with "{"). */
const TEXT_FIELDS = new Set([
  'title', 'notes', 'recurrence_notes', 'blockedReason', 'blocked_reason', 'recommendation', 'exit_criteria',
  'disposition_reason', 'context', 'question', 'owner', 'external_ref', 'sync_rejected_message',
]);

/** A list field as stored (an array, or comma-separated), trimmed, without empty entries. */
export const metadataList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map(String).map(s => s.trim()).filter(Boolean);

/**
 * Convert ChromaDB format back to JavaScript objects: JSON-looking strings
 * are decoded (objects, lists with commas in their items), except free-text
 * fields; known list fields that aren't JSON are comma-separated.
 */
export function fromChroma(metadata: RawMetadata): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      const json = !TEXT_FIELDS.has(key) && (value.startsWith('{') || value.startsWith('['));
      if (json) {
        try {
          result[key] = JSON.parse(value);
          continue;
        } catch {
          // Not valid JSON, treat as string
        }
      }

      if (ARRAY_FIELDS.has(key)) {
        if (value === '') {
          result[key] = [];
        } else if (value.includes(',')) {
          result[key] = value.split(',').filter(s => s);
        } else {
          result[key] = [value];
        }
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
