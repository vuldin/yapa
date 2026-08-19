/**
 * @yapa/core — everything a host (MCP server, DSH plugin, CLI) needs:
 * memory, tasks, collections, journal, compaction, curation, buckets,
 * training/eval, sync, config.
 *
 * @module @yapa/core
 */

// Config: YapaConfig, createConfig, getConfig/setConfig/resetConfig, helpers,
// static lifecycle constants, provider types.
export * from './config.js';

// ChromaDB document store + embeddings.
export * from './chroma.js';
export * from './embeddings.js';
export * from './chunking.js';
export * from './lifecycle.js';
export * from './metadata-adapter.js';

// Memory subsystem.
export * from './memory/store.js';
export * from './memory/recall.js';
export * from './memory/forget.js';
export * from './memory/list.js';
export * from './memory/decay.js';
export * from './memory/compact.js';
export * from './memory/journal.js';
export * from './memory/filters.js';

// Tasks.
export * from './tasks/create.js';
export * from './tasks/list.js';
export * from './tasks/update.js';
export * from './tasks/search.js';
export * from './tasks/delete.js';
export * from './tasks/dependencies.js';
export * from './tasks/dates.js';

// Collections.
export * from './collections/manage.js';

// Curation (LLM classifier).
export * from './curation/index.js';
export * from './curation/classifier.js';
export * from './curation/provider.js';
export * from './curation/prompts.js';

// Bucket routing (system-prompt companion + training manifest).
export * from './buckets/index.js';
export * from './buckets/artifacts.js';
export * from './buckets/router.js';
export * from './buckets/system-prompt.js';
export * from './buckets/training-manifest.js';

// Remote sync (Postgres + pgvector).
export * from './sync/index.js';
export * from './sync/postgres.js';
export * from './sync/pull.js';
export * from './sync/push.js';
export * from './sync/deletes.js';
export * from './sync/sentinel.js';
export * from './sync/schema.js';

// Training / eval / promotion.
export * from './training/index.js';
export * from './training/backend.js';
export * from './training/eval.js';
export * from './training/fireworks.js';
export * from './training/holdout.js';
export * from './training/inference.js';
export * from './training/judge.js';
export * from './training/promotion.js';
export * from './training/registry.js';
export * from './training/synthesis.js';
export * from './training/verification.js';
