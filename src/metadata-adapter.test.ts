import { describe, expect, it } from 'vitest';
import { fromChroma, toChroma } from './metadata-adapter.js';

describe('metadata-adapter round trip', () => {
  it('preserves existing lifecycle fields', () => {
    const input = {
      salience: 2.5,
      accessed_at: 1700000000,
      created_at: 1699000000,
      sector: 'semantic',
      tags: ['a', 'b'],
    };
    const roundTripped = fromChroma(toChroma(input));
    expect(roundTripped.salience).toBe(2.5);
    expect(roundTripped.accessed_at).toBe(1700000000);
    expect(roundTripped.created_at).toBe(1699000000);
    expect(roundTripped.sector).toBe('semantic');
    expect(roundTripped.tags).toEqual(['a', 'b']);
  });

  it('round-trips new classifier score fields as primitives', () => {
    const input = {
      trainable: 0.85,
      durability: 0.9,
      generalizability: 0.5,
      classified_at: 1700000000,
    };
    const roundTripped = fromChroma(toChroma(input));
    expect(roundTripped.trainable).toBe(0.85);
    expect(roundTripped.durability).toBe(0.9);
    expect(roundTripped.generalizability).toBe(0.5);
    expect(roundTripped.classified_at).toBe(1700000000);
  });

  it('round-trips promotion state-machine fields', () => {
    const input = {
      selected_for: 'training-v7',
      selected_at: 1700001000,
      promoted_to: 'system-prompt-v3',
      promoted_at: 1700002000,
    };
    const roundTripped = fromChroma(toChroma(input));
    expect(roundTripped.selected_for).toBe('training-v7');
    expect(roundTripped.selected_at).toBe(1700001000);
    expect(roundTripped.promoted_to).toBe('system-prompt-v3');
    expect(roundTripped.promoted_at).toBe(1700002000);
  });

  it('round-trips verification fields', () => {
    const input = {
      verification_attempts: 2,
      verification_last_result: 'failed',
    };
    const roundTripped = fromChroma(toChroma(input));
    expect(roundTripped.verification_attempts).toBe(2);
    expect(roundTripped.verification_last_result).toBe('failed');
  });

  it('drops null/undefined new fields (consistent with existing adapter behavior)', () => {
    const input = {
      salience: 1.0,
      trainable: null,
      durability: undefined,
      promoted_to: null,
    };
    const chroma = toChroma(input);
    expect('trainable' in chroma).toBe(false);
    expect('durability' in chroma).toBe(false);
    expect('promoted_to' in chroma).toBe(false);
    expect(chroma.salience).toBe(1.0);
  });
});
