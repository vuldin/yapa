import { describe, it, expect, afterEach } from 'vitest';
import { setConfig, resetConfig, createConfig, SALIENCE_FLOOR, SALIENCE_MAX } from './config.js';
import { touchDocument, applyDecay, decayFactor } from './lifecycle.js';

const base = { salience: 2, accessed_at: 0, created_at: 0, sector: 'episodic' as const };
const NOON = 20_000 * 86400 + 43_200; // a fixed UTC day

afterEach(() => resetConfig());

describe('touchDocument', () => {
  it('boosts by 0.1 and records the access', () => {
    const t = touchDocument(base, NOON);
    expect(t.salience).toBeCloseTo(2.1);
    expect(t.accessed_at).toBe(NOON);
    expect(t).toMatchObject({ boost_day: 20_000, boosts_today: 1 });
  });

  it('caps boosts per memory per UTC day, then resets the next day', () => {
    let m: any = base;
    for (let i = 0; i < 10; i++) m = touchDocument(m, NOON + i);
    expect(m.salience).toBeCloseTo(2.3); // 3 boosts, not 10
    expect(m.accessed_at).toBe(NOON + 9); // still records the access
    m = touchDocument(m, NOON + 86400);
    expect(m.salience).toBeCloseTo(2.4);
  });

  it('never exceeds the max', () => {
    expect(touchDocument({ ...base, salience: SALIENCE_MAX }, NOON).salience).toBe(SALIENCE_MAX);
  });

  it('honors YAPA_SALIENCE_MAX_BOOSTS_PER_DAY', () => {
    setConfig(createConfig({ YAPA_SALIENCE_MAX_BOOSTS_PER_DAY: '1' }));
    const twice = touchDocument(touchDocument(base, NOON), NOON + 1);
    expect(twice.salience).toBeCloseTo(2.1);
  });
});

describe('applyDecay', () => {
  it('decays by elapsed days, not per call', () => {
    expect(applyDecay(base, 30).salience).toBeCloseTo(2 * 0.98 ** 30);
    // 30 one-day steps == one 30-day step
    let m: any = base;
    for (let i = 0; i < 30; i++) m = applyDecay(m, 1);
    expect(m.salience).toBeCloseTo(applyDecay(base, 30).salience);
  });

  it('decays semantic memories at half the rate (twice the half-life)', () => {
    const episodicHalfLife = Math.log(0.5) / Math.log(0.98);
    expect(decayFactor('episodic', episodicHalfLife)).toBeCloseTo(0.5);
    expect(decayFactor('semantic', 2 * episodicHalfLife)).toBeCloseTo(0.5);
  });

  it('clamps at the floor and ignores negative elapsed time', () => {
    expect(applyDecay(base, 10_000).salience).toBe(SALIENCE_FLOOR);
    expect(applyDecay(base, -5).salience).toBe(2);
  });
});
