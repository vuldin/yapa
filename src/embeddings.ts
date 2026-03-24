import {
  EMBEDDING_PROVIDER,
  FIREWORKS_API_KEY,
  OPENAI_API_KEY,
  VOYAGE_API_KEY,
  OLLAMA_URL,
  getEmbeddingModel,
} from './config.js';

/**
 * Generate embedding for a single text.
 * Returns null when using ChromaDB server-side embeddings (the server handles it).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (EMBEDDING_PROVIDER === 'chromadb') return null;
  const batch = await generateEmbeddingsBatch([text]);
  return batch![0];
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * Returns null when using ChromaDB server-side embeddings.
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  batchSize: number = 50,
): Promise<number[][] | null> {
  if (EMBEDDING_PROVIDER === 'chromadb') return null;

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

  switch (EMBEDDING_PROVIDER) {
    case 'fireworks':
      return fetchOpenAICompatible(
        'https://api.fireworks.ai/inference/v1/embeddings',
        FIREWORKS_API_KEY,
        model,
        texts,
      );
    case 'openai':
      return fetchOpenAICompatible(
        'https://api.openai.com/v1/embeddings',
        OPENAI_API_KEY,
        model,
        texts,
      );
    case 'voyage':
      return fetchVoyage(model, texts);
    case 'ollama':
      return fetchOllama(model, texts);
    default:
      throw new Error(`Unknown embedding provider: ${EMBEDDING_PROVIDER}`);
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
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
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
    const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
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
