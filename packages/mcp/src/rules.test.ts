import { describe, it, expect } from 'vitest';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_MAX } from './rules.js';

describe('the server instructions', () => {
  it('fit under the 4,096-character cut Claude Code applies, with room to spare', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(SERVER_INSTRUCTIONS_MAX);
    expect(SERVER_INSTRUCTIONS_MAX).toBeLessThan(4096);
  });

  it('cover when to recall, store, track tasks and respect scope', () => {
    for (const s of ['memory_recall', 'memory_store', 'kind', 'task_create', 'in_progress', 'task_complete', 'decision_needed', 'collection_merge', 'private-', 'AMBIGUOUS', 'potential_conflicts', 'waiting']) {
      expect(SERVER_INSTRUCTIONS).toContain(s);
    }
  });
});
