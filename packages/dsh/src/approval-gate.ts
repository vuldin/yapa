/**
 * Approval gate for destructive/costly yapa tools.
 *
 * A `tools/pre-execute` listener returns `ask` for gated tools **only when the
 * session is in `ask` policy** — under `never` (the danger-full-access preset)
 * the user has opted out of prompts, and the call proceeds. This layers on the
 * harness approval service (GUI prompt + audit events) instead of yapa's
 * `confirm: true` params, which remain as a second gate where money is spent.
 *
 * Disable with `approvalGate: false` in the plugin config / settings.
 *
 * @module yapa/approval-gate
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import type { ResolvedConfig } from './config.js';

/** Irreversible or money-spending tools gated behind approval. */
const GATED = new Set([
  'yapa_memory_forget',
  'yapa_task_delete',
  'yapa_collection_delete',
  'yapa_storage_import',
  'yapa_training_trigger',
  'yapa_training_cancel',
  'yapa_adapter_promote',
  'yapa_adapter_demote',
  'yapa_system_prompt_activate',
  'yapa_system_prompt_deactivate',
]);

/** Resolve the effective approval policy for the calling agent's session. */
function effectivePolicy(exec: { agent?: { session: { events: readonly any[] } } }): 'ask' | 'never' {
  const override = exec.agent
    ? effectiveApprovalPolicy(exec.agent.session.events as never)
    : undefined;
  // No session override → deployment default, derived from DSH_PERMISSION_MODE
  // exactly like the base profile's approval row.
  return override
    ?? (process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask');
}

export function registerApprovalGate(ctx: Context, getResolved: () => ResolvedConfig): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!getResolved().approvalGate) return next();
    if (!GATED.has(exec.name)) return next();
    if (effectivePolicy(exec as never) !== 'ask') return next();
    return {
      kind: 'ask',
      reason: `YAPA: "${exec.name}" is destructive or incurs external cost.`,
    };
  });
}
