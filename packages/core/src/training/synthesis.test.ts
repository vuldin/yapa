import { describe, expect, it } from 'vitest';
import {
  formatTrainingJsonl,
  parseSynthesisResponse,
  synthesizeMemory,
  SYNTHESIS_SYSTEM_PROMPT,
} from './synthesis.js';

describe('parseSynthesisResponse', () => {
  it('accepts a valid chat-format JSON array', () => {
    const raw = JSON.stringify([
      {
        messages: [
          { role: 'system', content: 's1' },
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
        ],
      },
    ]);
    const results = parseSynthesisResponse(raw);
    expect(results).toHaveLength(1);
    expect(results[0].messages).toHaveLength(3);
    expect(results[0].messages[2].role).toBe('assistant');
  });

  it('strips markdown fences', () => {
    const raw = '```json\n[{"messages":[{"role":"user","content":"u"},{"role":"assistant","content":"a"}]}]\n```';
    const results = parseSynthesisResponse(raw);
    expect(results).toHaveLength(1);
  });

  it('rejects examples missing an assistant turn', () => {
    const raw = JSON.stringify([
      { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] },
    ]);
    const results = parseSynthesisResponse(raw);
    expect(results).toHaveLength(0);
  });

  it('rejects examples with invalid roles', () => {
    const raw = JSON.stringify([
      { messages: [{ role: 'user', content: 'u' }, { role: 'bogus', content: 'x' }] },
    ]);
    const results = parseSynthesisResponse(raw);
    expect(results).toHaveLength(0);
  });

  it('handles empty array (memory not suitable)', () => {
    expect(parseSynthesisResponse('[]')).toEqual([]);
  });

  it('throws when no JSON can be recovered', () => {
    expect(() => parseSynthesisResponse('the cat sat on the mat')).toThrow();
  });
});

describe('synthesizeMemory with injected LLM call', () => {
  it('passes memory content to the LLM and parses the response', async () => {
    let receivedUser = '';
    let receivedSystem = '';
    const call = async (opts: any) => {
      receivedSystem = opts.messages.find((m: any) => m.role === 'system').content;
      receivedUser = opts.messages.find((m: any) => m.role === 'user').content;
      return JSON.stringify([
        { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] },
      ]);
    };
    const result = await synthesizeMemory(
      { id: 'm-1', collection: 'global', content: 'payload' },
      { call },
    );
    expect(result.id).toBe('m-1');
    expect(result.examples).toHaveLength(1);
    expect(receivedUser).toContain('payload');
    expect(receivedSystem).toBe(SYNTHESIS_SYSTEM_PROMPT);
  });

  it('returns empty examples when the LLM returns an empty array', async () => {
    const call = async () => '[]';
    const result = await synthesizeMemory({ id: 'x', content: 'trivial fact' }, { call });
    expect(result.examples).toEqual([]);
  });
});

describe('formatTrainingJsonl', () => {
  it('emits one line per example across all memories', () => {
    const jsonl = formatTrainingJsonl([
      {
        id: 'a',
        examples: [
          { messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }] },
          { messages: [{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }] },
        ],
      },
      {
        id: 'b',
        examples: [
          { messages: [{ role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' }] },
        ],
      },
    ]);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('messages');
    }
  });

  it('emits empty string for empty input', () => {
    expect(formatTrainingJsonl([])).toBe('');
  });
});

describe('synthesis prompt is domain-agnostic', () => {
  it('does not mention specific users/customers', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).not.toMatch(/redpanda|drasil|josh|cgi|triplelift/i);
  });

  it('includes chat-format output requirements', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain('messages');
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain('assistant');
    expect(SYNTHESIS_SYSTEM_PROMPT).toContain('JSON');
  });
});
