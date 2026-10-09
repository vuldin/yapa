import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pullCollection, captureTurn } = vi.hoisted(() => ({
  pullCollection: vi.fn(),
  captureTurn: vi.fn(),
}));
vi.mock('@yapa/core', async importOriginal => ({ ...(await importOriginal<any>()), pullCollection, captureTurn }));

import { setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, storeMemory, listMemories } from '@yapa/core';
import { userPromptSubmit, sessionStart, stop, postCompact, sessionEnd, freshenFromRemote, attribution } from './hooks.js';

let dir: string;
let out = '';
const write = process.stdout.write.bind(process.stdout);
function capture() {
  out = '';
  (process.stdout as any).write = (chunk: any) => { out += String(chunk); return true; };
}
function restore(): any {
  (process.stdout as any).write = write;
  return out ? JSON.parse(out) : {};
}

function configure(env: Record<string, string> = {}) {
  setConfig(createConfig({
    YAPA_USERNAME: 'josh', YAPA_DEVICE_ID: 'dev-A', YAPA_PROJECT_ROOTS: join(dir, 'proj'),
    YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: 'postgres://x', YAPA_HOOK_PULL_TIMEOUT_MS: '200',
    ...env,
  }));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-hooks-test-'));
  process.env.CLAUDE_PLUGIN_DATA = join(dir, 'plugin-data');
  setStore(createLocalStore(join(dir, 'store')));
  configure();
  await storeMemory('acme staging uses SASL/SCRAM-512 on port 9094', { collection: 'project-acme', salience: 3 });
  await storeMemory('acme prod maintenance moved to Thursdays 02:00 UTC', {
    collection: 'project-acme', salience: 3, metadata: { origin_user: 'teammate' },
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
  resetStore();
  resetConfig();
});

beforeEach(() => {
  configure();
  pullCollection.mockReset();
  pullCollection.mockResolvedValue({ pulled: 0, updated: 0, linked: 0, skipped: 0, errors: 0 });
  captureTurn.mockReset();
});

describe('freshenFromRemote', () => {
  it('pulls the active collection before recall when sync is on', async () => {
    pullCollection.mockResolvedValueOnce({ pulled: 2, updated: 1, linked: 0, skipped: 0, errors: 0 });
    expect(await freshenFromRemote('project-acme')).toBe(3);
    expect(pullCollection.mock.calls[0][0]).toBe('project-acme');
  });

  it('is bounded: a hung remote costs only the timeout', async () => {
    pullCollection.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = Date.now();
    expect(await freshenFromRemote('project-acme')).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('is a no-op with sync disabled', async () => {
    configure({ YAPA_SYNC_ENABLED: 'false' });
    expect(await freshenFromRemote('project-acme')).toBe(0);
    expect(pullCollection).not.toHaveBeenCalled();
  });
});

describe('userPromptSubmit', () => {
  it('injects scoped recall with teammate attribution', async () => {
    capture();
    await userPromptSubmit({ session_id: 's1', cwd: join(dir, 'proj', 'acme', 'src'), prompt: 'when is acme prod maintenance?' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('**Scope:** `project-acme`');
    expect(ctx).toMatch(/Thursdays 02:00 UTC/);
    expect(ctx).toMatch(/by teammate\): acme prod maintenance/);
    expect(pullCollection).toHaveBeenCalledOnce();
  });

  it('adds strongly relevant hits from other customers, labeled with their collection', async () => {
    await storeMemory('acme prod maintenance window also applies to the globex prod cluster: Thursdays 02:00 UTC', { collection: 'customer-globex', salience: 2 });
    capture();
    await userPromptSubmit({ session_id: 's1', cwd: join(dir, 'proj', 'acme'), prompt: 'when is acme prod maintenance?' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/from `customer-globex`\): acme prod maintenance window also applies/);
  });

  it('emits nothing for an empty prompt', async () => {
    capture();
    await userPromptSubmit({ session_id: 's1', cwd: dir, prompt: '  ' });
    expect(restore()).toEqual({});
  });
});

describe('sessionStart', () => {
  it('injects the standing rules only when asked to (plugin installs)', async () => {
    capture();
    await sessionStart({ session_id: 's1', cwd: join(dir, 'proj', 'acme'), source: 'startup' });
    expect(restore().hookSpecificOutput.additionalContext).not.toContain('standing rules');

    configure({ YAPA_HOOK_INJECT_RULES: 'true' });
    capture();
    await sessionStart({ session_id: 's1', cwd: join(dir, 'proj', 'acme'), source: 'compact' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('standing rules');
    expect(ctx).toContain('# YAPA Context');
  });
});

describe('stop (response capture)', () => {
  const longAnswer = 'Root cause: the NLB idle timeout (350s) is shorter than connections.max.idle.ms (540s). '.repeat(4);

  it('captures the buffered prompt + last assistant message and surfaces a notice next prompt', async () => {
    configure({ YAPA_RESPONSE_CAPTURE: 'true', YAPA_ANTHROPIC_API_KEY: 'k' });
    captureTurn.mockResolvedValueOnce({ stored: 1, skipped: 0, superseded: 0, notice: 'Auto-captured 1 memory from last turn' });
    const cwd = join(dir, 'proj', 'acme');

    capture();
    await userPromptSubmit({ session_id: 's2', cwd, prompt: 'why do acme consumers time out?' });
    restore();
    capture();
    await stop({ session_id: 's2', cwd, last_assistant_message: longAnswer });
    expect(restore()).toEqual({});

    const [input] = captureTurn.mock.calls[0];
    expect(input).toMatchObject({ collection: 'project-acme', sessionId: 's2', turn: 1, userText: 'why do acme consumers time out?', assistantText: longAnswer.trim() });

    capture();
    await userPromptSubmit({ session_id: 's2', cwd, prompt: 'and the fix?' });
    expect(restore().hookSpecificOutput.additionalContext).toContain('_Auto-captured 1 memory from last turn_');
  });

  it('skips when disabled, re-entrant, or the turn is trivial', async () => {
    await stop({ session_id: 's3', last_assistant_message: longAnswer });
    configure({ YAPA_RESPONSE_CAPTURE: 'true' });
    await stop({ session_id: 's3', stop_hook_active: true, last_assistant_message: longAnswer });
    await stop({ session_id: 's3', last_assistant_message: 'ok' });
    expect(captureTurn).not.toHaveBeenCalled();
  });
});

describe('postCompact / sessionEnd', () => {
  it('stores the compaction summary as an episodic memory in scope', async () => {
    await postCompact({ session_id: 's4', cwd: join(dir, 'proj', 'acme'), compact_summary: 'Decided: acme moves to mTLS in Q1.', trigger: 'auto' });
    const all = await listMemories({ collection: 'project-acme', limit: 50 });
    const summary = all.find(m => m.content.includes('mTLS in Q1'));
    expect(summary?.metadata.sector).toBe('episodic');
    expect(String(summary?.metadata.tags)).toContain('compaction');
  });

  it('removes the session\'s hook state on session end', async () => {
    const sessions = join(dir, 'plugin-data', 'sessions');
    expect(readdirSync(sessions).some(f => f.startsWith('s2.'))).toBe(true);
    await sessionEnd({ session_id: 's2' });
    expect(existsSync(join(sessions, 's2.turn'))).toBe(false);
  });
});

describe('attribution', () => {
  it('labels only other users', () => {
    expect(attribution({ origin_user: 'teammate' })).toBe(', by teammate');
    expect(attribution({ origin_user: 'josh' })).toBe('');
    expect(attribution({})).toBe('');
  });
});
