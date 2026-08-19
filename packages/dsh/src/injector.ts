/**
 * Always-on context injection: replaces the MCP install's Claude-Code hook
 * CLI (`session-start`, `user-prompt-submit`) with in-process listeners.
 *
 * - `session/event` tracks the latest direct human prompt per session.
 * - `system-prompt/assemble` (async waterfall, runs before every model step)
 *   injects recalled memories for new prompts and open tasks once per scope
 *   per session into `assembly.contexts`.
 *
 * Every store call is fail-open: a ChromaDB outage degrades to no injected
 * context, never a blocked request.
 *
 * @module @yapa/dsh-plugin/injector
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import {
  recallMemory,
  listTasks,
  listCollections,
  collectionSize,
  getConfig,
} from '@yapa/core';
import type { ResolvedConfig } from './config.js';

interface SessionState {
  cwd?: string;
  /** Latest direct human prompt text observed on this session. */
  lastPrompt?: string;
  /** The prompt text the last recall injection ran for (dedupe mid-turn steps). */
  recalledFor?: string;
  /** Collections whose open tasks were already surfaced this session. */
  tasksSurfaced: Set<string>;
  /** Cache of the detected collection for this session. */
  collection?: string;
}

/** Extract text from a user/message event's content blocks. */
function messageText(event: SessionEvent<'user/message'>): string {
  return event.data.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
    .map(b => b.text)
    .join('\n');
}

/**
 * Infer the active collection from the session cwd, mirroring the hook CLI's
 * rule: first path segment under a configured project root, preferring an
 * existing `customer-`/`project-` collection, else `global`.
 */
async function detectCollection(cwd: string | undefined, roots: string[]): Promise<string> {
  if (!cwd) return 'global';
  for (const root of roots) {
    if (!cwd.startsWith(root)) continue;
    const relative = cwd.slice(root.length).replace(/^\/+/, '');
    const segment = relative.split('/')[0];
    if (!segment || segment.startsWith('.')) return 'global';
    const existing = (await listCollections().catch(() => [])).map(c => c.name);
    if (existing.includes(`customer-${segment}`)) return `customer-${segment}`;
    if (existing.includes(`project-${segment}`)) return `project-${segment}`;
    return `customer-${segment}`;
  }
  return 'global';
}

/**
 * Register session tracking and the assemble-waterfall injector.
 * @returns state cleanup is effect-scoped to the registering context.
 */
export function registerInjector(ctx: Context, getResolved: () => ResolvedConfig): void {
  const sessions = new Map<SessionId, SessionState>();

  const track = (session: Session) => {
    if (!sessions.has(session.id)) {
      sessions.set(session.id, { cwd: session.header.cwd, tasksSurfaced: new Set() });
    }
  };

  ctx.on('session/created', track);
  for (const session of ctx.sessions.list()) track(session);

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return;
    const source = event.data.source as { kind?: string };
    if (source?.kind !== 'user') return; // direct human prompts only
    const st = sessions.get(session.id);
    if (!st) return;
    st.lastPrompt = messageText(event as SessionEvent<'user/message'>).trim() || undefined;
  });

  ctx.on('session/disposed', session => {
    sessions.delete(session.id);
  });

  ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, asctx: AssembleContext, next) => {
    try {
      const resolved = getResolved();
      // The loop passes the full agent (assembleContextFor); the declared type
      // exposes only scope+signal, so read it defensively.
      const agent = (asctx as AssembleContext & { agent?: Agent }).agent;
      if (!agent) return next();
      const st = sessions.get(agent.id);
      if (!st) return next();

      const collection = st.collection
        ?? (st.collection = await detectCollection(st.cwd, resolved.projectRoots));

      const lines: string[] = [];
      const newPrompt = resolved.injectRecall && st.lastPrompt && st.lastPrompt !== st.recalledFor;
      const needTasks = resolved.injectTasks && !st.tasksSurfaced.has(collection);

      if (newPrompt || needTasks) {
        lines.push('# YAPA Context', '', `**Scope:** \`${collection}\``);
      }

      if (newPrompt && st.lastPrompt) {
        const results = await recallMemory(st.lastPrompt, {
          collection,
          nResults: resolved.recallResults,
        }).catch(() => []);
        if (results.length) {
          lines.push('', '## Recalled memories (for the current prompt)');
          for (const r of results) {
            const sal = r.metadata.salience?.toFixed(2) ?? '?';
            const snippet = r.content.length > 240 ? `${r.content.slice(0, 240)}…` : r.content;
            lines.push(`- **${r.id}** (salience ${sal}, distance ${r.distance.toFixed(3)}): ${snippet}`);
          }
        }
        st.recalledFor = st.lastPrompt;
      }

      if (needTasks) {
        const tasks = await listTasks({ collection, includeComplete: false }).catch(() => []);
        if (tasks.length) {
          lines.push('', '## Open tasks');
          for (const t of tasks.slice(0, 10)) {
            const status = t.metadata.status ?? 'open';
            const prio = t.metadata.priority ? `, ${t.metadata.priority}` : '';
            lines.push(`- **${t.id}** [${status}${prio}] ${t.title}`);
          }
          if (tasks.length > 10) lines.push(`- _…${tasks.length - 10} more (call \`yapa_task_list\`)_`);
        }
        st.tasksSurfaced.add(collection);

        // Surface compaction candidates once per session alongside the task check.
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

      if (lines.length) {
        let text = lines.join('\n');
        if (text.length > resolved.maxContextBytes) {
          text = `${text.slice(0, resolved.maxContextBytes)}\n\n_(truncated)_`;
        }
        // Replace, never stack: one yapa context per assembly.
        assembly.contexts = assembly.contexts.filter(c => c.name !== 'yapa');
        assembly.contexts.push({ name: 'yapa', text });
      }
    } catch {
      // Fail open: injection must never block prompt assembly.
    }
    return next();
  });
}
