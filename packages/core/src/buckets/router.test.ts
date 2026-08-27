import { describe, expect, it } from 'vitest';
import { routeMemory, type Thresholds } from './router.js';

const SP: Thresholds = { trainable: 0.5, durability: 0.7, generalizability: 0.5 };
const TR: Thresholds = { trainable: 0.7, durability: 0.8, generalizability: 0.7 };
const custom = { systemPrompt: SP, training: TR };

describe('routeMemory', () => {
  it('returns no buckets when the memory is not yet classified', () => {
    const decision = routeMemory({ metadata: {} }, custom);
    expect(decision.buckets).toEqual([]);
    expect(decision.reasons['system-prompt']).toContain('not classified');
  });

  it('routes into system-prompt when all three thresholds meet (and training not)', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.6,
      durability: 0.75,
      generalizability: 0.55,
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toEqual(['system-prompt']);
    expect(decision.reasons.training).toContain('below training');
  });

  it('routes into both buckets when training thresholds (stricter) are also met', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.85,
      durability: 0.85,
      generalizability: 0.85,
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toEqual(['system-prompt', 'training']);
  });

  it('routes nothing when any single dimension is below the system-prompt threshold', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.4, // below SP 0.5
      durability: 0.9,
      generalizability: 0.9,
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toEqual([]);
  });

  it('skips system-prompt bucket if already selected or promoted there', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.9,
      durability: 0.9,
      generalizability: 0.9,
      selected_for: 'system-prompt-v5',
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toEqual(['training']);
    expect(decision.reasons['system-prompt']).toContain('already routed');
  });

  it('skips training bucket if already promoted there', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.9,
      durability: 0.9,
      generalizability: 0.9,
      promoted_to: 'training-v2',
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toEqual(['system-prompt']);
    expect(decision.reasons.training).toContain('already routed');
  });

  it('handles borderline scores exactly at the threshold (inclusive)', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.5, // exactly SP.trainable
      durability: 0.7, // exactly SP.durability
      generalizability: 0.5, // exactly SP.generalizability
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toContain('system-prompt');
  });

  it('explains exactly which dimensions missed when a bucket is rejected', () => {
    const metadata = {
      classified_at: 123,
      trainable: 0.6,
      durability: 0.5,
      generalizability: 0.4,
    };
    const decision = routeMemory({ metadata }, custom);
    expect(decision.buckets).toEqual([]);
    expect(decision.reasons['system-prompt']).toContain('durability');
    expect(decision.reasons['system-prompt']).toContain('generalizability');
    // trainable was 0.6, above SP threshold 0.5, so should NOT be in the reason
    expect(decision.reasons['system-prompt']).not.toContain('trainable 0.60');
  });

  it('uses configured defaults when no custom thresholds are provided', () => {
    // Don't pass custom — must not throw and should return a sensible decision shape
    const metadata = {
      classified_at: 1,
      trainable: 0.95,
      durability: 0.95,
      generalizability: 0.95,
    };
    const decision = routeMemory({ metadata });
    expect(Array.isArray(decision.buckets)).toBe(true);
    expect(decision.reasons).toHaveProperty('system-prompt');
    expect(decision.reasons).toHaveProperty('training');
  });
});
