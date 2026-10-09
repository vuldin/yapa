import { getConfig, getEmbeddingModel } from './config.js';

// Lazy-loaded local embedding pipeline (MiniLM-L6-v2, 384 dims)
let localPipeline: any = null;

async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline, env } = await import('@huggingface/transformers');
    if (getConfig().MODEL_CACHE_DIR) env.cacheDir = getConfig().MODEL_CACHE_DIR;
    // q8 is the same quantized ONNX model the previous embedder
    // (chromadb-default-embed) loaded by default, so stored vectors stay valid.
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
  }
  return localPipeline;
}

async function embedLocal(text: string): Promise<number[]> {
  const pipe = await getLocalPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Small memo of recent single-text embeddings (promises, so concurrent callers
// share one computation). A cross-collection search queries every collection
// with the same text; without this each query re-embedded it.
const MEMO_MAX = 64;
const memo = new Map<string, Promise<number[]>>();

/**
 * Generate embedding for a single text.
 */
export function generateEmbedding(text: string): Promise<number[]> {
  const key = `${getConfig().EMBEDDING_PROVIDER}\u0000${getEmbeddingModel()}\u0000${text}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key); // refresh LRU position
    memo.set(key, hit);
    return hit;
  }
  const work = (getConfig().EMBEDDING_PROVIDER === 'chromadb'
    ? embedLocal(text)
    : generateEmbeddingsBatch([text]).then(batch => batch[0]));
  memo.set(key, work);
  work.catch(() => memo.delete(key)); // never cache failures
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return work;
}

/** Test hook: drop memoized embeddings. */
export function clearEmbeddingMemo(): void {
  memo.clear();
}

/**
 * Generate embeddings for multiple texts.
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  batchSize: number = 50,
): Promise<number[][]> {
  if (getConfig().EMBEDDING_PROVIDER === 'chromadb') {
    return Promise.all(texts.map(embedLocal));
  }

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await callEmbeddingAPI(batch);
    results.push(...batchResults);
  }
  return results;
}

async function callEmbeddingAPI(texts: string[]): Promise<number[][]> {
  const model = getEmbeddingModel();

  switch (getConfig().EMBEDDING_PROVIDER) {
    case 'fireworks':
      return fetchOpenAICompatible(
        'https://api.fireworks.ai/inference/v1/embeddings',
        getConfig().FIREWORKS_API_KEY,
        model,
        texts,
      );
    case 'openai':
      return fetchOpenAICompatible(
        'https://api.openai.com/v1/embeddings',
        getConfig().OPENAI_API_KEY,
        model,
        texts,
      );
    case 'voyage':
      return fetchVoyage(model, texts);
    case 'ollama':
      return fetchOllama(model, texts);
    default:
      throw new Error(`Unknown embedding provider: ${getConfig().EMBEDDING_PROVIDER}`);
  }
}

async function fetchOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  input: string[],
): Promise<number[][]> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  return data.data.map((d: any) => d.embedding);
}

async function fetchVoyage(model: string, input: string[]): Promise<number[][]> {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getConfig().VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });

  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status} ${await response.text()}`);
  }

  const data: any = await response.json();
  return data.data.map((d: any) => d.embedding);
}

async function fetchOllama(model: string, texts: string[]): Promise<number[][]> {
  // Ollama doesn't support batch, so we call individually
  const results: number[][] = [];
  for (const text of texts) {
    const response = await fetch(`${getConfig().OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
    }

    const data: any = await response.json();
    results.push(data.embedding);
  }
  return results;
}
