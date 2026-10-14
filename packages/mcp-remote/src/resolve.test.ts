import { describe, expect, it } from 'vitest';
import { inferCollection, normalizeName, resolveCollection } from './resolve.js';

const NAMES = [
  'customer-acme', 'customer-acme-ct', 'customer-acme-vw', 'customer-summit', 'customer-initech-labs',
  'customer-north-star-bank', 'customer-date', 'project-wasm-blog', 'project-yapa', 'customer-yapa',
];

describe('normalizeName', () => {
  it('keeps only lowercase letters and digits', () => {
    expect(normalizeName('Acme CT')).toBe('acmect');
    expect(normalizeName('acme-ct')).toBe('acmect');
  });
});

describe('resolveCollection', () => {
  it('accepts exact ids', () => {
    expect(resolveCollection('customer-acme-ct', NAMES)).toBe('customer-acme-ct');
  });
  it('accepts plain names, case and punctuation insensitive', () => {
    expect(resolveCollection('Acme CT', NAMES)).toBe('customer-acme-ct');
    expect(resolveCollection('acme', NAMES)).toBe('customer-acme');
    expect(resolveCollection('Initech Labs', NAMES)).toBe('customer-initech-labs');
    expect(resolveCollection('wasm blog', NAMES)).toBe('project-wasm-blog');
  });
  it('prefers the customer when customer-x and project-x both exist', () => {
    expect(resolveCollection('yapa', NAMES)).toBe('customer-yapa');
  });
  it('rejects unknown names with suggestions', () => {
    expect(() => resolveCollection('initech', NAMES)).toThrow(/customer-initech-labs/);
    expect(() => resolveCollection('nothing-like-it', NAMES)).toThrow(/collection_list/);
  });
});

describe('inferCollection', () => {
  it('finds a customer named in a question, including multi-word names', () => {
    expect(inferCollection("what do we know about Acme CT's shadow link DR project?", NAMES)).toBe('customer-acme-ct');
    expect(inferCollection('status update for initech labs', NAMES)).toBe('customer-initech-labs');
    expect(inferCollection('anything new at North Star Bank?', NAMES)).toBe('customer-north-star-bank');
    expect(inferCollection('acme-vw upgrade plan', NAMES)).toBe('customer-acme-vw');
  });
  it('prefers the longer name ("acme ct" over "acme")', () => {
    expect(inferCollection('acme ct consumer groups', NAMES)).toBe('customer-acme-ct');
  });
  it('infers nothing when several customers are named', () => {
    expect(inferCollection('compare acme ct and acme vw', NAMES)).toBeUndefined();
  });
  it('matches whole words only', () => {
    expect(inferCollection('please update the doc', NAMES)).toBeUndefined(); // "update" contains "date"
  });
  it('infers nothing for questions without a customer name', () => {
    expect(inferCollection('how do we size a cluster?', NAMES)).toBeUndefined();
  });
  it('can match an ordinary word that is also a customer (recall boosts, never filters)', () => {
    expect(inferCollection('what is on the summit agenda?', NAMES)).toBe('customer-summit');
  });
});
