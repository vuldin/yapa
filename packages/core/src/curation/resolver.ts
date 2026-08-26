/**
 * Conflict resolver: given a candidate memory and its near neighbors already
 * in the store, decide what should happen — because embedding distance alone
 * cannot distinguish "same fact restated" (skip), "related but distinct"
 * (add), or "the fact CHANGED" (supersede the stale memory).
 *
 * Used by the DSH response-capture pipeline (candidate vs collection) and the
 * janitor sweep (in-store duplicate pairs). Conservative by design: when the
 * evidence is ambiguous the resolver must keep both — losing a good memory to
 * an LLM misjudgment is the expensive error; a lingering duplicate is cheap
 * (decay + compaction handle it later).
 *
 * Follows the classifier/extractor pattern: versioned prompt, one call,
 * robust JSON parsing. Non-destructive — callers apply the decision.
 */

import { callCurationLLM } from './provider.js';

export const RESOLVER_PROMPT_VERSION = 'v1';

export const RESOLVER_SYSTEM_PROMPT = `You are a memory-conflict resolver for a long-term memory system. You are given a CANDIDATE memory and one or more EXISTING memories that are semantically similar to it. Decide what should happen to the candidate.

ACTIONS (choose exactly one per candidate):

- "skip" — the candidate restates a fact the existing memory already covers. Nothing new is stored.
- "add" — the candidate is RELATED but DISTINCT: a different fact that merely looks similar. Store it alongside the existing memory.
- "supersede" — the candidate UPDATES or CORRECTS an existing memory (a value changed, a decision was reversed, a diagnosis was revised, newer information makes the old one stale). The existing memory is archived and the candidate (or your merged rewrite) is stored in its place.

RULES
- BE CONSERVATIVE. Supersede ONLY when the candidate clearly updates, corrects, or contradicts the existing memory. When in doubt, choose "add" (distinct facts) or "skip" (same fact) — never supersede on a hunch.
- A change in a specific value (version, port, path, owner, status, date) between existing and candidate is the classic supersede signal.
- If multiple existing memories are shown, supersede targets exactly ONE of them (the stale one). If none is stale, do not supersede.
- On supersede you may provide "merged_content": a single self-contained statement combining the old context with the new fact (e.g. noting the previous value). Keep it factual and standalone. If the candidate already says everything needed, omit merged_content and the candidate text is used as-is.
- Never merge two memories that are both still true.

OUTPUT FORMAT
Return valid JSON only. No commentary. No markdown fences:
{
  "action": "skip" | "add" | "supersede",
  "target_id": "<id of the existing memory to supersede — required for supersede, omit otherwise>",
  "merged_content": "<optional rewritten content for supersede>",
  "rationale": "<one short sentence>"
}`;

export interface ResolverNeighbor {
  id: string;
  content: string;
  distance: number;
  salience?: number;
}

export type ResolverAction = 'skip' | 'add' | 'supersede';

export interface ResolverDecision {
  action: ResolverAction;
  /** Existing memory to archive (required when action is 'supersede'). */
  targetId?: string;
  /** Rewritten content for the superseding memory (defaults to candidate). */
  mergedContent?: string;
  rationale: string;
}

export interface ResolveOptions {
  /** Optional injected LLM call for testing. */
  call?: typeof callCurationLLM;
}

/** Build the user message presenting candidate + neighbors. */
export function buildResolverUserPrompt(candidate: string, neighbors: ResolverNeighbor[]): string {
  const lines: string[] = ['[CANDIDATE]', candidate, ''];
  lines.push(`[EXISTING MEMORIES — ${neighbors.length} similar]`);
  for (const n of neighbors) {
    lines.push('', `ID: ${n.id}`, `salience: ${n.salience ?? '?'}`, 'CONTENT:', n.content);
  }
  return lines.join('\n');
}

/**
 * Decide what should happen to a candidate given its near neighbors.
 * Throws on unparseable responses — callers treat that as "keep both"
 * (fail-safe in the conservative direction).
 */
export async function resolveConflict(
  candidate: string,
  neighbors: ResolverNeighbor[],
  options: ResolveOptions = {},
): Promise<ResolverDecision> {
  if (neighbors.length === 0) return { action: 'add', rationale: 'no neighbors' };

  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: 'system', content: RESOLVER_SYSTEM_PROMPT },
      { role: 'user', content: buildResolverUserPrompt(candidate, neighbors) },
    ],
    temperature: 0,
    max_tokens: 1024,
    json_mode: true,
  });

  return parseResolverResponse(raw, neighbors);
}

/**
 * Parse a resolver response. Robust to fences/commentary; validates that a
 * supersede target is one of the presented neighbors (a hallucinated target
 * demotes the decision to 'skip' — the conservative failure mode).
 */
export function parseResolverResponse(
  raw: string,
  neighbors: ResolverNeighbor[],
): ResolverDecision {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Resolver response was not a JSON object: ${raw.slice(0, 200)}`);
  }

  const entry = parsed as Record<string, unknown>;
  const rationale = typeof entry.rationale === 'string' ? entry.rationale : '';
  const neighborIds = new Set(neighbors.map(n => n.id));

  if (entry.action === 'supersede') {
    const targetId = typeof entry.target_id === 'string' ? entry.target_id : '';
    if (!neighborIds.has(targetId)) {
      // Refusing to archive a memory the resolver wasn't shown.
      return { action: 'skip', rationale: `invalid supersede target "${targetId}" — kept both` };
    }
    const mergedContent = typeof entry.merged_content === 'string' && entry.merged_content.trim()
      ? entry.merged_content.trim()
      : undefined;
    return { action: 'supersede', targetId, mergedContent, rationale };
  }

  if (entry.action === 'skip') return { action: 'skip', rationale };
  return { action: 'add', rationale };
}

/** Extract the first JSON object from a string (fences/commentary tolerated). */
function extractJsonObject(raw: string): unknown {
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

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new Error(`Could not extract JSON object from resolver response: ${raw.slice(0, 200)}`);
}
