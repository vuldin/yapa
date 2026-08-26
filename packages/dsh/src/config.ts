/**
 * Plugin configuration and resolution into a core `YapaConfig`.
 *
 * Resolution order (lowest to highest precedence):
 *   1. environment (`YAPA_*` / bare env vars, via `createConfig`)
 *   2. this plugin's cordis `Config` (the profile's cordis.patch.yml row)
 *   3. the hot-reloaded `yapa` settings namespace (`$DSH_HOME/settings.yaml`)
 *
 * @module yapa/config
 */
import z from '@deepseek-ai/schemastery';
import { createConfig, type YapaConfig } from '@yapa/core';

/** User-facing plugin configuration (cordis patch row + settings namespace). */
export interface Config {
  /** Storage backend: 'chroma' (ChromaDB server) or 'local' (embedded JSON store, no server). */
  storage?: 'chroma' | 'local';
  /** Root directory for the embedded store (default: ~/.local/share/yapa/store). */
  localStorePath?: string;
  /** ChromaDB base URL. */
  chromaUrl?: string;
  /** Username used for task ID prefixes. */
  username?: string;
  /** Embedding provider selection (chromadb = in-process MiniLM, zero-config). */
  embeddingProvider?: 'chromadb' | 'fireworks' | 'openai' | 'voyage' | 'ollama';
  embeddingModel?: string;
  fireworksApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  voyageApiKey?: string;
  ollamaUrl?: string;
  /** Remote sync (PostgreSQL + pgvector). */
  syncEnabled?: boolean;
  syncDatabaseUrl?: string;
  syncIntervalMs?: number;
  /** Absolute workspace roots used for collection detection from session cwd. */
  projectRoots?: string[];
  /** Inject semantic recall into prompt assembly on new human prompts. */
  injectRecall?: boolean;
  /** Inject open tasks into prompt assembly once per scope per session. */
  injectTasks?: boolean;
  /** Number of memories recalled per injection. */
  recallResults?: number;
  /** Hard cap on injected context size. */
  maxContextBytes?: number;
  /** Consolidate journal drafts when a session is disposed. */
  autoJournalConsolidate?: boolean;
  /** Run the salience decay sweep on plugin activation (if due). */
  decayOnStartup?: boolean;
  /** Provider route for auxiliary LLM calls (curation/synthesis/judge). Default: harness default model. */
  auxProvider?: string;
  /** Model for auxiliary LLM calls. Default: harness default model. */
  auxModel?: string;
  /** Bridge due-dated tasks into schedule_create reminders (when the schedule plugin is loaded). */
  scheduleBridge?: boolean;
  /** Store harness compaction summaries as memories before history is replaced. */
  captureCompaction?: boolean;
  /** Run the aux-LLM extractor over each completed turn and auto-store durable findings. */
  captureResponses?: boolean;
  /** Minimum combined user+assistant characters in a turn before extraction runs. */
  captureMinChars?: number;
  /** Hard cap on memories auto-stored per turn. */
  captureMaxMemories?: number;
  /** Salience ceiling for auto-captured memories (agent-stored memories are uncapped). */
  captureMaxSalience?: number;
  /** Below this cosine distance, an extracted candidate goes to the conflict resolver. */
  captureDedupeDistance?: number;
  /** Run the daily contradiction sweep over existing memories (conservative resolver). */
  janitorEnabled?: boolean;
  /** Max duplicate pairs judged per janitor sweep. */
  janitorMaxPairs?: number;
  /** Render promoted system-prompt memories as a live prompt section. */
  promotedSection?: boolean;
  /** Register the `yapa-standup` skill. */
  standupSkill?: boolean;
  /** Gate destructive/costly yapa_* tools behind the harness approval prompt (ask-mode sessions). */
  approvalGate?: boolean;
}

export const Config: z<Config> = z.object({
  storage: z.union([z.const('chroma'), z.const('local')]),
  localStorePath: z.string(),
  chromaUrl: z.string(),
  username: z.string(),
  embeddingProvider: z.union([
    z.const('chromadb'), z.const('fireworks'), z.const('openai'),
    z.const('voyage'), z.const('ollama'),
  ]),
  embeddingModel: z.string(),
  fireworksApiKey: z.string(),
  openaiApiKey: z.string(),
  anthropicApiKey: z.string(),
  voyageApiKey: z.string(),
  ollamaUrl: z.string(),
  syncEnabled: z.boolean(),
  syncDatabaseUrl: z.string(),
  syncIntervalMs: z.number(),
  projectRoots: z.array(z.string()),
  injectRecall: z.boolean(),
  injectTasks: z.boolean(),
  recallResults: z.number(),
  maxContextBytes: z.number(),
  autoJournalConsolidate: z.boolean(),
  decayOnStartup: z.boolean(),
  auxProvider: z.string(),
  auxModel: z.string(),
  scheduleBridge: z.boolean(),
  captureCompaction: z.boolean(),
  captureResponses: z.boolean(),
  captureMinChars: z.number(),
  captureMaxMemories: z.number(),
  captureMaxSalience: z.number(),
  captureDedupeDistance: z.number(),
  janitorEnabled: z.boolean(),
  janitorMaxPairs: z.number(),
  promotedSection: z.boolean(),
  standupSkill: z.boolean(),
  approvalGate: z.boolean(),
});

