import { describe, it, expect } from 'vitest';
import { metadataDelta } from './index.js';

describe('metadataDelta', () => {
  it('names changed and added keys, and removed ones as null', () => {
    expect(metadataDelta({ a: 1, b: [1, 2], c: 'x', d: null }, { a: 1, b: [1, 2, 3], e: true, d: null })).toEqual({ b: [1, 2, 3], e: true, c: null });
    expect(metadataDelta({ a: 1 }, { a: 1 })).toEqual({});
  });
});
