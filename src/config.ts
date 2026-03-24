function get(key: string, fallback: string = ''): string {
  return process.env[`YAPA_${key}`]
    ?? process.env[key]
    ?? fallback;
}

// ChromaDB
export const CHROMA_URL = get('CHROMA_URL', 'http://localhost:8000');

// Embedding settings
export type EmbeddingProvider = 'chromadb' | 'fireworks' | 'openai' | 'voyage' | 'ollama';
export const EMBEDDING_PROVIDER = get('EMBEDDING_PROVIDER', 'chromadb') as EmbeddingProvider;
export const EMBEDDING_MODEL = get('EMBEDDING_MODEL', '');
export const FIREWORKS_API_KEY = get('FIREWORKS_API_KEY');
export const OPENAI_API_KEY = get('OPENAI_API_KEY');
export const VOYAGE_API_KEY = get('VOYAGE_API_KEY');
export const OLLAMA_URL = get('OLLAMA_URL', 'http://localhost:11434');

// Lifecycle constants
export const SALIENCE_START = 1.0;
export const SALIENCE_BOOST_ON_ACCESS = 0.1;
export const SALIENCE_DECAY_RATE = parseFloat(get('SALIENCE_DECAY_RATE', '0.98'));
export const SALIENCE_FLOOR = 0.05;
export const SALIENCE_MAX = 5.0;
export const DECAY_INTERVAL_MS = 86400000; // 24 hours

// Task management
export const USERNAME = get('USERNAME', 'user');

// Document chunking
export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 200;

// Remote sync
export const SYNC_ENABLED = get('SYNC_ENABLED', 'false') === 'true';
export const SYNC_DATABASE_URL = get('SYNC_DATABASE_URL', '');
export const SYNC_INTERVAL_MS = parseInt(get('SYNC_INTERVAL_MS', '300000'), 10); // 5 minutes
export const SYNC_SIMILARITY_THRESHOLD = parseFloat(get('SYNC_SIMILARITY_THRESHOLD', '0.95'));

// Embedding defaults per provider
export function getEmbeddingModel(): string {
  if (EMBEDDING_MODEL) return EMBEDDING_MODEL;
  switch (EMBEDDING_PROVIDER) {
    case 'fireworks': return 'nomic-ai/nomic-embed-text-v1';
    case 'openai': return 'text-embedding-3-small';
    case 'voyage': return 'voyage-3-lite';
    case 'ollama': return 'nomic-embed-text';
    case 'chromadb': return '';
    default: return '';
  }
}
