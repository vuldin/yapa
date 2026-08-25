import { describe, expect, it } from 'vitest';
import {
  buildExtractorUserPrompt,
  extractMemories,
  EXTRACTOR_SYSTEM_PROMPT,
  parseExtractorResponse,
} from './extractor.js';

describe('parseExtractorResponse', () => {
  it('parses a well-formed JSON array', () => {
    const raw = JSON.stringify([
      { content: 'The FD codec requires frame sync.', tags: ['codec'], sector: 'semantic', salience: 2.5, rationale: 'non-obvious fact' },
      { content: 'Deploy window is Fridays.', tags: [], sector: 'episodic', salience: 1.5, rationale: 'decision' },
    ]);
    const results = parseExtractorResponse(raw);
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('FD codec');
    expect(results[0].salience).toBe(2.5);
    expect(results[1].sector).toBe('episodic');
  });

  it('returns [] for an explicit empty array (the common case)', () => {
    expect(parseExtractorResponse('[]')).toHaveLength(0);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n[{"content":"X is at /etc/yapa.yml","tags":["config"],"sector":"semantic","salience":2,"rationale":"path"}]\n```';
    const results = parseExtractorResponse(raw);
    expect(results).toHaveLength(1);
  });

  it('extracts a JSON array from surrounding commentary', () => {
    const raw = 'Found one:\n[{"content":"Root cause: stale inode cache.","tags":[],"sector":"semantic","salience":3,"rationale":"root cause"}]\nDone.';
    const results = parseExtractorResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].salience).toBe(3);
  });

  it('drops entries without non-empty content', () => {
    const raw = JSON.stringify([
      { content: '', tags: [], sector: 'semantic', salience: 2, rationale: 'empty' },
      { nope: true },
      { content: 'Real fact.', tags: [], sector: 'semantic', salience: 2, rationale: 'ok' },
    ]);
    const results = parseExtractorResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Real fact.');
  });

  it('clamps salience to [1, 3] and defaults unknown sector to semantic', () => {
    const raw = JSON.stringify([
      { content: 'a', tags: [], sector: 'weird', salience: 9, rationale: '' },
      { content: 'b', tags: [], sector: 'episodic', salience: 'nope', rationale: '' },
    ]);
    const results = parseExtractorResponse(raw);
    expect(results[0].salience).toBe(3);
    expect(results[0].sector).toBe('semantic');
    expect(results[1].salience).toBe(1);
  });

  it('normalizes tags: lowercase, non-empty strings only, max 4', () => {
    const raw = JSON.stringify([
      { content: 'x', tags: [' Bug ', '', 42, 'FIX', 'c', 'd', 'e'], sector: 'semantic', salience: 1, rationale: '' },
    ]);
    const results = parseExtractorResponse(raw);
    expect(results[0].tags).toEqual(['bug', 'fix', 'c', 'd']);
  });

  it('throws on a response with no extractable JSON array', () => {
    expect(() => parseExtractorResponse('nothing here')).toThrow();
  });
});

describe('buildExtractorUserPrompt', () => {
  it('includes collection, user text, and assistant text', () => {
    const prompt = buildExtractorUserPrompt({
      collection: 'customer-acme',
      userText: 'why did the deploy fail?',
      assistantText: 'The deploy failed because the token expired.',
    });
    expect(prompt).toContain('customer-acme');
    expect(prompt).toContain('why did the deploy fail?');
    expect(prompt).toContain('token expired');
  });

  it('marks an absent user message explicitly', () => {
    const prompt = buildExtractorUserPrompt({ collection: 'global', userText: '', assistantText: 'x' });
    expect(prompt).toContain('(none — injected or continuation turn)');
  });
});

describe('extractMemories', () => {
  const input = { collection: 'global', userText: 'u', assistantText: 'a' };

  it('returns [] without calling the LLM when assistant text is blank', async () => {
    let called = false;
    const results = await extractMemories(
      { ...input, assistantText: '   ' },
      { call: async () => { called = true; return '[]'; } },
    );
    expect(results).toHaveLength(0);
    expect(called).toBe(false);
  });

  it('sends the extractor system prompt and parses the response', async () => {
    let seenSystem = '';
    const results = await extractMemories(input, {
      call: async ({ messages }) => {
        seenSystem = String(messages[0].content);
        return '[{"content":"Fact.","tags":["t"],"sector":"semantic","salience":2,"rationale":"r"}]';
      },
    });
    expect(seenSystem).toBe(EXTRACTOR_SYSTEM_PROMPT);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Fact.');
  });

  it('clamps to maxMemories', async () => {
    const many = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ content: `fact ${i}`, tags: [], sector: 'semantic', salience: 1, rationale: '' })),
    );
    const results = await extractMemories(input, { call: async () => many, maxMemories: 2 });
    expect(results).toHaveLength(2);
  });
});