/** Defaults for the plugin's own (non-core) knobs. */
export const PLUGIN_DEFAULTS = {
  projectRoots: [] as string[],
  injectRecall: true,
  injectTasks: true,
  recallResults: 3,
  maxContextBytes: 6000,
  autoJournalConsolidate: true,
  decayOnStartup: true,
  scheduleBridge: true,
  captureCompaction: true,
  captureResponses: true,
  captureMinChars: 280,
  captureMaxMemories: 3,
  captureMaxSalience: 2.0,
  captureDedupeDistance: 0.25,
  janitorEnabled: true,
  janitorMaxPairs: 20,
  promotedSection: true,
  standupSkill: true,
  approvalGate: true,
};

/** Resolved runtime view: the core config plus plugin-only knobs. */
export interface ResolvedConfig {
  core: YapaConfig;
  projectRoots: string[];
  injectRecall: boolean;
  injectTasks: boolean;
  recallResults: number;
  maxContextBytes: number;
  autoJournalConsolidate: boolean;
  decayOnStartup: boolean;
  scheduleBridge: boolean;
  captureCompaction: boolean;
  captureResponses: boolean;
  captureMinChars: number;
  captureMaxMemories: number;
  captureMaxSalience: number;
  captureDedupeDistance: number;
  janitorEnabled: boolean;
  janitorMaxPairs: number;
  promotedSection: boolean;
  standupSkill: boolean;
  approvalGate: boolean;
}

/**
 * Merge env → plugin config → settings override into one resolved view.
 * Any field left undefined at every layer falls back to the env-derived
 * (or built-in) default.
 */
export function resolveConfig(plugin: Config, settings?: Partial<Config>): ResolvedConfig {
  const merged: Config = { ...plugin, ...Object.fromEntries(
    Object.entries(settings ?? {}).filter(([, v]) => v !== undefined),
  ) };
  const envBase = createConfig();
  const core: YapaConfig = {
    ...envBase,
    ...(merged.storage !== undefined && { STORAGE: merged.storage }),
    ...(merged.localStorePath !== undefined && { LOCAL_STORE_PATH: merged.localStorePath }),
    ...(merged.chromaUrl !== undefined && { CHROMA_URL: merged.chromaUrl }),
    ...(merged.username !== undefined && { USERNAME: merged.username }),
    ...(merged.embeddingProvider !== undefined && { EMBEDDING_PROVIDER: merged.embeddingProvider }),
    ...(merged.embeddingModel !== undefined && { EMBEDDING_MODEL: merged.embeddingModel }),
    ...(merged.fireworksApiKey !== undefined && { FIREWORKS_API_KEY: merged.fireworksApiKey }),
    ...(merged.openaiApiKey !== undefined && { OPENAI_API_KEY: merged.openaiApiKey }),
    ...(merged.anthropicApiKey !== undefined && { ANTHROPIC_API_KEY: merged.anthropicApiKey }),
    ...(merged.voyageApiKey !== undefined && { VOYAGE_API_KEY: merged.voyageApiKey }),
    ...(merged.ollamaUrl !== undefined && { OLLAMA_URL: merged.ollamaUrl }),
    ...(merged.syncEnabled !== undefined && { SYNC_ENABLED: merged.syncEnabled }),
    ...(merged.syncDatabaseUrl !== undefined && { SYNC_DATABASE_URL: merged.syncDatabaseUrl }),
    ...(merged.syncIntervalMs !== undefined && { SYNC_INTERVAL_MS: merged.syncIntervalMs }),
  };
  return {
    core,
    projectRoots: merged.projectRoots ?? PLUGIN_DEFAULTS.projectRoots,
    injectRecall: merged.injectRecall ?? PLUGIN_DEFAULTS.injectRecall,
    injectTasks: merged.injectTasks ?? PLUGIN_DEFAULTS.injectTasks,
    recallResults: merged.recallResults ?? PLUGIN_DEFAULTS.recallResults,
    maxContextBytes: merged.maxContextBytes ?? PLUGIN_DEFAULTS.maxContextBytes,
    autoJournalConsolidate: merged.autoJournalConsolidate ?? PLUGIN_DEFAULTS.autoJournalConsolidate,
    decayOnStartup: merged.decayOnStartup ?? PLUGIN_DEFAULTS.decayOnStartup,
    scheduleBridge: merged.scheduleBridge ?? PLUGIN_DEFAULTS.scheduleBridge,
    captureCompaction: merged.captureCompaction ?? PLUGIN_DEFAULTS.captureCompaction,
    captureResponses: merged.captureResponses ?? PLUGIN_DEFAULTS.captureResponses,
    captureMinChars: merged.captureMinChars ?? PLUGIN_DEFAULTS.captureMinChars,
    captureMaxMemories: merged.captureMaxMemories ?? PLUGIN_DEFAULTS.captureMaxMemories,
    captureMaxSalience: merged.captureMaxSalience ?? PLUGIN_DEFAULTS.captureMaxSalience,
    captureDedupeDistance: merged.captureDedupeDistance ?? PLUGIN_DEFAULTS.captureDedupeDistance,
    janitorEnabled: merged.janitorEnabled ?? PLUGIN_DEFAULTS.janitorEnabled,
    janitorMaxPairs: merged.janitorMaxPairs ?? PLUGIN_DEFAULTS.janitorMaxPairs,
    promotedSection: merged.promotedSection ?? PLUGIN_DEFAULTS.promotedSection,
    standupSkill: merged.standupSkill ?? PLUGIN_DEFAULTS.standupSkill,
    approvalGate: merged.approvalGate ?? PLUGIN_DEFAULTS.approvalGate,
  };
}
