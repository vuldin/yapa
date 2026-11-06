import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pullCollection, captureTurn, heartbeatIfDue } = vi.hoisted(() => ({
  pullCollection: vi.fn(),
  captureTurn: vi.fn(),
  heartbeatIfDue: vi.fn(),
}));
vi.mock('@yapa/core', async importOriginal => ({ ...(await importOriginal<any>()), pullCollection, captureTurn, heartbeatIfDue }));

import { setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, storeMemory, listMemories } from '@yapa/core';
import { userPromptSubmit, userText, sessionStart, stop, postCompact, sessionEnd, freshenFromRemote, attribution, presenceLines, syncDownLine, prepareStatusLine, waitingLines } from './hooks.js';

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

  it('the prompt path skips a collection any session pulled moments ago; session start and backfills never skip', async () => {
    const core = await import('@yapa/core');
    configure({ YAPA_SYNC_HEALTH_FILE: join(dir, 'gate', 'sync-health.json') });
    await core.updateSyncSubscriptions(['project-acme']);
    await freshenFromRemote('project-acme', { gate: true });
    expect(pullCollection).toHaveBeenCalledTimes(1);
    await freshenFromRemote('project-acme', { gate: true }); // another prompt, any session
    expect(pullCollection).toHaveBeenCalledTimes(1);
    await freshenFromRemote('project-acme'); // session start
    expect(pullCollection).toHaveBeenCalledTimes(2);
    await core.updateSyncSubscriptions([]);
    await freshenFromRemote('project-acme', { gate: true }); // first visit: backfill
    expect(pullCollection.mock.calls.at(-1)?.slice(0, 2)).toEqual(['project-acme', 0]);
    // Outside the window it pulls again.
    configure({ YAPA_SYNC_HEALTH_FILE: join(dir, 'gate', 'sync-health.json'), YAPA_HOOK_PULL_WINDOW_MS: '0' });
    const before = pullCollection.mock.calls.length;
    await freshenFromRemote('project-acme', { gate: true });
    expect(pullCollection.mock.calls.length).toBe(before + 1);
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

  it('leaves compaction summaries of past sessions out of prompt recall', async () => {
    await storeMemory('# Conversation compaction summary\n\nWe looked at when gamma prod maintenance happens and moved the gamma window.', {
      collection: 'project-gamma', tags: ['compaction', 'journal'], metadata: { source: 'compaction' },
    });
    await storeMemory('gamma prod maintenance is Tuesdays 04:00 UTC', { collection: 'project-gamma', salience: 2 });
    capture();
    await userPromptSubmit({ session_id: 's1', cwd: join(dir, 'proj', 'gamma'), prompt: 'when is gamma prod maintenance?' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/Tuesdays 04:00 UTC/);
    expect(ctx).not.toContain('Conversation compaction summary');
    capture();
    await sessionStart({ session_id: 'g1', cwd: join(dir, 'proj', 'gamma'), source: 'startup' });
    const start = restore().hookSpecificOutput.additionalContext as string;
    expect(start).toContain('## Top memories (by salience)');
    expect(start).not.toContain('Conversation compaction summary');
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
    configure({ YAPA_RESPONSE_CAPTURE: 'false' });
    await stop({ session_id: 's3', last_assistant_message: longAnswer });
    configure();
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

  it('records compaction captures in capture health, and session start says when capture is failing', async () => {
    const health = join(dir, 'health-cap', 'sync-health.json');
    configure({ YAPA_SYNC_HEALTH_FILE: health });
    const { readCaptureHealth, recordCapture } = await import('@yapa/core');
    await postCompact({ session_id: 's5', cwd: join(dir, 'proj', 'acme'), compact_summary: 'Decided: acme keeps the old port.', trigger: 'auto' });
    const capFile = join(dir, 'health-cap', 'capture-health.json');
    expect(Object.values(readCaptureHealth(capFile)!.days)[0]).toMatchObject({ compactions: 1, compactions_failed: 0 });

    capture();
    await sessionStart({ session_id: 's6', cwd: join(dir, 'proj', 'acme'), source: 'startup' });
    expect(restore().hookSpecificOutput.additionalContext).not.toContain('YAPA capture is failing');
    recordCapture({ kind: 'turn_failed', error: new Error('claude -p: command not found') }, Date.now(), capFile);
    capture();
    await sessionStart({ session_id: 's7', cwd: join(dir, 'proj', 'acme'), source: 'startup' });
    expect(restore().hookSpecificOutput.additionalContext).toContain('**YAPA capture is failing** (extractor, 1 failed run(s) today): claude -p: command not found. So memories from recent turns may be missing');
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
    expect(out[3]).toBe('- **josh-8**: you (another session, other-session-id), for 30m, expires in 90m');
    expect(out[4]).toBe('- **dana-3**: dana, for 30m, expires in 90m');
  });
});

describe('sync health (status line)', () => {
  let health: string;
  const record = (h: object) => writeFileSync(health, JSON.stringify({ at: Date.now(), interval_ms: 300000, label: 'yapa', ...h }));

  beforeEach(() => {
    const hd = mkdtempSync(join(dir, 'health-'));
    health = join(hd, 'sync-health.json');
    configure({ YAPA_SYNC_HEALTH_FILE: health });
    process.env.CLAUDE_CONFIG_DIR = join(hd, 'claude');
  });

  afterAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('a clean hook pull records sync as ok; a failed one does not', async () => {
    record({ status: 'signed_out', since: 1 });
    pullCollection.mockResolvedValueOnce({ pulled: 0, updated: 0, linked: 0, skipped: 0, errors: 1 });
    await freshenFromRemote('project-acme');
    expect(JSON.parse(readFileSync(health, 'utf-8')).status).toBe('signed_out');
    await freshenFromRemote('project-acme');
    expect(JSON.parse(readFileSync(health, 'utf-8'))).toMatchObject({ status: 'ok' });
  });

  it('tells Claude while sync is down, and says nothing while it is healthy', async () => {
    record({ status: 'ok' });
    expect(syncDownLine()).toBeUndefined();
    record({ status: 'signed_out', since: Date.UTC(2026, 10, 1, 9, 12) });
    expect(syncDownLine()).toBe('_YAPA sync is signed out since 2026-11-01 09:12 UTC: writes stay on this machine until the user runs `gcloud auth login` (sync resumes by itself, no restart)._');
    expect(syncDownLine({ ...JSON.parse(readFileSync(health, 'utf-8')), sign_in: 'sign in to the MCP gateway' })).toContain('until the user signs in again (sign in to the MCP gateway)');
    record({ status: 'unreachable' });
    expect(syncDownLine()).toContain('unreachable');
    configure({ YAPA_SYNC_HEALTH_FILE: health, YAPA_SYNC_ENABLED: 'false' });
    expect(syncDownLine()).toBeUndefined();
  });

  it('the down line reaches the prompt context even with no recall hits', async () => {
    record({ status: 'signed_out', since: 1 });
    // Still signed out: the hook's own pull fails too.
    pullCollection.mockResolvedValue({ pulled: 0, updated: 0, linked: 0, skipped: 0, errors: 1 });
    capture();
    await userPromptSubmit({ session_id: 'h1', cwd: join(dir, 'proj', 'empty-project'), prompt: 'zzqx unrelated words' });
    expect(restore().hookSpecificOutput.additionalContext).toContain('YAPA sync is signed out');
    capture();
    await sessionStart({ session_id: 'h1', cwd: join(dir, 'proj', 'acme'), source: 'startup' });
    expect(restore().hookSpecificOutput.additionalContext).toContain('YAPA sync is signed out');
  });

  it('keeps the stable script copy current and hints at the install once', () => {
    const src = join(dir, 'statusline-src.mjs');
    writeFileSync(src, 'console.log("v1")\n');
    const stable = join(health, '..', 'statusline.mjs');
    const hint = prepareStatusLine(src);
    expect(readFileSync(stable, 'utf-8')).toBe('console.log("v1")\n');
    expect(hint).toContain('--install');
    expect(prepareStatusLine(src)).toBeUndefined();
    writeFileSync(src, 'console.log("v2")\n');
    prepareStatusLine(src);
    expect(readFileSync(stable, 'utf-8')).toBe('console.log("v2")\n');
  });

  it('no hint once the status line is installed, or when sync is off', () => {
    const settings = join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'node "/h/.local/share/yapa/statusline.mjs"' } }));
    expect(prepareStatusLine(undefined)).toBeUndefined();
    rmSync(settings);
    configure({ YAPA_SYNC_HEALTH_FILE: health, YAPA_SYNC_ENABLED: 'false' });
    expect(prepareStatusLine(undefined)).toBeUndefined();
  });

  it('with the statusline option on, adds the status line itself (wrapping one already there), and never re-adds a removed one', async () => {
    const settings = join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    mkdirSync(join(settings, '..'), { recursive: true });
    const theirs = { type: 'command', command: 'echo mine' };
    writeFileSync(settings, JSON.stringify({ theme: 'dark', statusLine: theirs }));
    const src = join(dir, 'statusline-src.mjs');
    writeFileSync(src, 'console.log("v3")\n');
    const stable = join(health, '..', 'statusline.mjs');
    rmSync(join(health, '..', 'statusline-removed'), { force: true });
    rmSync(join(health, '..', 'statusline-added'), { force: true });
    configure({ YAPA_SYNC_HEALTH_FILE: health, YAPA_STATUSLINE: 'true' });

    const line = prepareStatusLine(src, settings);
    expect(line).toContain('added its status line');
    const after = JSON.parse(readFileSync(settings, 'utf-8'));
    expect(after.theme).toBe('dark');
    expect(after.statusLine.command).toContain(stable);
    expect(after.statusLine.command).toContain('--wrap');
    expect(prepareStatusLine(src, settings)).toBeUndefined(); // already there

    // The user removes it by hand: it stays removed.
    writeFileSync(settings, JSON.stringify({ theme: 'dark', statusLine: theirs }));
    expect(prepareStatusLine(src, settings)).toBeUndefined();
    expect(JSON.parse(readFileSync(settings, 'utf-8')).statusLine).toEqual(theirs);

    // Or with --uninstall, even on a device that never auto-added it.
    rmSync(join(health, '..', 'statusline-added'));
    const { setRemovedMarker, installStatusLine: install, uninstallStatusLine } = await import('./statusline.js');
    install(stable, settings);
    uninstallStatusLine(settings, stable);
    setRemovedMarker(join(health, '..'), true);
    expect(prepareStatusLine(src, settings)).toBeUndefined();
    expect(JSON.parse(readFileSync(settings, 'utf-8')).statusLine).toEqual(theirs);
    setRemovedMarker(join(health, '..'), false);
    rmSync(settings);
  });

  it('tells Claude about a newer release once, and the note clears after updating', async () => {
    const { updateLine } = await import('./hooks.js');
    const { YAPA_VERSION } = await import('../version.js');
    const state = join(health, '..', 'update-check.json');
    writeFileSync(state, JSON.stringify({ current: YAPA_VERSION, latest: '99.0.0', checked_at: Date.now() }));
    configure({ YAPA_SYNC_HEALTH_FILE: health });
    expect(updateLine()).toMatch(/^_YAPA 99\.0\.0 is out \(running .+\)\. Tell the user once; to update: `git pull/);
    expect(updateLine()).toBeUndefined();
    writeFileSync(state, JSON.stringify({ current: '0.0.1', latest: YAPA_VERSION, checked_at: Date.now() }));
    expect(updateLine()).toBeUndefined(); // running it now: nothing to say
    expect(JSON.parse(readFileSync(state, 'utf-8'))).toMatchObject({ current: YAPA_VERSION });
    expect(JSON.parse(readFileSync(state, 'utf-8')).latest).toBeUndefined();
    rmSync(state);
  });
});

describe('task claims in hook context', () => {
  it('a claim notice reaches the next prompt once, even with no recall hits', async () => {
    const { addClaimNotice } = await import('@yapa/core');
    configure({ YAPA_LEASE_STATE_DIR: join(dir, 'leases-notice') });
    addClaimNotice('Your claim on josh-9 (project-acme) is no longer held: another session took it over or released it.');
    capture();
    await userPromptSubmit({ session_id: 'h1', cwd: join(dir, 'proj', 'empty-project'), prompt: 'zzqx unrelated words' });
    expect(restore().hookSpecificOutput.additionalContext).toContain('**YAPA claim:** Your claim on josh-9');
    capture();
    await userPromptSubmit({ session_id: 'h1', cwd: join(dir, 'proj', 'empty-project'), prompt: 'zzqx unrelated words' });
    expect(JSON.stringify(restore())).not.toContain('YAPA claim');
  });
});

describe('waiting on you', () => {
  it('session start names a findings backlog over the threshold, with the sweep command', async () => {
    const { patchDocument } = await import('@yapa/core');
    configure({ YAPA_FINDINGS_CLEANUP_THRESHOLD: '2' });
    const old = Math.floor(Date.now() / 1000) - 5 * 86400;
    for (const t of ['The beta importer drops rows with a null region.', 'The beta export retries forever on a 403.']) {
      const { ids: [id] } = await storeMemory(t, { collection: 'project-beta', typed: { kind: 'finding' } });
      await patchDocument('project-beta', id, { created_at: old });
    }
    capture();
    await sessionStart({ session_id: 'fb1', cwd: join(dir, 'proj', 'beta'), source: 'startup' });
    let ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('## Findings backlog');
    expect(ctx).toContain('2 of your open findings in project-beta have had no disposition for over two days. `yapa memory sweep-findings --collection project-beta --save FILE`');

    configure({ YAPA_FINDINGS_CLEANUP_THRESHOLD: '3' });
    capture();
    await sessionStart({ session_id: 'fb2', cwd: join(dir, 'proj', 'beta'), source: 'startup' });
    ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).not.toContain('## Findings backlog');
  });

  it('session start lists decisions and steps that name you, and counts those for anyone', async () => {
    const { createTask } = await import('@yapa/core');
    await storeMemory('Keep the old API for one more release?', {
      collection: 'project-acme', typed: { kind: 'decision', status: 'needed', owner: 'josh', options: ['keep it', 'drop it'], recommendation: 'keep it' },
    });
    await storeMemory('Ask the vendor about rate limits', { collection: 'project-acme', typed: { kind: 'question', owner: 'alex' } });
    const { addDocument } = await import('@yapa/core');
    await addDocument('project-acme', 'alex-1', 'Alex signs off', { type: 'task', status: 'pending', username: 'alex', created_at: 1, tags: '' });
    await storeMemory('Does the CDN cache 404s?', { collection: 'project-acme', typed: { kind: 'question', owner: 'CDN support' } });
    await createTask('Approve the cloud spend', { tags: ['needs-human'] }, 'project-other');
    capture();
    await sessionStart({ session_id: 'w1', cwd: join(dir, 'proj', 'acme'), source: 'startup' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('## Waiting on you');
    expect(ctx).toMatch(/\(project-acme\) \[decision needed, for josh, new\] Keep the old API/);
    expect(ctx).toContain('options: keep it | drop it; recommended: keep it');
    const section = ctx.slice(ctx.indexOf('## Waiting on you')).split('\n## ')[0];
    expect(section).not.toContain('Ask the vendor');
    expect(section).toMatch(/\[question, for josh, ask CDN support, new\] Does the CDN cache 404s\?/);
    expect(section).toContain('1 item(s) wait on anyone');
  });

  it('a shared scope only counts private decisions; their own scope (and global) lists them', async () => {
    await storeMemory('Rotate the acme private signing key now?', {
      collection: 'private-acme-keys', typed: { kind: 'decision', status: 'needed', owner: 'josh', options: ['now', 'next week'] },
    });
    const shared = (await waitingLines('josh', 2000, 'project-acme')).join('\n');
    expect(shared).not.toContain('Rotate the acme private signing key');
    expect(shared).not.toContain('private-acme-keys');
    expect(shared).toMatch(/1 more in private collections, not listed in this shared scope/);
    expect(shared).toContain('Keep the old API');
    for (const scope of ['private-acme-keys', 'global']) {
      const lines = (await waitingLines('josh', 2000, scope)).join('\n');
      expect(lines).toMatch(/\(private-acme-keys\) \[decision needed, for josh, new\] Rotate the acme private signing key/);
      expect(lines).not.toContain('in private collections');
    }
  });
});

describe('collection_map: a folder with a private collection', () => {
  const cwd = () => join(dir, 'work', 'acme-private', 'src');
  const mapped = () => configure({ YAPA_COLLECTION_MAP: `${join(dir, 'work', 'acme-private')}=private-acme`, YAPA_RESPONSE_CAPTURE: 'true', YAPA_ANTHROPIC_API_KEY: 'k' });

  it('every hook scopes to the mapped collection and never contacts the remote', async () => {
    mapped();
    await storeMemory('acme private: the staging password rotates on Mondays', { collection: 'private-acme', salience: 3 });
    // Any call on the sync backend (pull, presence lease list, heartbeat) is recorded.
    const core = await vi.importActual<any>('@yapa/core');
    const remoteCalls: string[] = [];
    const recorder = (prefix: string) => new Proxy({}, {
      get: (_t, k) => (k === 'then' ? undefined : async () => { remoteCalls.push(`${prefix}${String(k)}`); throw new Error('no remote in this test'); }),
    });
    const coordination = recorder('coordination.');
    core.setSyncBackend(new Proxy({}, {
      get: (_t, k) => (k === 'then' ? undefined : k === 'kind' ? 'postgres' : k === 'coordination' ? coordination : (recorder('') as any)[k]),
    }));
    heartbeatIfDue.mockImplementation(core.heartbeatIfDue);

    capture();
    await sessionStart({ session_id: 'm1', cwd: cwd(), source: 'startup' });
    expect(restore().hookSpecificOutput.additionalContext).toContain('**Scope:** `private-acme` (local only, never synced)');

    capture();
    await userPromptSubmit({ session_id: 'm1', cwd: cwd(), prompt: 'when does the acme staging password rotate?' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('**Scope:** `private-acme` (local only, never synced)');
    expect(ctx).toMatch(/rotates on Mondays/);
    expect(pullCollection).not.toHaveBeenCalled();

    captureTurn.mockResolvedValueOnce({ stored: 0, skipped: 0, superseded: 0 });
    await stop({ session_id: 'm1', cwd: cwd(), last_assistant_message: 'It rotates every Monday at 09:00 UTC. '.repeat(10) });
    expect(captureTurn.mock.calls[0][0]).toMatchObject({ collection: 'private-acme' });

    await postCompact({ session_id: 'm1', cwd: cwd(), compact_summary: 'Decided: acme private notes stay local.', trigger: 'auto' });
    const all = await listMemories({ collection: 'private-acme', limit: 50 });
    expect(all.some(m => m.content.includes('acme private notes stay local'))).toBe(true);
    expect(pullCollection).not.toHaveBeenCalled();
    // Presence is skipped for a private scope, and the heartbeat ran (for
    // real) without reaching the service: this session holds no leases.
    expect(heartbeatIfDue).toHaveBeenCalled();
    expect(remoteCalls).toEqual([]);
    // The recorder does see calls: a shared folder's session start asks for presence.
    capture();
    await sessionStart({ session_id: 'm1', cwd: join(dir, 'proj', 'acme'), source: 'startup' });
    restore();
    expect(remoteCalls).toContain('coordination.leaseList');
    core.setSyncBackend(undefined);
  });

  it("a private note never surfaces in another folder's recall", async () => {
    mapped();
    capture();
    await userPromptSubmit({ session_id: 'm2', cwd: join(dir, 'proj', 'acme'), prompt: 'when does the acme staging password rotate?' });
    expect(JSON.stringify(restore())).not.toContain('rotates on Mondays');
  });
});

describe('after merging a shared collection into a private one', () => {
  it('a prompt in the old folder lands in the target and neither recreates nor re-follows the source', async () => {
    const core = await import('@yapa/core');
    await storeMemory('acme-legacy build uses gradle 8', { collection: 'project-acme-legacy', salience: 3 });
    await core.createNewCollection('private-acme-legacy');
    await core.updateSyncSubscriptions([...(await core.getSyncSubscriptions()), 'project-acme-legacy']);
    await core.mergeCollections('project-acme-legacy', 'private-acme-legacy');

    capture();
    await userPromptSubmit({ session_id: 'r1', cwd: join(dir, 'proj', 'acme-legacy'), prompt: 'which gradle does acme-legacy build with?' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('**Scope:** `private-acme-legacy` (local only, never synced) (merged from `project-acme-legacy`)');
    expect(ctx).toMatch(/gradle 8/);
    capture();
    await sessionStart({ session_id: 'r1', cwd: join(dir, 'proj', 'acme-legacy'), source: 'startup' });
    restore();

    expect(pullCollection).not.toHaveBeenCalled();
    expect(await freshenFromRemote('project-acme-legacy')).toBe(0);
    expect(pullCollection).not.toHaveBeenCalled();
    expect((await core.listCollections()).map(c => c.name)).not.toContain('project-acme-legacy');
    expect(await core.getSyncSubscriptions()).not.toContain('project-acme-legacy');

    // A hardcoded old name in a write follows the redirect too.
    await storeMemory('acme-legacy: switched to gradle 9', { collection: 'project-acme-legacy' });
    expect((await core.listCollections()).map(c => c.name)).not.toContain('project-acme-legacy');
    expect((await listMemories({ collection: 'private-acme-legacy', limit: 50 })).some(m => m.content.includes('gradle 9'))).toBe(true);
  });
});

describe('after removing a shared collection from this machine only', () => {
  it('a prompt in its folder never backfills or re-follows it', async () => {
    const core = await import('@yapa/core');
    await core.createNewCollection('project-acme-gone');
    await core.updateSyncSubscriptions([...(await core.getSyncSubscriptions()), 'project-acme-gone']);
    await core.removeCollection('project-acme-gone');
    expect(await core.getLeftCollections()).toContain('project-acme-gone');

    capture();
    await userPromptSubmit({ session_id: 'g1', cwd: join(dir, 'proj', 'acme-gone'), prompt: 'what did we decide for acme-gone?' });
    restore();
    capture();
    await sessionStart({ session_id: 'g1', cwd: join(dir, 'proj', 'acme-gone'), source: 'startup' });
    const ctx = restore().hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('(removed from this machine: writes to it are refused; `sync subscribe project-acme-gone` follows it again)');
    expect(await freshenFromRemote('project-acme-gone')).toBe(0);
    expect(pullCollection).not.toHaveBeenCalled();
    expect(await core.getSyncSubscriptions()).not.toContain('project-acme-gone');
  });
});
