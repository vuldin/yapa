import { describe, it, expect } from 'vitest';
import { registerApprovalGate } from './approval-gate.js';
import type { ResolvedConfig } from './config.js';
import { PLUGIN_DEFAULTS } from './config.js';

function setup(policy: 'ask' | 'never', gate = true) {
  let listener: any;
  const ctx = { on: (name: string, fn: any) => { if (name === 'tools/pre-execute') listener = fn; } };
  const resolved = { ...PLUGIN_DEFAULTS, approvalGate: gate } as unknown as ResolvedConfig;
  registerApprovalGate(ctx as any, () => resolved);

  const next = async () => ({ kind: 'allow' as const });
  const execFor = (toolName: string) => ({
    name: toolName,
    agent: {
      session: {
        events: [{ type: 'approval/policy', data: { policy } }] as any[],
      },
    },
  });
  return { listener: listener!, next, execFor };
}

describe('approval gate', () => {
  it('asks for gated tools under ask policy', async () => {
    const { listener, next, execFor } = setup('ask');
    const decision = await listener(execFor('yapa_collection_delete'), next);
    expect(decision.kind).toBe('ask');
    expect(decision.reason).toContain('yapa_collection_delete');
  });

  it('passes ungated tools through', async () => {
    const { listener, next, execFor } = setup('ask');
    expect((await listener(execFor('yapa_memory_store'), next)).kind).toBe('allow');
    expect((await listener(execFor('yapa_task_list'), next)).kind).toBe('allow');
  });

  it('never prompts under never policy (user opted out)', async () => {
    const { listener, next, execFor } = setup('never');
    expect((await listener(execFor('yapa_training_trigger'), next)).kind).toBe('allow');
  });

  it('is disabled by approvalGate: false', async () => {
    const { listener, next, execFor } = setup('ask', false);
    expect((await listener(execFor('yapa_collection_delete'), next)).kind).toBe('allow');
  });

  it('agent-less executions follow the deployment default (ask unless danger-full-access)', async () => {
    const { listener, next } = setup('ask');
    const exec = { name: 'yapa_memory_forget' };
    const saved = process.env.DSH_PERMISSION_MODE;
    delete process.env.DSH_PERMISSION_MODE;
    expect((await listener(exec, next)).kind).toBe('ask');
    process.env.DSH_PERMISSION_MODE = 'danger-full-access';
    expect((await listener(exec, next)).kind).toBe('allow');
    if (saved === undefined) delete process.env.DSH_PERMISSION_MODE;
    else process.env.DSH_PERMISSION_MODE = saved;
  });
});
