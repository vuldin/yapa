import { callCurationLLM } from './provider.js';
import {
  CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
  type ClassifierInput,
} from './prompts.js';

export interface ClassifierResult {
  id: string;
  trainable: number;
  durability: number;
  generalizability: number;
  rationale: string;
}

export interface ClassifyOptions {
  /** Optional injected LLM call for testing. */
  call?: typeof callCurationLLM;
}

/**
 * Classify a batch of memories. Returns one ClassifierResult per input.
 * Non-destructive — callers handle persistence.
 */
export async function classifyMemories(
  memories: ClassifierInput[],
  options: ClassifyOptions = {},
): Promise<ClassifierResult[]> {
  if (memories.length === 0) return [];

  const caller = options.call ?? callCurationLLM;
  const userPrompt = buildClassifierUserPrompt(memories);

  const raw = await caller({
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 2048,
    json_mode: true,
  });

  return parseClassifierResponse(raw, memories);
}

/**
 * Parse a classifier LLM response into structured results.
 * Robust to minor formatting drift — strips markdown fences, extracts JSON
 * substrings, clamps score ranges, skips entries for memories not in the input.
 */
export function parseClassifierResponse(
  raw: string,
  memories: ClassifierInput[],
): ClassifierResult[] {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Classifier response was not a JSON array: ${raw.slice(0, 200)}`);
  }

  const byId = new Map(memories.map(m => [m.id, m]));
  const seen = new Set<string>();
  const results: ClassifierResult[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String((entry as any).id ?? '');
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);

    results.push({
      id,
      trainable: clamp01((entry as any).trainable),
      durability: clamp01((entry as any).durability),
      generalizability: clamp01((entry as any).generalizability),
      rationale: typeof (entry as any).rationale === 'string' ? (entry as any).rationale : '',
    });
  }

  return results;
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Extract the first JSON array from a string. Tolerates markdown fences,
 * leading/trailing commentary, or a lone JSON array response.
 */
function extractJsonArray(raw: string): unknown {
  const trimmed = raw.trim();

  // Direct parse for well-formed responses
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Strip ```json / ``` fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall through
    }
  }

  // Extract the widest bracketed substring and try to parse
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new Error(`Could not extract JSON array from classifier response: ${raw.slice(0, 200)}`);
}

export { CLASSIFIER_PROMPT_VERSION };
