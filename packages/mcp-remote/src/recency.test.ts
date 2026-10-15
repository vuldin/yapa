import { describe, expect, it } from 'vitest';
import { isTemporal, recencyBonus } from './tools.js';

const NOW = 2_000_000_000;
const DAY = 86400;

describe('isTemporal', () => {
  it('spots questions about what is recent', () => {
    for (const q of [
      'details from most recent meeting with acme', 'latest acme update', "what's new with acme?",
      'acme news', 'what happened at acme this week', 'notes from the last call', 'anything from yesterday?',
    ]) expect(isTemporal(q)).toBe(true);
  });
  it('leaves topic questions alone', () => {
    for (const q of ['acme shadow link setup', 'how do we size a cluster?', 'tell me about acme consumer groups']) {
      expect(isTemporal(q)).toBe(false);
    }
  });
});

describe('recencyBonus', () => {
  it('is mild by default and strong for temporal questions, fading with age', () => {
    const mild = { now: NOW, temporal: false };
    const strong = { now: NOW, temporal: true };
    expect(recencyBonus(NOW, mild)).toBeCloseTo(0.05);
    expect(recencyBonus(NOW, strong)).toBeCloseTo(0.3);
    expect(recencyBonus(NOW - 14 * DAY, strong)).toBeCloseTo(0.3 / Math.E);
    expect(recencyBonus(NOW - 90 * DAY, strong)).toBeLessThan(0.001);
    expect(recencyBonus(NOW + DAY, strong)).toBeCloseTo(0.3); // clock skew never exceeds the max
  });
});
