import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_EVENTS, mergeHooks, removeHooks, installHooks, uninstallHooks } from './install-hooks.js';

const CMD = 'node /opt/yapa/plugin/dist/yapa.mjs';
const other = { type: 'command', command: '/home/u/.claude/skills/your-voice/capture-prompt.sh' };
const legacy = { type: 'command', command: 'node /home/u/projects/.yapa/dist/cli/index.js hook session-start' };

describe('mergeHooks', () => {
  it('adds one entry per YAPA hook event', () => {
    const merged = mergeHooks({}, CMD);
    for (const { event, sub } of HOOK_EVENTS) {
      expect(merged.hooks[event][0].hooks[0].command).toBe(`${CMD} hook ${sub}`);
    }
    expect(merged.hooks.Stop[0].hooks[0].async).toBe(true);
  });

  it('is idempotent and keeps unrelated hooks and settings', () => {
    const start = { theme: 'dark', hooks: { UserPromptSubmit: [{ hooks: [other] }] } };
    const twice = mergeHooks(mergeHooks(start, CMD), CMD);
    expect(twice.theme).toBe('dark');
    expect(twice.hooks.UserPromptSubmit).toHaveLength(2);
    expect(twice.hooks.UserPromptSubmit[0].hooks[0]).toEqual(other);
    expect(twice.hooks.SessionStart).toHaveLength(1);
  });

  it('replaces a pre-plugin YAPA install\'s hooks instead of duplicating them', () => {
    const merged = mergeHooks({ hooks: { SessionStart: [{ hooks: [legacy] }] } }, CMD);
    expect(merged.hooks.SessionStart.flatMap((g: any) => g.hooks).map((h: any) => h.command)).toEqual([`${CMD} hook session-start`]);
  });
});

describe('removeHooks', () => {
  it('removes only YAPA entries and prunes empty events', () => {
    const cleaned = removeHooks(mergeHooks({ hooks: { UserPromptSubmit: [{ hooks: [other] }] } }, CMD));
    expect(cleaned.hooks).toEqual({ UserPromptSubmit: [{ hooks: [other] }] });
    expect(removeHooks(mergeHooks({}, CMD)).hooks).toBeUndefined();
  });
});

describe('installHooks / uninstallHooks', () => {
  it('round-trips a real settings file and refuses to clobber invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yapa-settings-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify({ effortLevel: 'high' }));
      installHooks(path, CMD);
      expect(JSON.parse(readFileSync(path, 'utf-8')).hooks.SessionEnd).toHaveLength(1);
      uninstallHooks(path);
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ effortLevel: 'high' });

      writeFileSync(path, '{ not json');
      expect(() => installHooks(path, CMD)).toThrow(/Refusing to edit/);
      expect(readFileSync(path, 'utf-8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
