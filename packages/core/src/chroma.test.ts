import { describe, it, expect, vi, afterEach } from 'vitest';
import { toCosineDistance, queryDocuments } from './chroma.js';
import { setConfig, resetConfig, createConfig } from './config.js';

describe('toCosineDistance', () => {
  it('halves squared-L2 distances from legacy (unpinned) collections', () => {
    // Unit vectors at cosine similarity 0.8: ||a-b||^2 = 2 - 2*0.8 = 0.4; cosine distance = 0.2.
    expect(toCosineDistance(0.4, 'l2')).toBeCloseTo(0.2);
    expect(toCosineDistance(2.058, 'l2')).toBeCloseTo(1.029);
  });

  it('passes cosine and inner-product distances through', () => {
    expect(toCosineDistance(0.2, 'cosine')).toBe(0.2);
    expect(toCosineDistance(0.2, 'ip')).toBe(0.2);
  });
});

describe('queryDocuments (Chroma adapter)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetConfig();
  });

  it('returns raw metadata (no salience side effect) and cosine distances on legacy L2 collections', async () => {
    // Local embeddings would load a model; use an HTTP provider stub instead.
    setConfig(createConfig({ YAPA_EMBEDDING_PROVIDER: 'openai', YAPA_OPENAI_API_KEY: 'k' }));
    const fetchMock = vi.fn(async (url: string) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes('api.openai.com')) return json({ data: [{ embedding: [0.1, 0.2] }] });
      if (url.endsWith('/collections')) return json([{ id: 'c1', name: 'legacy', configuration_json: { hnsw: { space: 'l2' } } }]);
      if (url.endsWith('/query')) return json({ ids: [['m1']], documents: [['doc']], metadatas: [[{ salience: 2, type: 'memory' }]], distances: [[0.8]] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const [hit] = await queryDocuments('legacy', 'q');
    expect(hit.metadata.salience).toBe(2); // used to come back as 2.1 (then recall added +0.1 again)
    expect(hit.distance).toBeCloseTo(0.4);
  });
});
