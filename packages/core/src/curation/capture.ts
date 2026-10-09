/**
 * Turn capture: judge one completed conversation turn for durable knowledge
 * and store it — the host-neutral half of "response capture". Hosts own the
 * event plumbing (DSH: session/event buffers; Claude Code: the Stop hook) and
 * hand the finished turn here.
 *
 * Pipeline: one aux-LLM extraction call, then retrieve-then-decide per
 * candidate. Near neighbors (cosine gate) go to the conservative resolver,
 * which picks skip / add / supersede — so a CHANGED fact replaces the stale
 * memory instead of being lost to dedup, and a fact the agent already stored
 * mid-turn dedupes to a skip.
 *
 * Auto-captured memories are deliberately weaker than agent-curated ones:
 * salience clamped to `maxSalience`, tagged `auto-capture`, carrying
 * provenance metadata (session id, turn, prompt versions).
 *
 * @module @yapa/core/curation/capture
 */
import { queryDocuments } from '../store/index.js';
import { storeMemory } from '../memory/store.js';
import { extractMemories, EXTRACTOR_PROMPT_VERSION } from './extractor.js';
import { resolveConflict, RESOLVER_PROMPT_VERSION } from './resolver.js';

/** Bound the extractor input so a monster turn can't blow up aux cost. */
export const MAX_EXTRACT_CHARS = 12_000;

export interface CaptureTurnInput {
  collection: string;
  sessionId: string;
  turn: number;
  userText: string;
  assistantText: string;
}

export interface CaptureTurnOptions {
  maxMemories: number;
  maxSalience: number;
  /** Cosine distance under which an existing memory counts as a neighbor. */
  dedupeDistance: number;
}

/** Collaborators, injectable so hosts can test their plumbing in isolation. */
export interface CaptureDeps {
  extractMemories: typeof extractMemories;
  queryDocuments: typeof queryDocuments;
  resolveConflict: typeof resolveConflict;
  storeMemory: typeof storeMemory;
  log: (msg: string) => void;
}

export interface CaptureTurnResult {
  stored: number;
  skipped: number;
  superseded: number;
  /** One-line visibility notice for the next injection, or undefined if nothing happened. */
  notice?: string;
}

const defaultDeps: CaptureDeps = {
  extractMemories,
  queryDocuments,
  resolveConflict,
  storeMemory,
  log: msg => process.stderr.write(`[yapa] ${msg}\n`),
};

export async function captureTurn(
  input: CaptureTurnInput,
  options: CaptureTurnOptions,
  deps: Partial<CaptureDeps> = {},
): Promise<CaptureTurnResult> {
  const d = { ...defaultDeps, ...deps };
  const { collection, sessionId, turn } = input;

  const candidates = await d.extractMemories(
    {
      collection,
      userText: input.userText.slice(0, MAX_EXTRACT_CHARS),
      assistantText: input.assistantText.slice(0, MAX_EXTRACT_CHARS),
    },
    { maxMemories: options.maxMemories },
  );
  if (!candidates.length) return { stored: 0, skipped: 0, superseded: 0 };

  let stored = 0;
  let skipped = 0;
  let superseded = 0;
  for (const candidate of candidates) {
    const neighbors = await d.queryDocuments(collection, candidate.content, 3, { type: 'memory' })
      .then(results => results.filter(r => r.distance < options.dedupeDistance && r.metadata?.archived !== true))
      .catch(() => []); // collection may not exist yet → nothing to conflict with

    let content = candidate.content;
    let supersedes: string | undefined;
    let resolverRationale: string | undefined;

    if (neighbors.length > 0) {
      let decision;
      try {
        decision = await d.resolveConflict(
          candidate.content,
          neighbors.map(n => ({ id: n.id, content: n.content, distance: n.distance, salience: n.metadata?.salience })),
        );
      } catch (e) {
        // Never blind-store on resolver failure: that double-stores a fact the
        // agent already captured mid-turn. Fall back to a STRICT distance gate.
        d.log(`Resolver failed for a candidate in ${collection}: ${e}`);
        const strictThreshold = options.dedupeDistance / 2;
        if (neighbors.some(n => n.distance < strictThreshold)) {
          skipped++;
          continue;
        }
        decision = { action: 'add' as const, rationale: 'resolver error, passed strict distance gate' };
      }

      if (decision.action === 'skip') {
        skipped++;
        continue;
      }
      if (decision.action === 'supersede' && decision.targetId) {
        supersedes = decision.targetId;
        content = decision.mergedContent ?? candidate.content;
        resolverRationale = decision.rationale;
      }
    }

    await d.storeMemory(content, {
      collection,
      tags: [...new Set([...candidate.tags, 'auto-capture'])],
      salience: Math.min(candidate.salience, options.maxSalience),
      sector: candidate.sector,
      supersedes,
      metadata: {
        source: 'auto-capture',
        session_id: sessionId,
        turn,
        extractor_prompt_version: EXTRACTOR_PROMPT_VERSION,
        rationale: candidate.rationale,
        ...(resolverRationale !== undefined && {
          resolver_prompt_version: RESOLVER_PROMPT_VERSION,
          resolver_rationale: resolverRationale,
        }),
      },
    });
    stored++;
    if (supersedes) superseded++;
  }

  let notice: string | undefined;
  if (stored > 0 || skipped > 0) {
    notice = `Auto-captured ${stored} ${stored === 1 ? 'memory' : 'memories'} from last turn`
      + (superseded ? `, ${superseded} superseding stale ${superseded === 1 ? 'memory' : 'memories'}` : '')
      + (skipped ? ` (${skipped} skipped as already known)` : '')
      + ` → \`${collection}\``;
    d.log(`${notice} [session ${sessionId}, turn ${turn}]`);
  }
  return { stored, skipped, superseded, notice };
}
