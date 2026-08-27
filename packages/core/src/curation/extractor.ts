/**
 * Response extractor: given one agent turn (the human prompt plus the
 * assistant's visible response text), decide whether anything in it deserves
 * long-term storage and return structured memory candidates.
 *
 * This exists because agent-side capture ("call memory_store when a trigger
 * fires") is unreliable — the model forgets under load. The extractor runs
 * OUTSIDE the agent loop (host-driven, aux LLM route), so coverage is
 * deterministic: every turn is judged, whether or not the agent remembered.
 *
 * Follows the classifier pattern: versioned prompt constant, single batched
 * LLM call, robust JSON parsing. Non-destructive — callers handle storage
 * (and dedup against existing memories).
 */

import { callCurationLLM } from './provider.js';

export const EXTRACTOR_PROMPT_VERSION = 'v1';

export const EXTRACTOR_SYSTEM_PROMPT = `You are a memory extractor for a long-term memory system. Given ONE conversation turn — the user's message and the assistant's response — decide whether anything said is worth storing in long-term memory, and extract it.

STORE a candidate when the turn contains:
- A bug's root cause or a non-obvious diagnosis
- A configuration value, env var, endpoint, file path, or credential location worth remembering
- A user preference, decision, or correction ("never do X", "we decided Y", "actually, it's Z")
- A non-obvious technical fact about the codebase, a system, or a customer's environment
- A solution that took real effort to find and is likely to recur
- A commitment, follow-up, or action item

DO NOT STORE:
- Ephemeral conversation state (plans for this turn, progress narration, acknowledgments)
- Obvious code patterns or anything readable from the code/git history itself
- Restatements of the user's message with no new information
- Generic advice, boilerplate, or filler
- Anything already true by definition of the task at hand

RULES
- Return 0 to 3 candidates. Zero is a common and correct answer — most turns contain nothing durable.
- Each candidate must be SELF-CONTAINED: understandable months later without the conversation. Include the specific names, values, and paths that make it useful.
- Write candidates as statements of fact, not narration ("The FD codec requires X", not "I found that the FD codec requires X").
- Prefer ONE merged candidate over several overlapping ones.
- Assign salience 1.0-3.0: 1.0 minor/contextual, 2.0 clearly useful, 3.0 critical hard-won knowledge. The caller may clamp this.
- sector is "semantic" for durable facts/patterns, "episodic" for events, decisions, and things tied to a moment in time.
- tags: 1-4 short lowercase tags for categorization.

OUTPUT FORMAT
Return valid JSON only. No commentary. No markdown fences. A JSON array of candidates:
[
  {
    "content": "<the self-contained memory text>",
    "tags": ["<tag>"],
    "sector": "semantic" | "episodic",
    "salience": <number 1.0-3.0>,
    "rationale": "<one short sentence: why this is durable>"
  }
]
If nothing qualifies, return exactly: []`;

export interface ExtractorInput {
  /** The scope/collection the turn belongs to (context for the judge). */
  collection: string;
  /** The human's message for this turn (may be empty for injected/goal turns). */
  userText: string;
  /** The assistant's visible response text for the turn, concatenated across steps. */
  assistantText: string;
}

export interface ExtractedMemory {
  content: string;
  tags: string[];
  sector: 'semantic' | 'episodic';
  salience: number;
  rationale: string;
}

export interface ExtractOptions {
  /** Optional injected LLM call for testing. */
  call?: typeof callCurationLLM;
  /** Max candidates to keep (the prompt asks for <=3; this is a hard clamp). */
  maxMemories?: number;
}

/** Build the user message presenting the turn to judge. */
export function buildExtractorUserPrompt(input: ExtractorInput): string {
  const lines: string[] = [
    `Scope/collection: ${input.collection}`,
    '',
    '[USER MESSAGE]',
    input.userText.trim() || '(none — injected or continuation turn)',
    '',
    '[ASSISTANT RESPONSE]',
    input.assistantText.trim(),
  ];
  return lines.join('\n');
}

/**
 * Extract memory candidates from one conversation turn. Returns [] when the
 * turn contains nothing durable (the common case). Non-destructive — the
 * caller dedups against the store and persists.
 */
export async function extractMemories(
  input: ExtractorInput,
  options: ExtractOptions = {},
): Promise<ExtractedMemory[]> {
  if (!input.assistantText.trim()) return [];

  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
      { role: 'user', content: buildExtractorUserPrompt(input) },
    ],
    temperature: 0,
    max_tokens: 1536,
    json_mode: true,
  });

  const parsed = parseExtractorResponse(raw);
  const max = options.maxMemories ?? 3;
  return parsed.slice(0, Math.max(0, max));
}

/**
 * Parse an extractor LLM response into structured candidates. Robust to
 * minor formatting drift — strips fences, extracts JSON substrings, drops
 * malformed entries, normalizes sector/salience/tags.
 */
export function parseExtractorResponse(raw: string): ExtractedMemory[] {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Extractor response was not a JSON array: ${raw.slice(0, 200)}`);
  }

  const results: ExtractedMemory[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const content = (entry as any).content;
    if (typeof content !== 'string' || !content.trim()) continue;

    const tagsRaw = (entry as any).tags;
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t => t.trim().toLowerCase()).slice(0, 4)
      : [];

    results.push({
      content: content.trim(),
      tags,
      sector: (entry as any).sector === 'episodic' ? 'episodic' : 'semantic',
      salience: clampSalience((entry as any).salience),
      rationale: typeof (entry as any).rationale === 'string' ? (entry as any).rationale : '',
    });
  }
  return results;
}

function clampSalience(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, n));
}

/**
 * Extract the first JSON array from a string. Tolerates markdown fences,
 * leading/trailing commentary, or a lone JSON array response.
 * (Mirrors the classifier's parser — kept separate so the two prompts can
 * drift independently.)
 */
function extractJsonArray(raw: string): unknown {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new Error(`Could not extract JSON array from extractor response: ${raw.slice(0, 200)}`);
}
