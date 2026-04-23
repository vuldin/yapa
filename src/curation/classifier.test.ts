import { describe, expect, it } from 'vitest';
import { classifyMemories, parseClassifierResponse } from './classifier.js';
import { buildClassifierUserPrompt, CLASSIFIER_SYSTEM_PROMPT } from './prompts.js';

describe('parseClassifierResponse', () => {
  const memories = [
    { id: 'mem-1', content: 'alpha' },
    { id: 'mem-2', content: 'beta' },
  ];

  it('parses a well-formed JSON array', () => {
    const raw = JSON.stringify([
      { id: 'mem-1', trainable: 0.8, durability: 0.9, generalizability: 0.7, rationale: 'a' },
      { id: 'mem-2', trainable: 0.1, durability: 0.2, generalizability: 0.3, rationale: 'b' },
    ]);
    const results = parseClassifierResponse(raw, memories);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('mem-1');
    expect(results[0].trainable).toBe(0.8);
    expect(results[1].rationale).toBe('b');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n[{"id":"mem-1","trainable":0.5,"durability":0.5,"generalizability":0.5,"rationale":"x"}]\n```';
    const results = parseClassifierResponse(raw, memories);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mem-1');
  });

  it('extracts a JSON array from trailing commentary', () => {
    const raw = 'Here is my output:\n[{"id":"mem-1","trainable":0.4,"durability":0.5,"generalizability":0.6,"rationale":"x"}]\nHope this helps!';
    const results = parseClassifierResponse(raw, memories);
    expect(results).toHaveLength(1);
    expect(results[0].generalizability).toBe(0.6);
  });

  it('clamps out-of-range scores to [0, 1]', () => {
    const raw = '[{"id":"mem-1","trainable":1.5,"durability":-0.5,"generalizability":"0.3","rationale":""}]';
    const results = parseClassifierResponse(raw, memories);
    expect(results[0].trainable).toBe(1);
    expect(results[0].durability).toBe(0);
    expect(results[0].generalizability).toBe(0.3);
  });

  it('ignores entries for unknown memory IDs', () => {
    const raw = '[{"id":"unknown","trainable":0.5,"durability":0.5,"generalizability":0.5,"rationale":"x"}]';
    const results = parseClassifierResponse(raw, memories);
    expect(results).toHaveLength(0);
  });

  it('deduplicates results with the same id', () => {
    const raw = JSON.stringify([
      { id: 'mem-1', trainable: 0.5, durability: 0.5, generalizability: 0.5, rationale: 'first' },
      { id: 'mem-1', trainable: 0.9, durability: 0.9, generalizability: 0.9, rationale: 'second' },
    ]);
    const results = parseClassifierResponse(raw, memories);
    expect(results).toHaveLength(1);
    expect(results[0].rationale).toBe('first');
  });

  it('throws when the response is not JSON at all', () => {
    expect(() => parseClassifierResponse('no json here', memories)).toThrow();
  });

  it('handles empty input array', () => {
    expect(parseClassifierResponse('[]', memories)).toEqual([]);
  });
});

describe('classifyMemories with injected LLM call', () => {
  it('returns empty array on empty input without calling the LLM', async () => {
    let called = false;
    const results = await classifyMemories([], {
      call: async () => {
        called = true;
        return '[]';
      },
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('passes all memories to the LLM call and parses the response', async () => {
    const memories = [
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'beta' },
    ];
    let receivedSystem = '';
    let receivedUser = '';
    const fakeCall = async (opts: any) => {
      receivedSystem = opts.messages.find((m: any) => m.role === 'system').content;
      receivedUser = opts.messages.find((m: any) => m.role === 'user').content;
      return JSON.stringify([
        { id: 'a', trainable: 0.3, durability: 0.4, generalizability: 0.5, rationale: 'ra' },
        { id: 'b', trainable: 0.6, durability: 0.7, generalizability: 0.8, rationale: 'rb' },
      ]);
    };
    const results = await classifyMemories(memories, { call: fakeCall });
    expect(results).toHaveLength(2);
    expect(results.map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(receivedSystem).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect(receivedUser).toContain('alpha');
    expect(receivedUser).toContain('beta');
  });
});

describe('classifier prompt structure', () => {
  it('includes all required instructions', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('trainable');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('durability');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('generalizability');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('rationale');
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('JSON');
  });

  it('is domain-agnostic — does not reference specific users/customers', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).not.toMatch(/redpanda|drasil|josh|cgi|triplelift/i);
  });

  it('builds a user prompt listing each memory by index', () => {
    const prompt = buildClassifierUserPrompt([
      { id: 'mem-1', content: 'first memory' },
      { id: 'mem-2', content: 'second memory' },
    ]);
    expect(prompt).toContain('[MEMORY 1]');
    expect(prompt).toContain('[MEMORY 2]');
    expect(prompt).toContain('mem-1');
    expect(prompt).toContain('mem-2');
    expect(prompt).toContain('first memory');
    expect(prompt).toContain('second memory');
  });
});
