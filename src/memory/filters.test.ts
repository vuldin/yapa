import { describe, expect, it } from 'vitest';
import {
  normalizedSalience,
  passesPromotedFilter,
  passesScoreFilters,
  rankScore,
} from './filters.js';
import { SALIENCE_FLOOR, SALIENCE_MAX } from '../config.js';

describe('normalizedSalience', () => {
  it('maps floor to 0', () => {
    expect(normalizedSalience(SALIENCE_FLOOR)).toBe(0);
  });

  it('maps max to 1', () => {
    expect(normalizedSalience(SALIENCE_MAX)).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(normalizedSalience(-5)).toBe(0);
    expect(normalizedSalience(1000)).toBe(1);
  });

  it('defaults undefined to SALIENCE_START (1.0)', () => {
    const n = normalizedSalience(undefined);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(1);
  });
});

describe('rankScore', () => {
  it('lower distance ranks lower (better) than higher distance at equal salience', () => {
    expect(rankScore(0.2, 1.0)).toBeLessThan(rankScore(0.5, 1.0));
  });

  it('higher salience produces a lower score at equal distance', () => {
    const lowSalience = rankScore(0.5, 0.5);
    const highSalience = rankScore(0.5, 4.5);
    expect(highSalience).toBeLessThan(lowSalience);
  });

  it('salience can flip ordering vs pure distance', () => {
    // Close-distance but low salience should lose to farther but high salience
    // when salience weighting is strong enough. With default 0.3 weight:
    // a: distance 0.25, salience floor → rank ≈ 0.25
    // b: distance 0.30, salience max → rank ≈ 0.30 - 0.3 * 1 = 0.00
    const a = rankScore(0.25, SALIENCE_FLOOR);
    const b = rankScore(0.30, SALIENCE_MAX);
    expect(b).toBeLessThan(a);
  });
});

describe('passesPromotedFilter', () => {
  it('excludes memories with promoted_to set when include_promoted is false', () => {
    expect(passesPromotedFilter({ promoted_to: 'training-v1' }, false)).toBe(false);
    expect(passesPromotedFilter({ promoted_to: 'system-prompt-v5' }, false)).toBe(false);
  });

  it('includes memories without promoted_to when include_promoted is false', () => {
    expect(passesPromotedFilter({}, false)).toBe(true);
    expect(passesPromotedFilter({ promoted_to: null }, false)).toBe(true);
    expect(passesPromotedFilter({ promoted_to: undefined }, false)).toBe(true);
  });

  it('does NOT exclude memories based on selected_for (intermediate state stays visible)', () => {
    expect(passesPromotedFilter({ selected_for: 'training-v1' }, false)).toBe(true);
    expect(passesPromotedFilter({ selected_for: 'system-prompt-v5' }, false)).toBe(true);
  });

  it('surfaces promoted memories when include_promoted is true', () => {
    expect(passesPromotedFilter({ promoted_to: 'training-v1' }, true)).toBe(true);
    expect(passesPromotedFilter({}, true)).toBe(true);
  });
});

describe('passesScoreFilters', () => {
  it('returns true when no filters provided', () => {
    expect(passesScoreFilters({ trainable: 0.1 }, undefined)).toBe(true);
    expect(passesScoreFilters({}, {})).toBe(true);
  });

  it('enforces trainable_min', () => {
    expect(passesScoreFilters({ trainable: 0.5 }, { trainable_min: 0.7 })).toBe(false);
    expect(passesScoreFilters({ trainable: 0.8 }, { trainable_min: 0.7 })).toBe(true);
  });

  it('treats missing scores as below any positive threshold', () => {
    expect(passesScoreFilters({}, { trainable_min: 0.1 })).toBe(false);
    expect(passesScoreFilters({}, { durability_min: 0.1 })).toBe(false);
    expect(passesScoreFilters({}, { generalizability_min: 0.1 })).toBe(false);
  });

  it('applies filters conjunctively', () => {
    const meta = { trainable: 0.9, durability: 0.5 };
    expect(
      passesScoreFilters(meta, { trainable_min: 0.8, durability_min: 0.7 }),
    ).toBe(false);
    expect(
      passesScoreFilters(meta, { trainable_min: 0.8, durability_min: 0.4 }),
    ).toBe(true);
  });

  it('classified: true requires classified_at to be set', () => {
    expect(passesScoreFilters({}, { classified: true })).toBe(false);
    expect(passesScoreFilters({ classified_at: 123 }, { classified: true })).toBe(true);
  });

  it('classified: false requires classified_at to NOT be set', () => {
    expect(passesScoreFilters({ classified_at: 123 }, { classified: false })).toBe(false);
    expect(passesScoreFilters({}, { classified: false })).toBe(true);
  });
});

describe('filters integration — typical ranking scenario', () => {
  it('produces a reasonable ordering over a mixed synthetic set', () => {
    const items = [
      { id: 'a', distance: 0.20, metadata: { salience: 0.5 } }, // close, low
      { id: 'b', distance: 0.25, metadata: { salience: 4.5 } }, // nearly-close, high
      { id: 'c', distance: 0.50, metadata: { salience: 4.9 } }, // far, very high
      { id: 'd', distance: 0.22, metadata: { salience: 2.5 } }, // close, medium
      { id: 'e', distance: 0.18, metadata: { promoted_to: 'training-v1', salience: 3.0 } },
    ];

    // Exclude promoted, rank by score
    const ranked = items
      .filter(i => passesPromotedFilter(i.metadata, false))
      .sort((x, y) =>
        rankScore(x.distance, x.metadata.salience) - rankScore(y.distance, y.metadata.salience),
      );

    // 'e' is filtered out entirely
    expect(ranked.find(r => r.id === 'e')).toBeUndefined();
    // 'b' (high salience) should beat 'a' (low salience, slightly closer)
    const posA = ranked.findIndex(r => r.id === 'a');
    const posB = ranked.findIndex(r => r.id === 'b');
    expect(posB).toBeLessThan(posA);
  });
});
