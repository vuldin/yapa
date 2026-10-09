import { describe, it, expect, vi, afterEach } from 'vitest';
import { setConfig, resetConfig, createConfig } from './config.js';
import { generateEmbedding, clearEmbeddingMemo } from './embeddings.js';

afterEach(() => {
  vi.unstubAllGlobals();
  clearEmbeddingMemo();
  resetConfig();
});

describe('generateEmbedding memo', () => {
  it('embeds a repeated query once (cross-collection search hits every collection)', async () => {
    setConfig(createConfig({ YAPA_EMBEDDING_PROVIDER: 'openai', YAPA_OPENAI_API_KEY: 'k' }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.6, 0.8] }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all(Array.from({ length: 45 }, () => generateEmbedding('same query')));
    expect(results.every(r => r[0] === 0.6)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await generateEmbedding('different query');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    setConfig(createConfig({ YAPA_EMBEDDING_PROVIDER: 'openai', YAPA_OPENAI_API_KEY: 'k' }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateEmbedding('flaky')).rejects.toThrow();
    expect(await generateEmbedding('flaky')).toEqual([1, 0]);
  });
});
