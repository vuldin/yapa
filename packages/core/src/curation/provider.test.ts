import { describe, it, expect } from 'vitest';
import { buildClaudeCliArgs } from './provider.js';

describe('buildClaudeCliArgs', () => {
  it('runs an isolated, tool-less print-mode completion', () => {
    const args = buildClaudeCliArgs('haiku', 'You extract memories.');
    expect(args.slice(0, 2)).toEqual(['-p', '--safe-mode']);
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--no-session-persistence']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You extract memories.');
    // --bare would skip keychain reads and break subscription (OAuth) logins.
    expect(args).not.toContain('--bare');
  });

  it('omits the system prompt flag when there is none', () => {
    expect(buildClaudeCliArgs('haiku', '')).not.toContain('--system-prompt');
  });
});
