/**
 * Always-on context injection: replaces the MCP install's Claude-Code hook
 * CLI (`session-start`, `user-prompt-submit`) with an `agent/pre-step`
 * waterfall listener.
 *
 * Why pre-step (not `system-prompt/assemble`): the loop assembles the prompt
 * BEFORE appending the turn's `user/message` events, so an assemble-time
 * listener cannot see the current prompt. `agent/pre-step` runs after the
 * inbox claim with the actual messages in hand — including the just-submitted
 * human prompt — and lets us splice an injected context message into the
 * durable batch (source `{kind: 'plugin', plugin: 'yapa', form: 'recall'}`).
 *
 * Every store call is fail-open: a ChromaDB outage degrades to no injected
 * context, never a blocked or failed step.
 *
 * @module yapa/injector
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  recallMemory,
  listTasks,
  listCollections,
  collectionSize,
  getConfig,
} from '@yapa/core';
import type { ResolvedConfig } from './config.js';
import { takeCaptureNotice } from './response-capture.js';
import { detectCollection, type CollectionDetection } from './scope.js';

interface AgentState {
  /** Cache of the detected collection for this agent's session. */
  detection?: CollectionDetection;
  /** ID of the human message the last recall injection ran for. */
  recalledMessageId?: string;
  /** Collections whose open tasks were already surfaced this session. */
  tasksSurfaced: Set<string>;
}

/** Extract text from a user message's content blocks. */
function messageText(message: UserMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Re-exported for the compaction/response capture modules (they only need the
 * collection string, never the ambiguity flag).
 */
export { detectCollection } from './scope.js';

/**
 * Register the pre-step injector. State is keyed by agent (== session) id and
 * dropped on session disposal; registration is effect-scoped to the plugin.
 */
export function registerInjector(ctx: Context, getResolved: () => ResolvedConfig): void {
  const states = new Map<string, AgentState>();

  ctx.on('session/disposed', session => {
    states.delete(session.id);
  });

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;

    try {
      const resolved = getResolved();
      const state = states.get(agent.id) ?? { tasksSurfaced: new Set<string>() };
      states.set(agent.id, state);

      const detection = state.detection
        ?? (state.detection = await detectCollection(agent.session.header.cwd, resolved.projectRoots, resolved.customers));
      const collection = detection.collection;

      // The newest direct human prompt claimed for this step, if any.
      const human = messages.filter(m => (m.source as { kind?: string }).kind === 'user');
      const promptMessage = human.at(-1);
      const promptText = promptMessage ? messageText(promptMessage).trim() : '';

      const doRecall = resolved.injectRecall
        && promptMessage
        && promptText
        && state.recalledMessageId !== promptMessage.id;
      const doTasks = resolved.injectTasks && !state.tasksSurfaced.has(collection);
      const captureNotice = takeCaptureNotice(agent.id);

      if (!doRecall && !doTasks && !captureNotice) return decision;
      const lines: string[] = ['# YAPA Context', ''];
      if (detection.ambiguous) {
        lines.push(
          `**Scope:** AMBIGUOUS — both \`${detection.ambiguous[0]}\` and \`${detection.ambiguous[1]}\` exist for this folder. `
          + 'Ask the user which collection to use BEFORE storing anything, then pass that collection explicitly on all yapa_* calls for the rest of this session.',
          `_(Recalls/tasks below default to \`${collection}\` until the user answers.)_`,
        );
      } else {
        lines.push(`**Scope:** \`${collection}\``);
      }

      if (captureNotice) lines.push('', `## Auto-capture\n${captureNotice}`);

      if (doRecall && promptMessage) {
        const results = await recallMemory(promptText, {
          collection,
          nResults: resolved.recallResults,
        }).catch(() => []);
        signal.throwIfAborted();
        if (results.length) {
          lines.push('', '## Recalled memories (for the current prompt)');
          for (const r of results) {
            const sal = r.metadata.salience?.toFixed(2) ?? '?';
            const snippet = r.content.length > 240 ? `${r.content.slice(0, 240)}…` : r.content;
            lines.push(`- **${r.id}** (salience ${sal}, distance ${r.distance.toFixed(3)}): ${snippet}`);
          }
        }
        state.recalledMessageId = promptMessage.id;
      }

      if (doTasks) {
        const tasks = await listTasks({ collection, includeComplete: false }).catch(() => []);
        signal.throwIfAborted();
        if (tasks.length) {
          lines.push('', '## Open tasks');
          for (const t of tasks.slice(0, 10)) {
            const status = t.metadata.status ?? 'open';
            const prio = t.metadata.priority ? `, ${t.metadata.priority}` : '';
            lines.push(`- **${t.id}** [${status}${prio}] ${t.title}`);
          }
          if (tasks.length > 10) lines.push(`- _…${tasks.length - 10} more (call \`yapa_task_list\`)_`);
        }
        state.tasksSurfaced.add(collection);

        // Surface memory-compaction candidates once per session alongside the
        // task check (long-term store maintenance — not context compaction).
        const threshold = getConfig().COMPACTION_THRESHOLD;
        const candidates: string[] = [];
        for (const c of await listCollections().catch(() => [])) {
          const size = await collectionSize(c.name).catch(() => 0);
          if (size >= threshold) candidates.push(`${c.name} (${size})`);
        }
        if (candidates.length) {
          lines.push('', '## Memory compaction candidates (long-term store, not context window)');
          for (const c of candidates) lines.push(`- ${c}`);
        }
      }

      let text = lines.join('\n');
      if (text.length > resolved.maxContextBytes) {
        text = `${text.slice(0, resolved.maxContextBytes)}\n\n_(truncated)_`;
      }

      const injected = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'yapa', form: 'recall' },
      });
      // Splice immediately after the last claimed message (the pattern used by
      // dsh-agent-instructions), so the context lands right behind the prompt
      // it describes. (Manual index/copy: engines >=18 lack toSpliced.)
      let lastClaimed = -1;
      for (let i = decision.messages.length - 1; i >= 0; i--) {
        if (messages.includes(decision.messages[i])) { lastClaimed = i; break; }
      }
      const nextMessages = [
        ...decision.messages.slice(0, lastClaimed + 1),
        injected,
        ...decision.messages.slice(lastClaimed + 1),
      ];
      return { kind: 'enter', messages: nextMessages };
    } catch {
      // Fail open: injection must never block or break a step.
      return decision;
    }
  });
}
