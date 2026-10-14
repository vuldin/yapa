/**
 * Server-side query embedder: the same model, quantization and pooling the
 * clients use (`@yapa/core/local-embedder`), so query vectors are comparable
 * with stored ones. Every vector goes through the service's embedding check
 * (384 dims, finite, unit norm) before it reaches SQL.
 */
import { createLocalEmbedder } from '@yapa/core/local-embedder';
import { checkEmbedding } from '@yapa/service/lib';

export interface QueryEmbedder {
  embed(text: string): Promise<number[]>;
  /** True once the model is loaded (GET /health reports ready only then). */
  ready(): boolean;
}

export function createQueryEmbedder(opts: { cacheDir?: string; allowRemote: boolean }): QueryEmbedder & { warm(): Promise<void> } {
  const local = createLocalEmbedder({ cacheDir: opts.cacheDir, allowRemote: opts.allowRemote });
  let isReady = false;
  return {
    async embed(text: string): Promise<number[]> {
      return validated(await local.embed(text));
    },
    ready: () => isReady,
    async warm(): Promise<void> {
      validated(await local.embed('warm up'));
      isReady = true;
    },
  };
}

export function validated(v: number[]): number[] {
  const r = checkEmbedding(v);
  if (!r.ok) throw new Error(`embedder produced an invalid vector (${r.code})`);
  return r.vector;
}
