import { homedir } from 'os';
import { join as pathJoin } from 'path';

// ---------------------------------------------------------------------------
// Static constants (not env-driven)
// ---------------------------------------------------------------------------

// Lifecycle constants
export const SALIENCE_START = 1.0;
export const SALIENCE_BOOST_ON_ACCESS = 0.1;
export const SALIENCE_FLOOR = 0.05;
export const SALIENCE_MAX = 5.0;
export const DECAY_INTERVAL_MS = 86400000; // 24 hours

// Document chunking
export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 200;

// ---------------------------------------------------------------------------
// Config-driven values
// ---------------------------------------------------------------------------

export type EmbeddingProvider = 'chromadb' | 'fireworks' | 'openai' | 'voyage' | 'ollama';
export type CurationLLMProvider = 'fireworks' | 'openai' | 'anthropic' | 'ollama';
export type TrainingBackendName = 'fireworks';

/**
 * Every env-driven YAPA setting, resolved once into an immutable snapshot.
 * Field names keep their historic SCREAMING_SNAKE shape so call sites read
 * exactly like the env vars they replace.
 */
export interface YapaConfig {
  // ChromaDB
  CHROMA_URL: string;

  // Embedding settings
  EMBEDDING_PROVIDER: EmbeddingProvider;
  EMBEDDING_MODEL: string;
  FIREWORKS_API_KEY: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  VOYAGE_API_KEY: string;
  OLLAMA_URL: string;

  // Lifecycle
  SALIENCE_DECAY_RATE: number;
  SALIENCE_RANKING_WEIGHT: number;

  // Task management
  USERNAME: string;

  // Contradiction detection
  CONTRADICTION_DISTANCE_THRESHOLD: number;
  CONTRADICTION_MAX_RESULTS: number;

  // Compaction
  COMPACTION_THRESHOLD: number;
  COMPACTION_MIN_GROUP_SIZE: number;
  COMPACTION_SIMILARITY_DISTANCE: number;

  // Curation (Phase 1)
  CURATION_ENABLED: boolean;
  CURATION_INTERVAL_MS: number;
  CURATION_LLM_PROVIDER: CurationLLMProvider;
  CURATION_MODEL: string;
  CURATION_BATCH_SIZE: number;

  // Bucket routing (Phase 2)
  SYSTEM_PROMPT_TRAINABLE_MIN: number;
  SYSTEM_PROMPT_DURABILITY_MIN: number;
  SYSTEM_PROMPT_GENERALIZABILITY_MIN: number;
  TRAINING_TRAINABLE_MIN: number;
  TRAINING_DURABILITY_MIN: number;
  TRAINING_GENERALIZABILITY_MIN: number;
  ARTIFACTS_DIR: string;

  // Training (Phase 3)
  TRAINING_BACKEND: TrainingBackendName;
  TRAINING_BASE_MODEL: string;
  TRAINING_FIRECTL_PATH: string;
  TRAINING_SYNTHESIS_MODEL: string;

  // Eval + per-memory verification (Phase 4)
  VERIFICATION_ENABLED: boolean;
  EVAL_HOLDOUT_FRACTION: number;
  EVAL_HOLDOUT_MIN: number;
  EVAL_MIN_IMPROVEMENT: number;
  VERIFICATION_ATTEMPTS_MAX: number;
  INFERENCE_BASE_URL: string;

  // Remote sync
  SYNC_ENABLED: boolean;
  SYNC_DATABASE_URL: string;
  SYNC_INTERVAL_MS: number;
  SYNC_SIMILARITY_THRESHOLD: number;
}

/** Read `YAPA_<key>` first, then bare `<key>`, then the fallback. */
function get(env: Record<string, string | undefined>, key: string, fallback: string = ''): string {
  return env[`YAPA_${key}`] ?? env[key] ?? fallback;
}

