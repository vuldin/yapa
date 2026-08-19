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
      result[key] = value.join(',');
    } else if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Convert ChromaDB format back to JavaScript objects.
 * Comma-separated strings -> Arrays (for known array fields), JSON strings -> Objects.
 */
export function fromChroma(metadata: RawMetadata): Record<string, any> {
  const result: Record<string, any> = {};
  const arrayFields = ['tags', 'depends_on', 'blocks', 'related_ids'];

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      if (value.startsWith('{') || value.startsWith('[')) {
        try {
          result[key] = JSON.parse(value);
          continue;
        } catch {
          // Not valid JSON, treat as string
        }
      }

      if (arrayFields.includes(key)) {
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
