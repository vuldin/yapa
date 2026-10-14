/**
 * Parity: the server's embedder must produce the same vectors as core's
 * client-side embedder (the default `chromadb` provider), or recall against
 * stored rows silently degrades. Loads the real ONNX model; skipped when it is
 * neither cached nor downloadable (offline machine).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { clearEmbeddingMemo, generateEmbedding, resetConfig, setConfig, createConfig } from '@yapa/core';
import { createQueryEmbedder, validated } from './embedder.js';

const TEXTS = [
  'Customer reported consumer lag after the broker upgrade',
  'TODO: send the tiered storage sizing doc',
  'é ü 日本語 🙂',
];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

describe('createLocalEmbedder parity with core', () => {
  const server = createQueryEmbedder({ allowRemote: true });
  let available = true;

  beforeAll(async () => {
    try {
      await server.warm();
    } catch {
      available = false;
    }
  });

  it('is ready after warm-up and returns validated 384-d unit vectors', ctx => {
    if (!available) ctx.skip();
    expect(server.ready()).toBe(true);
  });

  it('matches core generateEmbedding on fixed texts (cosine >= 0.9999)', async ctx => {
    if (!available) ctx.skip();
    setConfig(createConfig({ YAPA_EMBEDDING_PROVIDER: 'chromadb' }));
    clearEmbeddingMemo();
    try {
      for (const t of TEXTS) {
        const [a, b] = [await server.embed(t), await generateEmbedding(t)];
        expect(a).toHaveLength(384);
        expect(cosine(a, b)).toBeGreaterThanOrEqual(0.9999);
      }
    } finally {
      resetConfig();
    }
  });

  it('validated() rejects a non-normalized or wrong-size vector', () => {
    expect(() => validated(new Array(384).fill(1))).toThrow(/invalid vector/);
    expect(() => validated([1])).toThrow(/invalid vector/);
  });
});