/**
 * Resolve a full config snapshot from an environment mapping (defaults to
 * `process.env`). Pure: no module state, safe to call for tests or to build
 * an explicit config for a host (e.g. the DSH plugin).
 */
export function createConfig(env: Record<string, string | undefined> = process.env): YapaConfig {
  return {
    CHROMA_URL: get(env, 'CHROMA_URL', 'http://localhost:8000'),

    EMBEDDING_PROVIDER: get(env, 'EMBEDDING_PROVIDER', 'chromadb') as EmbeddingProvider,
    EMBEDDING_MODEL: get(env, 'EMBEDDING_MODEL', ''),
    FIREWORKS_API_KEY: get(env, 'FIREWORKS_API_KEY'),
    OPENAI_API_KEY: get(env, 'OPENAI_API_KEY'),
    ANTHROPIC_API_KEY: get(env, 'ANTHROPIC_API_KEY'),
    VOYAGE_API_KEY: get(env, 'VOYAGE_API_KEY'),
    OLLAMA_URL: get(env, 'OLLAMA_URL', 'http://localhost:11434'),

    SALIENCE_DECAY_RATE: parseFloat(get(env, 'SALIENCE_DECAY_RATE', '0.98')),
    SALIENCE_RANKING_WEIGHT: parseFloat(get(env, 'SALIENCE_RANKING_WEIGHT', '0.3')),

    USERNAME: get(env, 'USERNAME', 'user'),

    CONTRADICTION_DISTANCE_THRESHOLD: parseFloat(get(env, 'CONTRADICTION_DISTANCE_THRESHOLD', '0.25')),
    CONTRADICTION_MAX_RESULTS: parseInt(get(env, 'CONTRADICTION_MAX_RESULTS', '3'), 10),

    COMPACTION_THRESHOLD: parseInt(get(env, 'COMPACTION_THRESHOLD', '50'), 10),
    COMPACTION_MIN_GROUP_SIZE: parseInt(get(env, 'COMPACTION_MIN_GROUP_SIZE', '3'), 10),
    COMPACTION_SIMILARITY_DISTANCE: parseFloat(get(env, 'COMPACTION_SIMILARITY_DISTANCE', '0.30')),

    CURATION_ENABLED: get(env, 'CURATION_ENABLED', 'false') === 'true',
    CURATION_INTERVAL_MS: parseInt(get(env, 'CURATION_INTERVAL_MS', '604800000'), 10), // 7 days
    CURATION_LLM_PROVIDER: get(env, 'CURATION_LLM_PROVIDER', 'anthropic') as CurationLLMProvider,
    CURATION_MODEL: get(env, 'CURATION_MODEL', ''),
    CURATION_BATCH_SIZE: parseInt(get(env, 'CURATION_BATCH_SIZE', '20'), 10),

    SYSTEM_PROMPT_TRAINABLE_MIN: parseFloat(get(env, 'SYSTEM_PROMPT_TRAINABLE_MIN', '0.5')),
    SYSTEM_PROMPT_DURABILITY_MIN: parseFloat(get(env, 'SYSTEM_PROMPT_DURABILITY_MIN', '0.7')),
    SYSTEM_PROMPT_GENERALIZABILITY_MIN: parseFloat(get(env, 'SYSTEM_PROMPT_GENERALIZABILITY_MIN', '0.5')),
    TRAINING_TRAINABLE_MIN: parseFloat(get(env, 'TRAINING_TRAINABLE_MIN', '0.7')),
    TRAINING_DURABILITY_MIN: parseFloat(get(env, 'TRAINING_DURABILITY_MIN', '0.8')),
    TRAINING_GENERALIZABILITY_MIN: parseFloat(get(env, 'TRAINING_GENERALIZABILITY_MIN', '0.7')),
    ARTIFACTS_DIR: get(env, 'ARTIFACTS_DIR', pathJoin(homedir(), '.yapa', 'artifacts')),

    TRAINING_BACKEND: get(env, 'TRAINING_BACKEND', 'fireworks') as TrainingBackendName,
    TRAINING_BASE_MODEL: get(env, 'TRAINING_BASE_MODEL', 'accounts/fireworks/models/qwen3-coder-30b-a3b-instruct'),
    TRAINING_FIRECTL_PATH: get(env, 'TRAINING_FIRECTL_PATH', 'firectl'),
    TRAINING_SYNTHESIS_MODEL: get(env, 'TRAINING_SYNTHESIS_MODEL', ''),

    VERIFICATION_ENABLED: get(env, 'VERIFICATION_ENABLED', 'false') === 'true',
    EVAL_HOLDOUT_FRACTION: parseFloat(get(env, 'EVAL_HOLDOUT_FRACTION', '0.15')),
    EVAL_HOLDOUT_MIN: parseInt(get(env, 'EVAL_HOLDOUT_MIN', '3'), 10),
    EVAL_MIN_IMPROVEMENT: parseFloat(get(env, 'EVAL_MIN_IMPROVEMENT', '0.0')),
    VERIFICATION_ATTEMPTS_MAX: parseInt(get(env, 'VERIFICATION_ATTEMPTS_MAX', '3'), 10),
    INFERENCE_BASE_URL: get(env, 'INFERENCE_BASE_URL', 'https://api.fireworks.ai/inference/v1'),

    SYNC_ENABLED: get(env, 'SYNC_ENABLED', 'false') === 'true',
    SYNC_DATABASE_URL: get(env, 'SYNC_DATABASE_URL', ''),
    SYNC_INTERVAL_MS: parseInt(get(env, 'SYNC_INTERVAL_MS', '300000'), 10), // 5 minutes
    SYNC_SIMILARITY_THRESHOLD: parseFloat(get(env, 'SYNC_SIMILARITY_THRESHOLD', '0.95')),
  };
}

