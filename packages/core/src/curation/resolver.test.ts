import { describe, expect, it } from 'vitest';
import {
  buildResolverUserPrompt,
  parseResolverResponse,
  resolveConflict,
  RESOLVER_SYSTEM_PROMPT,
} from './resolver.js';

const neighbors = [
  { id: 'mem-a', content: 'X runs on port 8000.', distance: 0.1, salience: 2 },
  { id: 'mem-b', content: 'X is written in Go.', distance: 0.2, salience: 1.5 },
];

describe('parseResolverResponse', () => {
  it('parses a skip decision', () => {
    const d = parseResolverResponse('{"action":"skip","rationale":"same fact"}', neighbors);
    expect(d.action).toBe('skip');
  });

  it('parses an add decision', () => {
    const d = parseResolverResponse('{"action":"add","rationale":"distinct"}', neighbors);
    expect(d.action).toBe('add');
  });

  it('parses a supersede decision with target and merged content', () => {
    const raw = JSON.stringify({
      action: 'supersede',
      target_id: 'mem-a',
      merged_content: 'X runs on port 9000 (previously 8000).',
      rationale: 'port changed',
    });
    const d = parseResolverResponse(raw, neighbors);
    expect(d.action).toBe('supersede');
    expect(d.targetId).toBe('mem-a');
    expect(d.mergedContent).toContain('9000');
  });

  it('demotes supersede with a hallucinated target to skip (conservative)', () => {
    const raw = '{"action":"supersede","target_id":"mem-zzz","rationale":"x"}';
    const d = parseResolverResponse(raw, neighbors);
    expect(d.action).toBe('skip');
    expect(d.rationale).toContain('kept both');
  });

  it('demotes supersede without a target to skip', () => {
    const d = parseResolverResponse('{"action":"supersede","rationale":"x"}', neighbors);
    expect(d.action).toBe('skip');
  });

  it('treats an unknown action as add', () => {
    const d = parseResolverResponse('{"action":"explode","rationale":"x"}', neighbors);
    expect(d.action).toBe('add');
  });

  it('strips markdown fences', () => {
    const d = parseResolverResponse('```json\n{"action":"skip","rationale":"fenced"}\n```', neighbors);
    expect(d.action).toBe('skip');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseResolverResponse('no json', neighbors)).toThrow();
  });
});

describe('buildResolverUserPrompt', () => {
  it('presents the candidate and every neighbor with ids', () => {
    const prompt = buildResolverUserPrompt('X now runs on port 9000.', neighbors);
    expect(prompt).toContain('[CANDIDATE]');
    expect(prompt).toContain('port 9000');
    expect(prompt).toContain('mem-a');
    expect(prompt).toContain('mem-b');
  });
});

describe('resolveConflict', () => {
  it('short-circuits to add with no neighbors (no LLM call)', async () => {
    let called = false;
    const d = await resolveConflict('anything', [], { call: async () => { called = true; return '{}'; } });
    expect(d.action).toBe('add');
    expect(called).toBe(false);
  });

  it('sends the resolver system prompt and returns the parsed decision', async () => {
    let seenSystem = '';
    const d = await resolveConflict('X now runs on port 9000.', neighbors, {
      call: async ({ messages }) => {
        seenSystem = String(messages[0].content);
        return '{"action":"supersede","target_id":"mem-a","rationale":"changed"}';
      },
    });
    expect(seenSystem).toBe(RESOLVER_SYSTEM_PROMPT);
    expect(d.action).toBe('supersede');
    expect(d.targetId).toBe('mem-a');
  });
});
