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
// Loads the compaction event vocabulary into the session event map.
import type {} from '@deepseek-ai/dsh-compaction';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  recallMemory,
  listTasks,
  listCollections,
  collectionSize,
  getConfig,
  claimNote,
  claimSession,
  claimsFor,
  heartbeatIfDue,
  takeClaimNotices,
  waitingOn,
  captureDownLine,
  staleFindings,
  waitingLine,
  includesUser,
  fenceWaiting,
  shownKey,
  shownEarlierLine,
  type RecallResult,
} from '@yapa/core';
import type { ResolvedConfig } from './config.js';
import { takeCaptureNotice } from './response-capture.js';
import { detectCollection, isDetectionStale, scopeFileVersion, scopeNotes, type CollectionDetection } from './scope.js';

interface AgentState {
  /** Cache of the detected collection for this agent's session. */
  detection?: CollectionDetection;
  /** The scope file version `detection` was made with. */
  scopeVersion?: string;
  /** Recall hits already put in this session's context (core shownKey), until a compaction drops them. */
  recalled?: Set<string>;
  /** ID of the human message the last recall injection ran for. */
  recalledMessageId?: string;
  /** Collections whose open tasks were already surfaced this session. */
  tasksSurfaced: Set<string>;
  /** "Waiting on you" is shown once per session. */
  waitingSurfaced?: boolean;
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

  // A compaction summarizes or prunes earlier recall away: show those hits in full again.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') states.get(session.id)?.recalled?.clear();
  });

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;

    // Keep this process's task claims alive while the agent is working (no
    // network unless it holds leases and one is due). Never awaited.
    heartbeatIfDue([claimSession()]).catch(() => undefined);

    try {
      const resolved = getResolved();
      const state = states.get(agent.id) ?? { tasksSurfaced: new Set<string>() };
      states.set(agent.id, state);

      // Cached per session, but a merge since (here or in another process)
      // moves the folder's scope: re-detect when the redirects changed.
      // A folder-rules change (yapa_scope, yapa scope) moves it too.
      const version = scopeFileVersion();
      if (state.detection && (state.scopeVersion !== version || await isDetectionStale(state.detection))) state.detection = undefined;
      state.scopeVersion = version;
      const detection = state.detection
        ?? (state.detection = await detectCollection(agent.session.header.cwd));
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
      const claimNotices = takeClaimNotices();

      if (!doRecall && !doTasks && !captureNotice && !claimNotices.length) return decision;
      const lines: string[] = ['# YAPA Context', ''];
      if (detection.ambiguous) {
        lines.push(
          `**Scope:** AMBIGUOUS — both \`${detection.ambiguous[0]}\` and \`${detection.ambiguous[1]}\` exist for this folder. `
          + 'Ask the user which collection to use BEFORE storing anything, then pass that collection explicitly on all yapa_* calls for the rest of this session.',
          `_(Recalls/tasks below default to \`${collection}\` until the user answers.)_`,
        );
      } else {
        lines.push(`**Scope:** \`${collection}\`${scopeNotes(detection)}`);
      }

      if (captureNotice) lines.push('', `## Auto-capture\n${captureNotice}`);
      for (const n of claimNotices) lines.push('', `**YAPA claim:** ${n}`);

      let fresh: RecallResult[] = [];
      if (doRecall && promptMessage) {
        const results = await recallMemory(promptText, {
          collection,
          nResults: resolved.recallResults,
          crossCollection: resolved.core.CROSS_COLLECTION_RESULTS,
        }).catch(() => []);
        signal.throwIfAborted();
        const recalled = (state.recalled ??= new Set<string>());
        fresh = results.filter(r => !recalled.has(shownKey(r)));
        const repeats = results.filter(r => recalled.has(shownKey(r)));
        if (fresh.length) {
          lines.push('', '## Recalled memories (for the current prompt)');
          for (const r of fresh) {
            const sal = r.metadata.salience?.toFixed(2) ?? '?';
            const snippet = r.content.length > 240 ? `${r.content.slice(0, 240)}…` : r.content;
            const where = r.collection && r.collection !== collection ? `, from \`${r.collection}\`` : '';
            lines.push(`- **${r.id}** (salience ${sal}, distance ${r.distance.toFixed(3)}${where}): ${snippet}`);
          }
        }
        if (repeats.length) lines.push('', shownEarlierLine(repeats, collection));
        state.recalledMessageId = promptMessage.id;
      }

      if (doTasks) {
        const tasks = await listTasks({ collection, includeComplete: false }).catch(() => []);
        signal.throwIfAborted();
        if (tasks.length) {
          const claims = await claimsFor(collection);
          signal.throwIfAborted();
          lines.push('', '## Open tasks');
          for (const t of tasks.slice(0, 10)) {
            const status = t.metadata.status ?? 'open';
            const prio = t.metadata.priority ? `, ${t.metadata.priority}` : '';
            const claim = claimNote(t, claims, [claimSession()]);
            lines.push(`- **${t.id}** [${status}${prio}${claim ? `; ${claim}` : ''}] ${t.title}`);
          }
          if (tasks.length > 10) lines.push(`- _…${tasks.length - 10} more (call \`yapa_task_list\`)_`);
        }
        state.tasksSurfaced.add(collection);

        if (!state.waitingSurfaced) {
          state.waitingSurfaced = true;
          const me = getConfig().USERNAME;
          const all = await waitingOn({ user: me }).catch(() => undefined);
          signal.throwIfAborted();
          if (all) {
            // In a shared scope, private-*/local-* items are only counted.
            const { waiting: w, hidden } = fenceWaiting(all, collection);
            const items = [...w.decisions, ...w.questions, ...w.actions, ...w.blocked];
            const mine = items.filter(i => includesUser(i.for, me));
            const anyone = items.filter(i => i.for.length === 0).length;
            if (mine.length || anyone || hidden) {
              lines.push('', '## Waiting on you');
              for (const i of mine.slice(0, 8)) lines.push(waitingLine(i, { collection: true }));
              if (mine.length > 8) lines.push(`- _…${mine.length - 8} more (call \`yapa_waiting\`)_`);
              if (anyone) lines.push(`- _${anyone} item(s) wait on anyone with the role (call \`yapa_waiting\`)_`);
              if (hidden) lines.push(`- _${hidden} more in private collections, not listed in this shared scope (call \`yapa_waiting\` to see them)_`);
            }
          }
        }

        const captureDown = captureDownLine();
        if (captureDown) lines.push('', captureDown);

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
        const stale = (await staleFindings(collection).catch(() => [])).length;
        if (stale >= getConfig().FINDINGS_CLEANUP_THRESHOLD) {
          lines.push('', '## Findings backlog', `${stale} of your open findings in ${collection} have had no disposition for over two days: give each one a disposition with \`yapa_memory_update\` (\`yapa memory sweep-findings --collection ${collection}\` lists the ones that are only progress notes).`);
        }
      }

      let text = lines.join('\n');
      if (text.length > resolved.maxContextBytes) {
        text = `${text.slice(0, resolved.maxContextBytes)}\n\n_(truncated)_`;
      }
      // Only hits that made it into the message count as shown.
      for (const r of fresh) if (text.includes(`**${r.id}**`)) state.recalled?.add(shownKey(r));

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
