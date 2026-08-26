/**
 * Due-task → schedule bridging: yapa tasks are durable but passive; DSH
 * schedule entries actively wake the session. When a task with a due date is
 * created (or its due date updated) from a live agent, register a
 * `schedule_create` reminder so the task pings the session when due.
 *
 * Implemented as a `tools/post-execute` observer so it can't change tool
 * outcomes; failures (schedule plugin absent, non-root agent) are silent.
 *
 * @module yapa/schedule-bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CallId } from '@deepseek-ai/dsh-llm';
import { parseRelativeDate } from '@yapa/core';
import type { ResolvedConfig } from './config.js';

/** Mint a call id for a plugin-initiated tool dispatch. */
function mintCallId(): CallId {
  return `yapa-bridge-${crypto.randomUUID()}` as unknown as CallId;
}

export function registerScheduleBridge(ctx: Context, getResolved: () => ResolvedConfig): void {
  // `tools/result` is emit-mode: listeners return nothing. Fire-and-forget.
  ctx.on('tools/result', (exec, result) => {
    void (async () => {
      try {
        if (!getResolved().scheduleBridge) return;
        if (result.isError) return;
        const agent = exec.agent;
        if (!agent) return;

        // Only due-dated task mutations bridge.
        let taskId: string | undefined;
        let dueSeconds: number | undefined;
        let title: string | undefined;
        if (exec.name === 'yapa_task_create') {
          const value = (result as { value?: { id?: string; title?: string; due_date?: number } }).value;
          taskId = value?.id;
          title = value?.title;
          dueSeconds = value?.due_date;
        } else if (exec.name === 'yapa_task_update') {
          const args = exec.arguments as { id?: string; due?: string };
          taskId = args.id;
          if (args.due) dueSeconds = parseRelativeDate(args.due) ?? undefined;
        }
        if (!taskId || !dueSeconds) return;
        if (dueSeconds * 1000 <= Date.now()) return; // already past — nothing to wake for

        // Schedule tools mount per root-agent scope; absent plugin → skip.
        if (!ctx.tools.get('schedule_create', agent)) return;

        await ctx.tools.execute({
          callId: mintCallId(),
          name: 'schedule_create',
          arguments: {
            prompt: `YAPA task ${taskId} is due${title ? `: ${title}` : ''}. Check it with yapa_task_list({ id }) and nudge or act as appropriate.`,
            at: new Date(dueSeconds * 1000).toISOString(),
          },
          agent,
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Bridging is best-effort; never disturb the owning tool call.
      }
    })();
  });
}
