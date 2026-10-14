/**
 * Config-free local embedder: Xenova/all-MiniLM-L6-v2, q8 ONNX, mean pooling,
 * L2-normalized, 384 dimensions. embeddings.ts uses it for the default
 * `chromadb` provider; server hosts (packages/mcp-remote) use it directly so
 * their vectors match what clients store. Exported as `@yapa/core/local-embedder`,
 * which pulls in nothing else from core.
 *
 * Note: @huggingface/transformers keeps its settings in one global `env`, so
 * the options below apply process-wide.
 */

export const LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_EMBEDDING_DTYPE = 'q8';
export const LOCAL_EMBEDDING_DIMS = 384;

export interface LocalEmbedderOptions {
  /** Model cache directory (transformers `env.cacheDir`). Unset keeps the library default. */
  cacheDir?: string;
  /**
   * false: never download; the model must already be in `cacheDir` (a
   * container with the weights baked in). Unset keeps the library default.
   */
  allowRemote?: boolean;
}

export interface LocalEmbedder {
  embed(text: string): Promise<number[]>;
  /** Load the model now instead of on the first embed. */
  warm(): Promise<void>;
}

export function createLocalEmbedder(opts: LocalEmbedderOptions = {}): LocalEmbedder {
  let pipe: Promise<any> | null = null;

  const load = (): Promise<any> => {
    if (!pipe) {
      pipe = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        if (opts.cacheDir) env.cacheDir = opts.cacheDir;
        if (opts.allowRemote !== undefined) env.allowRemoteModels = opts.allowRemote;
        // Offline: also look the model up as a local path (same layout as the cache).
        if (opts.allowRemote === false && opts.cacheDir) env.localModelPath = opts.cacheDir;
        // q8 is the same quantized ONNX model the previous embedder
        // (chromadb-default-embed) loaded by default, so stored vectors stay valid.
        return pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL, { dtype: LOCAL_EMBEDDING_DTYPE });
      })();
      pipe.catch(() => { pipe = null; }); // retry on the next call after a failed load
    }
    return pipe;
  };

  return {
    async embed(text: string): Promise<number[]> {
      const p = await load();
      const output = await p(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data as ArrayLike<number>);
    },
    async warm(): Promise<void> {
      await load();
    },
  };
}
