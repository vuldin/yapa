import { homedir } from 'os';
import { join as pathJoin } from 'path';

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
export const ANTHROPIC_API_KEY = get('ANTHROPIC_API_KEY');
export const VOYAGE_API_KEY = get('VOYAGE_API_KEY');
export const OLLAMA_URL = get('OLLAMA_URL', 'http://localhost:11434');

// Lifecycle constants
export const SALIENCE_START = 1.0;
export const SALIENCE_BOOST_ON_ACCESS = 0.1;
export const SALIENCE_DECAY_RATE = parseFloat(get('SALIENCE_DECAY_RATE', '0.98'));
export const SALIENCE_FLOOR = 0.05;
export const SALIENCE_MAX = 5.0;
export const DECAY_INTERVAL_MS = 86400000; // 24 hours
// Retrieval ranking: score = distance - (WEIGHT * normalized_salience).
// Higher weight = salience matters more relative to semantic distance.
export const SALIENCE_RANKING_WEIGHT = parseFloat(get('SALIENCE_RANKING_WEIGHT', '0.3'));

// Task management
export const USERNAME = get('USERNAME', 'user');

// Document chunking
export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 200;

// Curation (Phase 1) — LLM-backed classifier that scores memories on
// trainable / durability / generalizability (each 0.0-1.0).
export const CURATION_ENABLED = get('CURATION_ENABLED', 'false') === 'true';
export const CURATION_INTERVAL_MS = parseInt(get('CURATION_INTERVAL_MS', '604800000'), 10); // 7 days
export type CurationLLMProvider = 'fireworks' | 'openai' | 'anthropic' | 'ollama';
export const CURATION_LLM_PROVIDER = get('CURATION_LLM_PROVIDER', 'anthropic') as CurationLLMProvider;
export const CURATION_MODEL = get('CURATION_MODEL', '');
export const CURATION_BATCH_SIZE = parseInt(get('CURATION_BATCH_SIZE', '20'), 10);

export function getCurationModel(): string {
  if (CURATION_MODEL) return CURATION_MODEL;
  switch (CURATION_LLM_PROVIDER) {
    case 'fireworks': return 'accounts/fireworks/models/qwen3-30b-a3b-instruct';
    case 'openai': return 'gpt-4.1-mini';
    case 'anthropic': return 'claude-haiku-4-5-20251001';
    case 'ollama': return 'llama3.1';
    default: return '';
  }
}

// Bucket routing (Phase 2) — thresholds used to decide which memories
// are routed to the system-prompt companion vs. the training manifest.
// A memory is routed to a bucket when it meets ALL three score minima
// for that bucket.
export const SYSTEM_PROMPT_TRAINABLE_MIN = parseFloat(get('SYSTEM_PROMPT_TRAINABLE_MIN', '0.5'));
export const SYSTEM_PROMPT_DURABILITY_MIN = parseFloat(get('SYSTEM_PROMPT_DURABILITY_MIN', '0.7'));
export const SYSTEM_PROMPT_GENERALIZABILITY_MIN = parseFloat(get('SYSTEM_PROMPT_GENERALIZABILITY_MIN', '0.5'));
export const TRAINING_TRAINABLE_MIN = parseFloat(get('TRAINING_TRAINABLE_MIN', '0.7'));
export const TRAINING_DURABILITY_MIN = parseFloat(get('TRAINING_DURABILITY_MIN', '0.8'));
export const TRAINING_GENERALIZABILITY_MIN = parseFloat(get('TRAINING_GENERALIZABILITY_MIN', '0.7'));

// Artifact storage location for versioned system-prompt companions and
// training manifests. Defaults to ~/.yapa/artifacts.
export const ARTIFACTS_DIR = get('ARTIFACTS_DIR', pathJoin(homedir(), '.yapa', 'artifacts'));

// Training (Phase 3) — LoRA fine-tune submission.
export type TrainingBackendName = 'fireworks';
export const TRAINING_BACKEND = get('TRAINING_BACKEND', 'fireworks') as TrainingBackendName;
export const TRAINING_BASE_MODEL = get(
  'TRAINING_BASE_MODEL',
  'accounts/fireworks/models/qwen3-coder-30b-a3b-instruct',
);
export const TRAINING_FIRECTL_PATH = get('TRAINING_FIRECTL_PATH', 'firectl');
export const TRAINING_SYNTHESIS_MODEL = get('TRAINING_SYNTHESIS_MODEL', '');
export function getSynthesisModel(): string {
  // Fall back to the curation model if no explicit synthesis model is set —
  // same provider, so we can reuse the existing API key.
  return TRAINING_SYNTHESIS_MODEL || getCurationModel();
}

// Eval + per-memory verification (Phase 4)
export const VERIFICATION_ENABLED = get('VERIFICATION_ENABLED', 'false') === 'true';
export const EVAL_HOLDOUT_FRACTION = parseFloat(get('EVAL_HOLDOUT_FRACTION', '0.15'));
export const EVAL_HOLDOUT_MIN = parseInt(get('EVAL_HOLDOUT_MIN', '3'), 10);
export const EVAL_MIN_IMPROVEMENT = parseFloat(get('EVAL_MIN_IMPROVEMENT', '0.0'));
export const VERIFICATION_ATTEMPTS_MAX = parseInt(get('VERIFICATION_ATTEMPTS_MAX', '3'), 10);

// Fireworks OpenAI-compatible chat completions endpoint used to query a
// trained adapter during eval and verification.
export const INFERENCE_BASE_URL = get(
  'INFERENCE_BASE_URL',
  'https://api.fireworks.ai/inference/v1',
);

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
