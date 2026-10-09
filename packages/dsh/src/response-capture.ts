/**
 * Response capture: judges every completed turn for durable knowledge and
 * stores it autonomously — closing the gap where agent-side capture ("call
 * yapa_memory_store when a trigger fires") depends on the model remembering.
 *
 * Mechanics: `session/event` is the harness's durable-event firehose. We
 * buffer the turn's direct human prompt and the assistant's visible text
 * (`assistant/message` text blocks; reasoning/tool-call blocks excluded), and
 * at `turn/end` run ONE extraction call through the aux LLM route
 * (curation/provider → llm-bridge → ctx.llm). Candidates then go through
 * retrieve-then-decide against the collection: near neighbors (cosine gate)
 * are presented to the conservative resolver, which decides skip / add /
 * supersede — so a CHANGED fact updates the stale memory instead of being
 * lost to dedup, and an agent-side yapa_memory_store mid-turn still dedupes
 * to a skip (its store lands before turn/end).
 *
 * Auto-captured memories are deliberately weaker than agent-curated ones:
 * salience clamped to `captureMaxSalience`, tagged `auto-capture`, carrying
 * provenance metadata (session id, turn, prompt version). The next prompt's
 * injection notes the capture for visibility (`takeCaptureNotice`).
 *
 * Everything here is async and fail-open: extraction runs off the event
 * dispatch path, and any failure degrades to a stderr log, never a blocked
 * turn. Disable with `captureResponses: false`.
 *
 * @module yapa/response-capture
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import {
  captureTurn as coreCaptureTurn,
  extractMemories,
  queryDocuments,
  resolveConflict,
  storeMemory,
} from '@yapa/core';
import { detectCollection } from './injector.js';
import type { ResolvedConfig } from './config.js';

const log = (msg: string) => process.stderr.write(`[yapa] ${msg}\n`);

interface TurnBuffer {
  /** Turn number currently accumulating (from turn/start). */
  turn: number;
  /** Latest direct human prompt text claimed this turn. */
  userText: string;
  /** Assistant visible-text parts, in arrival order. */
  assistantParts: string[];
}

/** One-line visibility notices, consumed by the next injection for that session. */
const captureNotices = new Map<string, string>();

/** In-flight capture pipelines, so tests (and disposal) can drain them. */
const pendingCaptures = new Set<Promise<void>>();

/** Resolve when every in-flight capture has settled. */
export function whenCapturesIdle(): Promise<void> {
  return Promise.allSettled([...pendingCaptures]).then(() => undefined);
}

/**
 * Take (and clear) the pending auto-capture notice for a session. The
 * injector calls this while assembling its context message.
 */
export function takeCaptureNotice(sessionId: string): string | undefined {
  const notice = captureNotices.get(sessionId);
  if (notice !== undefined) captureNotices.delete(sessionId);
  return notice;
}

/** Extract visible text from an assistant message's content blocks. */
function assistantText(message: { content?: Array<{ type?: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('\n');
}

export function registerResponseCapture(ctx: Context, getResolved: () => ResolvedConfig): void {
  const buffers = new Map<string, TurnBuffer>();

  ctx.on('session/disposed', session => {
    buffers.delete(session.id);
    captureNotices.delete(session.id);
  });

  ctx.on('session/event', (session, event) => {
    const resolved = getResolved();
    if (!resolved.captureResponses) return;

    try {
      if (event.type === 'turn/start') {
        buffers.set(session.id, {
          turn: (event.data as { turn: number }).turn,
          userText: '',
          assistantParts: [],
        });
        return;
      }

      if (event.type === 'user/message') {
        // Only the direct human prompt — plugin-injected context, goal
        // rounds, and tool results are user-ROLE but not user-SOURCED.
        const msg = event.data as { source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> };
        if (msg.source?.kind !== 'user') return;
        const buffer = buffers.get(session.id);
        if (!buffer) return;
        buffer.userText = (msg.content ?? [])
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join('\n');
        return;
      }

      if (event.type === 'assistant/message') {
        const data = event.data as { message?: { content?: Array<{ type?: string; text?: string }> } };
        const text = data.message ? assistantText(data.message) : '';
        const buffer = buffers.get(session.id);
        if (buffer && text.trim()) buffer.assistantParts.push(text);
        return;
      }

      if (event.type === 'turn/end') {
        const data = event.data as { turn: number; reason?: { kind?: string } };
        if (data.reason?.kind === 'blocked') return; // never ran — nothing to judge
        const buffer = buffers.get(session.id);
        if (!buffer) return;
        buffers.delete(session.id);

        const userText = buffer.userText.trim();
        const assistantTextJoined = buffer.assistantParts.join('\n\n').trim();
        // Heuristic prefilter: skip trivial turns before spending an LLM call.
        if (!assistantTextJoined) return;
        if (userText.length + assistantTextJoined.length < resolved.captureMinChars) return;

        const run: Promise<void> = captureTurn(
          session.id,
          session.header.cwd,
          buffer.turn,
          userText,
          assistantTextJoined,
          resolved,
        ).catch(e => { log(`Response capture failed for session ${session.id} (non-fatal): ${e}`); });
        pendingCaptures.add(run);
        void run.finally(() => pendingCaptures.delete(run));
      }
    } catch (e) {
      // Fail open: capture must never break the event pipeline.
      log(`Response capture listener error (non-fatal): ${e}`);
    }
  });
}

async function captureTurn(
  sessionId: string,
  cwd: string | undefined,
  turn: number,
  userText: string,
  assistantTextJoined: string,
  resolved: ResolvedConfig,
): Promise<void> {
  const { collection } = await detectCollection(cwd, resolved.projectRoots, resolved.customers);
  // The pipeline lives in core (shared with the Claude Code Stop hook); pass
  // this module's bindings so the plugin's collaborators stay swappable.
  const result = await coreCaptureTurn(
    { collection, sessionId, turn, userText, assistantText: assistantTextJoined },
    {
      maxMemories: resolved.captureMaxMemories,
      maxSalience: resolved.captureMaxSalience,
      dedupeDistance: resolved.captureDedupeDistance,
    },
    { extractMemories, queryDocuments, resolveConflict, storeMemory, log },
  );
  if (result.notice) captureNotices.set(sessionId, result.notice);
}