// ---------------------------------------------------------------------------
// Active-config holder
//
// Library code reads `getConfig()` at call time (never at module scope), so a
// host can install a resolved config before use — or replace it later (e.g.
// the DSH plugin applying hot-reloaded settings). Default: lazy env snapshot,
// which preserves the historic process.env behavior of the MCP server.
// ---------------------------------------------------------------------------

let active: YapaConfig | undefined;

export function getConfig(): YapaConfig {
  active ??= createConfig();
  return active;
}

export function setConfig(config: YapaConfig): void {
  active = config;
}

/** Test hook: drop the installed config so the next read re-resolves env. */
export function resetConfig(): void {
  active = undefined;
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export function getCurationModel(config: YapaConfig = getConfig()): string {
  if (config.CURATION_MODEL) return config.CURATION_MODEL;
  switch (config.CURATION_LLM_PROVIDER) {
    case 'fireworks': return 'accounts/fireworks/models/qwen3-30b-a3b-instruct';
    case 'openai': return 'gpt-4.1-mini';
    case 'anthropic': return 'claude-haiku-4-5-20251001';
    case 'ollama': return 'llama3.1';
    default: return '';
  }
}

export function getEmbeddingModel(config: YapaConfig = getConfig()): string {
  if (config.EMBEDDING_MODEL) return config.EMBEDDING_MODEL;
  switch (config.EMBEDDING_PROVIDER) {
    case 'fireworks': return 'nomic-ai/nomic-embed-text-v1';
    case 'openai': return 'text-embedding-3-small';
    case 'voyage': return 'voyage-3-lite';
    case 'ollama': return 'nomic-embed-text';
    case 'chromadb': return '';
    default: return '';
  }
}

export function getSynthesisModel(config: YapaConfig = getConfig()): string {
  // Fall back to the curation model if no explicit synthesis model is set —
  // same provider, so we can reuse the existing API key.
  return config.TRAINING_SYNTHESIS_MODEL || getCurationModel(config);
}
