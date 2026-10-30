import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pullCollection, captureTurn, heartbeatIfDue } = vi.hoisted(() => ({
  pullCollection: vi.fn(),
  captureTurn: vi.fn(),
  heartbeatIfDue: vi.fn(),
}));
vi.mock('@yapa/core', async importOriginal => ({ ...(await importOriginal<any>()), pullCollection, captureTurn, heartbeatIfDue }));

import { setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, storeMemory, listMemories } from '@yapa/core';
import { userPromptSubmit, userText, sessionStart, stop, postCompact, sessionEnd, freshenFromRemote, attribution, presenceLines } from './hooks.js';

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
  pullCollection.mockResolvedValue({ pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, errors: 0 });
  captureTurn.mockReset();
  heartbeatIfDue.mockReset();
  heartbeatIfDue.mockResolvedValue(0);
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

  it('never contacts the remote for local-only collections (global, private-*, local-*)', async () => {
    for (const c of ['global', 'private-notes', 'local-x']) expect(await freshenFromRemote(c)).toBe(0);
    expect(pullCollection).not.toHaveBeenCalled();
  });

  it('first visit backfills the whole collection, then follows it; later visits pull recent changes', async () => {
    const core = await import('@yapa/core');
    await core.updateSyncSubscriptions([]);
    await freshenFromRemote('project-newteam');
    expect(pullCollection.mock.calls.at(-1)?.slice(0, 2)).toEqual(['project-newteam', 0]);
    expect(await core.getSyncSubscriptions()).toContain('project-newteam');
    await core.updateSyncPullTimestamp(1_800_000_000);
    await freshenFromRemote('project-newteam');
    expect(pullCollection.mock.calls.at(-1)?.[1]).toBeGreaterThan(0);
  });

  it('a first-visit backfill that times out does not subscribe (retries next prompt)', async () => {
    const core = await import('@yapa/core');
    await core.updateSyncSubscriptions([]);
    pullCollection.mockImplementationOnce(() => new Promise(() => {}));
    await freshenFromRemote('project-slow');
    expect(await core.getSyncSubscriptions()).not.toContain('project-slow');
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

describe('background-task notifications', () => {
  const block = (id: string) => [
    '<task-notification>',
    `<task-id>${id}</task-id>`,
    '<tool-use-id>toolu_01abc</tool-use-id>',
    `<output-file>/tmp/tasks/${id}.output</output-file>`,
    '<status>completed</status>',
    '<summary>Background command "acme prod maintenance build" completed (exit code 0)</summary>',
    '</task-notification>',
  ].join('\n');
  const preamble = [
    '[SYSTEM NOTIFICATION - NOT USER INPUT]',
    'This is an automated background-task event, NOT a message from the user.',
    'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.',
    '',
  ].join('\n');
  const cwd = () => join(dir, 'proj', 'acme');

  it('finds the user text, if any', () => {
    expect(userText(block('b1'))).toBe('');
    expect(userText(`${block('b1')}\n${block('b2')}`)).toBe('');
    expect(userText(`<system-reminder>\n${preamble}\n${block('b1')}\n</system-reminder>`)).toBe('');
    expect(userText(`${block('b1')}\nwhen is acme prod maintenance?`)).toBe('when is acme prod maintenance?');
    expect(userText('a plain prompt')).toBe('a plain prompt');
  });

  it('a notification-only prompt gets no recall and is not recorded, but leases are renewed', async () => {
    configure({ YAPA_RESPONSE_CAPTURE: 'true', YAPA_ANTHROPIC_API_KEY: 'k' });
    capture();
    await userPromptSubmit({ session_id: 'n1', cwd: cwd(), prompt: 'when is acme prod maintenance?' });
    restore();

    capture();
    await userPromptSubmit({ session_id: 'n1', cwd: cwd(), prompt: block('b1') });
    expect(restore()).toEqual({});
    expect(heartbeatIfDue).toHaveBeenCalledTimes(2);
    expect(pullCollection).toHaveBeenCalledOnce(); // only for the real prompt

    // The Stop hook still judges the user's turn, not the notification.
    captureTurn.mockResolvedValueOnce({ stored: 0, skipped: 0, superseded: 0 });
    await stop({ session_id: 'n1', cwd: cwd(), last_assistant_message: 'Thursdays 02:00 UTC. '.repeat(20) });
    expect(captureTurn.mock.calls[0][0]).toMatchObject({ turn: 1, userText: 'when is acme prod maintenance?' });
  });

  it('a mixed prompt gets recall on the user text only', async () => {
    capture();
    await userPromptSubmit({ session_id: 'n2', cwd: cwd(), prompt: `${preamble}\n${block('b3')}\nwhen is acme prod maintenance?` });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('**Query:** when is acme prod maintenance?');
    expect(ctx).not.toContain('task-notification');
    expect(ctx).toMatch(/Thursdays 02:00 UTC/);
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

describe('lease presence at session start', () => {
  const lease = (key: string, user: string, session: string, extra: Record<string, unknown> = {}) => ({
    collection: 'project-acme', key, holder: { user, session, device: null }, title: null, scope: [`key:${key}`],
    ttl_seconds: 7200, acquired_at: 1000, heartbeat_at: 1000, expires_at: 8200, expired: false, took_over_from: null, ...extra,
  });

  it('shows nothing when nobody holds anything', () => {
    expect(presenceLines([], 2000, ['s1'], 'josh')).toEqual([]);
  });

  it("names teammates, this session and the user's other sessions", () => {
    const out = presenceLines([
      lease('josh-7', 'josh', 's1', { title: 'upgrade runbook' }),
      lease('josh-8', 'josh', 'other-session-id'),
      lease('dana-3', 'dana', 'd1'),
    ], 2800, ['s1', undefined], 'josh');
    expect(out[1]).toBe('## Work in progress (leases)');
    expect(out[2]).toBe('- **josh-7** upgrade runbook: you (this session), for 30m, expires in 90m');
    expect(out[3]).toBe('- **josh-8**: you (another session, other-se), for 30m, expires in 90m');
    expect(out[4]).toBe('- **dana-3**: dana, for 30m, expires in 90m');
  });
});
