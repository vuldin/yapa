#!/usr/bin/env node
import { createRequire as __yapaCreateRequire } from 'node:module'; const require = __yapaCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/core/src/sync/syncable.ts
function isSyncableCollection(name) {
  return name !== "global" && !name.startsWith("private-") && !name.startsWith("local-");
}
function looksPrivateButShared(name) {
  return isSyncableCollection(name) && /^(private|privat|privte|prvate|priv|prv|local|locl|lcoal)[-_]/i.test(name);
}
function isDeletedUpstream(metadata) {
  return metadata?.deleted_upstream_at != null && metadata.deleted_upstream_at !== "";
}
function isReadOnlyDoc(metadata) {
  return metadata?.read_only === true;
}
function assertWritable(id, metadata) {
  if (isReadOnlyDoc(metadata)) throw new Error(`${id} is read-only: owned by the remote service`);
}
var init_syncable = __esm({
  "packages/core/src/sync/syncable.ts"() {
    "use strict";
  }
});

// packages/core/src/config.ts
import { homedir as homedir2, tmpdir, userInfo } from "os";
import path, { join as pathJoin } from "path";
function list(value) {
  return value.split(/[,:]/).map((v) => v.trim()).filter(Boolean);
}
function splitCollectionMap(value) {
  return value.split(/[;\n]/).map((v) => v.trim()).filter(Boolean);
}
function warnOnce(message2) {
  if (warned.has(message2)) return;
  warned.add(message2);
  process.stderr.write(`[yapa] ${message2}
`);
}
function normalizeCollectionMap(entries, pathImpl = path) {
  const out = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    const dir = eq < 0 ? "" : entry.slice(0, eq).trim().replace(/^~(?=[\\/]|$)/, homedir2());
    const collection = eq < 0 ? "" : entry.slice(eq + 1).trim();
    if (!dir || !collection) {
      warnOnce(`collection_map: ignoring "${entry}" (expected path=collection; separate entries with ";")`);
      continue;
    }
    if (!pathImpl.isAbsolute(dir)) {
      warnOnce(`collection_map: ignoring "${entry}" (the path must be absolute or start with ~)`);
      continue;
    }
    if (looksPrivateButShared(collection)) {
      warnOnce(`collection_map: "${collection}" is a shared collection name and syncs; local-only names start with lowercase "private-" or "local-"`);
    }
    out.push(`${pathImpl.resolve(dir)}=${collection}`);
  }
  return out;
}
function get(env, key, fallback = "") {
  const pick = (v) => v === void 0 || v === "" ? void 0 : v;
  return pick(env[`YAPA_${key}`]) ?? pick(env[key]) ?? fallback;
}
function osUsername() {
  try {
    return userInfo().username || "user";
  } catch {
    return "user";
  }
}
function createConfig(env = process.env) {
  return {
    STORAGE: get(env, "STORAGE", "chroma"),
    CHROMA_URL: get(env, "CHROMA_URL", "http://localhost:8000"),
    LOCAL_STORE_PATH: get(env, "LOCAL_STORE_PATH", pathJoin(homedir2(), ".local", "share", "yapa", "store")),
    EMBEDDING_PROVIDER: get(env, "EMBEDDING_PROVIDER", "chromadb"),
    EMBEDDING_MODEL: get(env, "EMBEDDING_MODEL", ""),
    MODEL_CACHE_DIR: get(env, "MODEL_CACHE_DIR", ""),
    FIREWORKS_API_KEY: get(env, "FIREWORKS_API_KEY"),
    OPENAI_API_KEY: get(env, "OPENAI_API_KEY"),
    ANTHROPIC_API_KEY: get(env, "ANTHROPIC_API_KEY"),
    VOYAGE_API_KEY: get(env, "VOYAGE_API_KEY"),
    OLLAMA_URL: get(env, "OLLAMA_URL", "http://localhost:11434"),
    SALIENCE_DECAY_RATE: parseFloat(get(env, "SALIENCE_DECAY_RATE", "0.98")),
    DELETED_RETENTION_DAYS: Math.max(0, Number(get(env, "DELETED_RETENTION_DAYS", "30")) || 30),
    // 0.15 on cosine distances keeps the historic balance of 0.3 on the 2x
    // squared-L2 distances legacy Chroma collections reported.
    SALIENCE_RANKING_WEIGHT: parseFloat(get(env, "SALIENCE_RANKING_WEIGHT", "0.15")),
    SALIENCE_BOOST_MAX_DISTANCE: parseFloat(get(env, "SALIENCE_BOOST_MAX_DISTANCE", "0.5")),
    SALIENCE_MAX_BOOSTS_PER_DAY: parseInt(get(env, "SALIENCE_MAX_BOOSTS_PER_DAY", "3"), 10),
    CROSS_COLLECTION_RESULTS: parseInt(get(env, "CROSS_COLLECTION_RESULTS", "2"), 10),
    CROSS_COLLECTION_MAX_DISTANCE: parseFloat(get(env, "CROSS_COLLECTION_MAX_DISTANCE", "0.45")),
    // Bare USERNAME is deliberately not consulted: on Windows it's the OS login
    // already, and elsewhere it's often unset. Default = the OS login name.
    USERNAME: env.YAPA_USERNAME || osUsername(),
    PROJECT_ROOTS: list(get(env, "PROJECT_ROOTS", "")).map((r) => r.replace(/^~(?=\/|$)/, homedir2()).replace(/\/+$/, "")),
    CUSTOMERS: list(get(env, "CUSTOMERS", "")),
    COLLECTION_MAP: normalizeCollectionMap(splitCollectionMap(get(env, "COLLECTION_MAP", ""))),
    CONTRADICTION_DISTANCE_THRESHOLD: parseFloat(get(env, "CONTRADICTION_DISTANCE_THRESHOLD", "0.25")),
    CONTRADICTION_MAX_RESULTS: parseInt(get(env, "CONTRADICTION_MAX_RESULTS", "3"), 10),
    COMPACTION_THRESHOLD: parseInt(get(env, "COMPACTION_THRESHOLD", "50"), 10),
    COMPACTION_MIN_GROUP_SIZE: parseInt(get(env, "COMPACTION_MIN_GROUP_SIZE", "3"), 10),
    COMPACTION_SIMILARITY_DISTANCE: parseFloat(get(env, "COMPACTION_SIMILARITY_DISTANCE", "0.30")),
    CURATION_ENABLED: get(env, "CURATION_ENABLED", "false") === "true",
    TRAINING_PIPELINE: get(env, "TRAINING_PIPELINE", "false") === "true",
    CURATION_INTERVAL_MS: parseInt(get(env, "CURATION_INTERVAL_MS", "604800000"), 10),
    // 7 days
    CURATION_LLM_PROVIDER: get(env, "CURATION_LLM_PROVIDER", "anthropic"),
    CURATION_MODEL: get(env, "CURATION_MODEL", ""),
    CURATION_BATCH_SIZE: parseInt(get(env, "CURATION_BATCH_SIZE", "20"), 10),
    SYSTEM_PROMPT_TRAINABLE_MIN: parseFloat(get(env, "SYSTEM_PROMPT_TRAINABLE_MIN", "0.5")),
    SYSTEM_PROMPT_DURABILITY_MIN: parseFloat(get(env, "SYSTEM_PROMPT_DURABILITY_MIN", "0.7")),
    SYSTEM_PROMPT_GENERALIZABILITY_MIN: parseFloat(get(env, "SYSTEM_PROMPT_GENERALIZABILITY_MIN", "0.5")),
    TRAINING_TRAINABLE_MIN: parseFloat(get(env, "TRAINING_TRAINABLE_MIN", "0.7")),
    TRAINING_DURABILITY_MIN: parseFloat(get(env, "TRAINING_DURABILITY_MIN", "0.8")),
    TRAINING_GENERALIZABILITY_MIN: parseFloat(get(env, "TRAINING_GENERALIZABILITY_MIN", "0.7")),
    ARTIFACTS_DIR: get(env, "ARTIFACTS_DIR", pathJoin(homedir2(), ".yapa", "artifacts")),
    TRAINING_BACKEND: get(env, "TRAINING_BACKEND", "fireworks"),
    TRAINING_BASE_MODEL: get(env, "TRAINING_BASE_MODEL", "accounts/fireworks/models/qwen3-coder-30b-a3b-instruct"),
    TRAINING_FIRECTL_PATH: get(env, "TRAINING_FIRECTL_PATH", "firectl"),
    TRAINING_SYNTHESIS_MODEL: get(env, "TRAINING_SYNTHESIS_MODEL", ""),
    VERIFICATION_ENABLED: get(env, "VERIFICATION_ENABLED", "false") === "true",
    EVAL_HOLDOUT_FRACTION: parseFloat(get(env, "EVAL_HOLDOUT_FRACTION", "0.15")),
    EVAL_HOLDOUT_MIN: parseInt(get(env, "EVAL_HOLDOUT_MIN", "3"), 10),
    EVAL_MIN_IMPROVEMENT: parseFloat(get(env, "EVAL_MIN_IMPROVEMENT", "0.0")),
    VERIFICATION_ATTEMPTS_MAX: parseInt(get(env, "VERIFICATION_ATTEMPTS_MAX", "3"), 10),
    INFERENCE_BASE_URL: get(env, "INFERENCE_BASE_URL", "https://api.fireworks.ai/inference/v1"),
    SYNC_ENABLED: get(env, "SYNC_ENABLED", "false") === "true",
    SYNC_SERVICE_URL: get(env, "SYNC_SERVICE_URL", "").replace(/\/+$/, ""),
    SYNC_ID_TOKEN_CMD: get(env, "SYNC_ID_TOKEN_CMD", ""),
    SYNC_MCP_URL: get(env, "SYNC_MCP_URL", "").trim(),
    SYNC_MCP_TOKEN_CMD: get(env, "SYNC_MCP_TOKEN_CMD", ""),
    SYNC_MCP_TOOL: get(env, "SYNC_MCP_TOOL", "").trim(),
    SYNC_ID_TOKEN_CACHE: /* @__PURE__ */ ((v) => v === "off" ? "" : v)(get(env, "SYNC_ID_TOKEN_CACHE", pathJoin(homedir2(), ".local", "share", "yapa", "id-token"))),
    // Not recorded under vitest unless a test names a file: suites that fail
    // sync on purpose must not paint the developer's own status line red.
    SYNC_HEALTH_FILE: /* @__PURE__ */ ((v) => v === "off" ? "" : v)(get(env, "SYNC_HEALTH_FILE", process.env.VITEST ? "" : pathJoin(homedir2(), ".local", "share", "yapa", "sync-health.json"))),
    STATUS_LABEL: get(env, "STATUS_LABEL", "yapa").trim().slice(0, 32) || "yapa",
    // The old option replaced the word yapa; any name it set other than yapa is the remote's.
    REMOTE_NAME: (get(env, "REMOTE_NAME", "").trim() || /* @__PURE__ */ ((l) => l && l !== "yapa" ? l : "")(get(env, "STATUS_LABEL", "").trim())).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 32),
    STATUSLINE: get(env, "STATUSLINE", process.env.VITEST ? "false" : "true") !== "false",
    UPDATE_CHECK: get(env, "UPDATE_CHECK", process.env.VITEST ? "false" : "true") !== "false",
    UPDATE_SOURCE: get(env, "UPDATE_SOURCE", "https://raw.githubusercontent.com/vuldin/yapa/main/plugin/.claude-plugin/plugin.json"),
    SYNC_HTTP_TIMEOUT_MS: parseInt(get(env, "SYNC_HTTP_TIMEOUT_MS", "15000"), 10),
    SYNC_DATABASE_URL: get(env, "SYNC_DATABASE_URL", ""),
    SYNC_INTERVAL_MS: parseInt(get(env, "SYNC_INTERVAL_MS", "300000"), 10),
    // 5 minutes
    SYNC_SIMILARITY_THRESHOLD: parseFloat(get(env, "SYNC_SIMILARITY_THRESHOLD", "0.95")),
    DEVICE_ID: get(env, "DEVICE_ID", ""),
    DEVICE_ID_PATH: get(env, "DEVICE_ID_PATH", pathJoin(homedir2(), ".local", "share", "yapa", "device-id")),
    // Under vitest, never the developer's real lease markers and claim notices.
    LEASE_STATE_DIR: get(env, "LEASE_STATE_DIR", process.env.VITEST ? pathJoin(tmpdir(), `yapa-test-leases-${process.pid}`) : pathJoin(homedir2(), ".local", "share", "yapa", "leases")),
    LOCAL_COORD_DIR: get(env, "LOCAL_COORD_DIR", process.env.VITEST ? pathJoin(tmpdir(), `yapa-test-coord-${process.pid}`) : pathJoin(homedir2(), ".local", "share", "yapa", "coord")),
    SYNC_PULL_OVERLAP_SECONDS: parseInt(get(env, "SYNC_PULL_OVERLAP_SECONDS", "120"), 10),
    SYNC_PUSH_DEBOUNCE_MS: parseInt(get(env, "SYNC_PUSH_DEBOUNCE_MS", "2000"), 10),
    SYNC_COORDINATE: get(env, "SYNC_COORDINATE", "true") !== "false",
    SYNC_CA_CERT: get(env, "SYNC_CA_CERT", ""),
    HOOK_PULL_TIMEOUT_MS: parseInt(get(env, "HOOK_PULL_TIMEOUT_MS", "4000"), 10),
    HOOK_PULL_WINDOW_MS: parseInt(get(env, "HOOK_PULL_WINDOW_MS", "30000"), 10),
    HOOK_INJECT_RULES: get(env, "HOOK_INJECT_RULES", "false") === "true",
    RESPONSE_CAPTURE: get(env, "RESPONSE_CAPTURE", "true") !== "false",
    CAPTURE_MIN_CHARS: parseInt(get(env, "CAPTURE_MIN_CHARS", "280"), 10),
    CAPTURE_MAX_MEMORIES: parseInt(get(env, "CAPTURE_MAX_MEMORIES", "3"), 10),
    CAPTURE_MAX_SALIENCE: parseFloat(get(env, "CAPTURE_MAX_SALIENCE", "2.0")),
    CAPTURE_DEDUPE_DISTANCE: parseFloat(get(env, "CAPTURE_DEDUPE_DISTANCE", "0.25")),
    CAPTURE_COMPACTION: get(env, "CAPTURE_COMPACTION", "true") === "true"
  };
}
function getConfig() {
  active ??= createConfig();
  return active;
}
function setConfig(config) {
  active = config;
}
function resetConfig() {
  active = void 0;
}
function getCurationModel(config = getConfig()) {
  if (config.CURATION_MODEL) return config.CURATION_MODEL;
  switch (config.CURATION_LLM_PROVIDER) {
    case "fireworks":
      return "accounts/fireworks/models/qwen3-30b-a3b-instruct";
    case "openai":
      return "gpt-4.1-mini";
    case "anthropic":
      return "claude-haiku-4-5-20251001";
    case "ollama":
      return "llama3.1";
    case "claude-cli":
      return "haiku";
    default:
      return "";
  }
}
function getEmbeddingModel(config = getConfig()) {
  if (config.EMBEDDING_MODEL) return config.EMBEDDING_MODEL;
  switch (config.EMBEDDING_PROVIDER) {
    case "fireworks":
      return "nomic-ai/nomic-embed-text-v1";
    case "openai":
      return "text-embedding-3-small";
    case "voyage":
      return "voyage-3-lite";
    case "ollama":
      return "nomic-embed-text";
    case "chromadb":
      return "";
    default:
      return "";
  }
}
function getSynthesisModel(config = getConfig()) {
  return config.TRAINING_SYNTHESIS_MODEL || getCurationModel(config);
}
var SALIENCE_START, SALIENCE_BOOST_ON_ACCESS, SALIENCE_FLOOR, SALIENCE_MAX, DECAY_INTERVAL_MS, CHUNK_SIZE, CHUNK_OVERLAP, warned, active;
var init_config = __esm({
  "packages/core/src/config.ts"() {
    "use strict";
    init_syncable();
    SALIENCE_START = 1;
    SALIENCE_BOOST_ON_ACCESS = 0.1;
    SALIENCE_FLOOR = 0.05;
    SALIENCE_MAX = 5;
    DECAY_INTERVAL_MS = 864e5;
    CHUNK_SIZE = 2e3;
    CHUNK_OVERLAP = 200;
    warned = /* @__PURE__ */ new Set();
  }
});

// packages/core/src/metadata-adapter.ts
function toChroma(metadata) {
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === void 0) {
      continue;
    } else if (Array.isArray(value)) {
      result[key] = value.some((v) => typeof v !== "string" || v.includes(",") || v.startsWith("[")) ? JSON.stringify(value) : value.join(",");
    } else if (typeof value === "object") {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
function fromChroma(metadata) {
  const result = {};
  const arrayFields = ["tags", "depends_on", "blocks", "related_ids", "claim_scope", "task_ids", "memory_ids", "waits_on", "options", "disposition_ids"];
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      if (value.startsWith("{") || value.startsWith("[")) {
        try {
          result[key] = JSON.parse(value);
          continue;
        } catch {
        }
      }
      if (arrayFields.includes(key)) {
        if (value === "") {
          result[key] = [];
        } else if (value.includes(",")) {
          result[key] = value.split(",").filter((s) => s);
        } else {
          result[key] = [value];
        }
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}
var init_metadata_adapter = __esm({
  "packages/core/src/metadata-adapter.ts"() {
    "use strict";
  }
});

// packages/core/src/local-embedder.ts
function createLocalEmbedder(opts = {}) {
  let pipe = null;
  const load2 = () => {
    if (!pipe) {
      pipe = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        if (opts.cacheDir) env.cacheDir = opts.cacheDir;
        if (opts.allowRemote !== void 0) env.allowRemoteModels = opts.allowRemote;
        if (opts.allowRemote === false && opts.cacheDir) env.localModelPath = opts.cacheDir;
        return pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL, { dtype: LOCAL_EMBEDDING_DTYPE });
      })();
      pipe.catch(() => {
        pipe = null;
      });
    }
    return pipe;
  };
  return {
    async embed(text) {
      const p = await load2();
      const output = await p(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    },
    async warm() {
      await load2();
    }
  };
}
var LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_DTYPE;
var init_local_embedder = __esm({
  "packages/core/src/local-embedder.ts"() {
    "use strict";
    LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
    LOCAL_EMBEDDING_DTYPE = "q8";
  }
});

// packages/core/src/embeddings.ts
async function embedLocal(text) {
  if (!localEmbedder) localEmbedder = createLocalEmbedder({ cacheDir: getConfig().MODEL_CACHE_DIR || void 0 });
  return localEmbedder.embed(text);
}
function generateEmbedding(text) {
  const key = `${getConfig().EMBEDDING_PROVIDER}\0${getEmbeddingModel()}\0${text}`;
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const work = getConfig().EMBEDDING_PROVIDER === "chromadb" ? embedLocal(text) : generateEmbeddingsBatch([text]).then((batch) => batch[0]);
  memo.set(key, work);
  work.catch(() => memo.delete(key));
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return work;
}
function clearEmbeddingMemo() {
  memo.clear();
}
async function generateEmbeddingsBatch(texts, batchSize = 50) {
  if (getConfig().EMBEDDING_PROVIDER === "chromadb") {
    return Promise.all(texts.map(embedLocal));
  }
  const results = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await callEmbeddingAPI(batch);
    results.push(...batchResults);
  }
  return results;
}
async function callEmbeddingAPI(texts) {
  const model = getEmbeddingModel();
  switch (getConfig().EMBEDDING_PROVIDER) {
    case "fireworks":
      return fetchOpenAICompatible(
        "https://api.fireworks.ai/inference/v1/embeddings",
        getConfig().FIREWORKS_API_KEY,
        model,
        texts
      );
    case "openai":
      return fetchOpenAICompatible(
        "https://api.openai.com/v1/embeddings",
        getConfig().OPENAI_API_KEY,
        model,
        texts
      );
    case "voyage":
      return fetchVoyage(model, texts);
    case "ollama":
      return fetchOllama(model, texts);
    default:
      throw new Error(`Unknown embedding provider: ${getConfig().EMBEDDING_PROVIDER}`);
  }
}
async function fetchOpenAICompatible(url, apiKey, model, input2) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input: input2 })
  });
  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.data.map((d) => d.embedding);
}
async function fetchVoyage(model, input2) {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getConfig().VOYAGE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input: input2 })
  });
  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.data.map((d) => d.embedding);
}
async function fetchOllama(model, texts) {
  const results = [];
  for (const text of texts) {
    const response = await fetch(`${getConfig().OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text })
    });
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    results.push(data.embedding);
  }
  return results;
}
var localEmbedder, MEMO_MAX, memo;
var init_embeddings = __esm({
  "packages/core/src/embeddings.ts"() {
    "use strict";
    init_config();
    init_local_embedder();
    localEmbedder = null;
    MEMO_MAX = 64;
    memo = /* @__PURE__ */ new Map();
  }
});

// packages/core/src/chroma.ts
function apiBase() {
  return `${getConfig().CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database`;
}
async function detectChromaVersion() {
  try {
    const v2Heartbeat = await fetch(`${getConfig().CHROMA_URL}/api/v2/heartbeat`);
    if (!v2Heartbeat.ok) {
      try {
        const v1Check = await fetch(`${getConfig().CHROMA_URL}/api/v1/heartbeat`);
        if (v1Check.ok) {
          return {
            version: "1.x (legacy)",
            isV2: false,
            error: "ChromaDB v1 API detected. YAPA requires ChromaDB v2 API. Please upgrade ChromaDB to version 0.4.0 or higher (or 1.0.0+)."
          };
        }
      } catch {
      }
      return {
        version: "unknown",
        isV2: false,
        error: "ChromaDB is not responding. Ensure ChromaDB is running at " + getConfig().CHROMA_URL
      };
    }
    let version = "unknown";
    try {
      const versionResp = await fetch(`${getConfig().CHROMA_URL}/api/v2/version`);
      if (versionResp.ok) {
        const data = await versionResp.json();
        version = data.version || "unknown";
      }
    } catch {
    }
    return { version, isV2: true };
  } catch (e) {
    return {
      version: "unreachable",
      isV2: false,
      error: `Cannot connect to ChromaDB at ${getConfig().CHROMA_URL}. Ensure ChromaDB is running.`
    };
  }
}
function buildChromaFilter(filter) {
  const entries = Object.entries(filter).filter(([_, v]) => v !== void 0 && v !== null);
  if (entries.length === 0) return {};
  if (entries.length === 1) {
    const [key, value] = entries[0];
    return { [key]: value };
  }
  return {
    $and: entries.map(([key, value]) => ({ [key]: value }))
  };
}
function toCosineDistance(distance, space) {
  return space === "l2" ? distance / 2 : distance;
}
function spaceOf(collection) {
  return collection?.configuration_json?.hnsw?.space ?? collection?.metadata?.["hnsw:space"] ?? "l2";
}
async function chromaFetch(path3, init) {
  const response = await fetch(`${apiBase()}${path3}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  return response;
}
async function getCollectionId(name) {
  if (collectionIdCache.has(name)) {
    return collectionIdCache.get(name);
  }
  const response = await chromaFetch("/collections");
  if (!response.ok) throw new Error(`Failed to list collections: ${response.status}`);
  const collections = await response.json();
  const match = collections.find((c) => c.name === name);
  if (!match) throw new Error(`Collection '${name}' not found`);
  collectionIdCache.set(name, match.id);
  collectionSpaceCache.set(name, spaceOf(match));
  return match.id;
}
async function getOrCreateCollection(name) {
  try {
    return await getCollectionId(name);
  } catch {
    await createCollection(name);
    collectionIdCache.delete(name);
    return await getCollectionId(name);
  }
}
async function addDocument(collectionName, id, content, metadata) {
  const collectionId = await getOrCreateCollection(collectionName);
  const embedding = await generateEmbedding(content);
  const adaptedMetadata = toChroma(metadata);
  const body = {
    ids: [id],
    documents: [content],
    metadatas: [adaptedMetadata]
  };
  if (embedding) body.embeddings = [embedding];
  const response = await chromaFetch(`/collections/${collectionId}/upsert`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Failed to add document: ${response.status} - ${await response.text()}`);
  }
}
async function addDocumentsBatch(collectionName, documents) {
  const collectionId = await getOrCreateCollection(collectionName);
  const embeddings = await generateEmbeddingsBatch(documents.map((d) => d.content));
  const adaptedMetadatas = documents.map((d) => toChroma(d.metadata));
  const body = {
    ids: documents.map((d) => d.id),
    documents: documents.map((d) => d.content),
    metadatas: adaptedMetadatas
  };
  if (embeddings) body.embeddings = embeddings;
  const response = await chromaFetch(`/collections/${collectionId}/upsert`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Failed to add documents batch: ${response.status} - ${await response.text()}`);
  }
}
async function queryDocuments(collectionName, queryText, nResults = 5, filter) {
  const collectionId = await getCollectionId(collectionName);
  const embedding = await generateEmbedding(queryText);
  const body = {
    n_results: nResults,
    include: ["documents", "metadatas", "distances"]
  };
  if (embedding) {
    body.query_embeddings = [embedding];
  } else {
    body.query_texts = [queryText];
  }
  if (filter) {
    const where = buildChromaFilter(filter);
    if (Object.keys(where).length > 0) body.where = where;
  }
  const response = await chromaFetch(`/collections/${collectionId}/query`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Query failed: ${response.status} - ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.ids[0]?.length) return [];
  return data.ids[0].map((id, i) => {
    const metadata = fromChroma(data.metadatas[0][i]);
    return {
      id,
      content: data.documents[0][i],
      metadata,
      distance: toCosineDistance(data.distances[0][i], collectionSpaceCache.get(collectionName))
    };
  });
}
async function getDocumentsByFilter(collectionName, filter, limit = 100) {
  const collectionId = await getCollectionId(collectionName);
  const body = {
    limit,
    include: ["documents", "metadatas"]
  };
  const where = buildChromaFilter(filter);
  if (Object.keys(where).length > 0) body.where = where;
  const response = await chromaFetch(`/collections/${collectionId}/get`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Get by filter failed: ${response.status} - ${await response.text()}`);
  }
  const data = await response.json();
  return data.ids.map((id, i) => ({
    id,
    content: data.documents[i],
    metadata: fromChroma(data.metadatas[i])
  }));
}
async function getDocumentsByIds(collectionName, ids) {
  const collectionId = await getCollectionId(collectionName);
  const response = await chromaFetch(`/collections/${collectionId}/get`, {
    method: "POST",
    body: JSON.stringify({
      ids,
      include: ["documents", "metadatas"]
    })
  });
  if (!response.ok) {
    throw new Error(`Get by IDs failed: ${response.status} - ${await response.text()}`);
  }
  const data = await response.json();
  return data.ids.map((id, i) => ({
    id,
    content: data.documents[i],
    metadata: fromChroma(data.metadatas[i])
  }));
}
async function updateDocument(collectionName, id, metadata) {
  const collectionId = await getCollectionId(collectionName);
  const response = await chromaFetch(`/collections/${collectionId}/update`, {
    method: "POST",
    body: JSON.stringify({
      ids: [id],
      metadatas: [toChroma(metadata)]
    })
  });
  if (!response.ok) {
    throw new Error(`Update failed: ${response.status} - ${await response.text()}`);
  }
}
async function patchDocuments(collectionName, entries) {
  if (entries.length === 0) return;
  const collectionId = await getCollectionId(collectionName);
  const existing = new Set((await getDocumentsByIds(collectionName, entries.map((e) => e.id))).map((d) => d.id));
  const live = entries.filter((e) => existing.has(e.id));
  if (live.length === 0) return;
  const response = await chromaFetch(`/collections/${collectionId}/update`, {
    method: "POST",
    body: JSON.stringify({
      ids: live.map((e) => e.id),
      metadatas: live.map((e) => {
        const removed = Object.fromEntries(Object.entries(e.patch).filter(([, v]) => v === null || v === void 0).map(([k]) => [k, null]));
        return { ...toChroma(e.patch), ...removed };
      })
    })
  });
  if (!response.ok) {
    throw new Error(`Patch failed: ${response.status} - ${await response.text()}`);
  }
}
async function updateDocumentsBatch(collectionName, entries) {
  if (entries.length === 0) return;
  const collectionId = await getCollectionId(collectionName);
  const response = await chromaFetch(`/collections/${collectionId}/update`, {
    method: "POST",
    body: JSON.stringify({
      ids: entries.map((e) => e.id),
      metadatas: entries.map((e) => toChroma(e.metadata))
    })
  });
  if (!response.ok) {
    throw new Error(`Batch update failed: ${response.status} - ${await response.text()}`);
  }
}
async function deleteDocument(collectionName, id) {
  const collectionId = await getCollectionId(collectionName);
  const response = await chromaFetch(`/collections/${collectionId}/delete`, {
    method: "POST",
    body: JSON.stringify({ ids: [id] })
  });
  if (!response.ok) {
    throw new Error(`Failed to delete document: ${response.status} - ${await response.text()}`);
  }
}
async function listCollections() {
  const response = await chromaFetch("/collections");
  if (!response.ok) throw new Error(`Failed to list collections: ${response.status}`);
  return await response.json();
}
async function createCollection(name, metadata = { created: (/* @__PURE__ */ new Date()).toISOString() }) {
  const response = await chromaFetch("/collections", {
    method: "POST",
    body: JSON.stringify({
      name,
      metadata: toChroma(metadata),
      configuration: { hnsw: { space: "cosine" } }
    })
  });
  if (!response.ok) {
    throw new Error(`Failed to create collection: ${response.status} - ${await response.text()}`);
  }
  collectionIdCache.delete(name);
  collectionSpaceCache.delete(name);
}
async function deleteCollection(name) {
  const response = await chromaFetch(`/collections/${encodeURIComponent(name)}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error(`Failed to delete collection: ${response.status} - ${await response.text()}`);
  }
  collectionIdCache.delete(name);
  collectionSpaceCache.delete(name);
}
async function getCollectionCount(name) {
  const collectionId = await getCollectionId(name);
  const response = await chromaFetch(`/collections/${collectionId}/count`, {
    method: "GET"
  });
  if (!response.ok) {
    throw new Error(`Failed to get count: ${response.status}`);
  }
  return await response.json();
}
async function queryAllCollections(queryText, nResults = 5, filter) {
  const collections = await listCollections();
  const allResults = await Promise.all(
    collections.map(async (collection) => {
      try {
        const results = await queryDocuments(collection.name, queryText, nResults, filter);
        return results.map((r) => ({ ...r, collection: collection.name }));
      } catch {
        return [];
      }
    })
  );
  return allResults.flat().sort((a, b) => a.distance - b.distance).slice(0, nResults);
}
async function findAndDeleteDocument(id) {
  const collections = await listCollections();
  for (const collection of collections) {
    try {
      const results = await getDocumentsByIds(collection.name, [id]);
      if (results.length > 0) {
        await deleteDocument(collection.name, id);
        return collection.name;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Document '${id}' not found in any collection`);
}
var collectionIdCache, collectionSpaceCache;
var init_chroma = __esm({
  "packages/core/src/chroma.ts"() {
    "use strict";
    init_config();
    init_metadata_adapter();
    init_embeddings();
    collectionIdCache = /* @__PURE__ */ new Map();
    collectionSpaceCache = /* @__PURE__ */ new Map();
  }
});

// packages/core/src/store/chroma-adapter.ts
var chromaStore;
var init_chroma_adapter = __esm({
  "packages/core/src/store/chroma-adapter.ts"() {
    "use strict";
    init_chroma();
    chromaStore = {
      kind: "chroma",
      listCollections: () => listCollections(),
      createCollection: (name, metadata) => createCollection(name, metadata),
      deleteCollection: (name) => deleteCollection(name),
      getCollectionCount: (name) => getCollectionCount(name),
      getOrCreateCollection: (name) => getOrCreateCollection(name),
      addDocument: (col, id, content, metadata) => addDocument(col, id, content, metadata),
      addDocumentsBatch: (col, docs) => addDocumentsBatch(col, docs),
      queryDocuments: (col, q, n, filter) => queryDocuments(col, q, n, filter),
      queryAllCollections: (q, n, filter) => queryAllCollections(q, n, filter),
      getDocumentsByFilter: (col, filter, limit) => getDocumentsByFilter(col, filter, limit),
      getDocumentsByIds: (col, ids) => getDocumentsByIds(col, ids),
      updateDocument: (col, id, metadata) => updateDocument(col, id, metadata),
      updateDocumentsBatch: (col, entries) => updateDocumentsBatch(col, entries),
      patchDocuments: (col, entries) => patchDocuments(col, entries),
      deleteDocument: (col, id) => deleteDocument(col, id),
      findAndDeleteDocument: (id) => findAndDeleteDocument(id)
    };
  }
});

// packages/core/src/fs-lock.ts
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync as readFileSync2, readlinkSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join as join2 } from "node:path";
function pidNamespace() {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function writeJsonAtomic(path3, value, mode = 384) {
  mkdirSync(dirname(path3), { recursive: true, mode: 448 });
  const tmp = `${path3}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      writeSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path3);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
function readState(lock) {
  let fd;
  try {
    fd = openSync(lock, "r");
  } catch {
    return void 0;
  }
  try {
    const st = fstatSync(fd);
    let holder;
    try {
      const h = JSON.parse(readFileSync2(fd, "utf-8"));
      if (h && typeof h.pid === "number" && typeof h.at === "number") holder = { pid: h.pid, host: String(h.host ?? ""), at: h.at };
    } catch {
    }
    return { ino: st.ino, mtimeMs: st.mtimeMs, holder };
  } finally {
    closeSync(fd);
  }
}
function tryCreate(lock) {
  const me = { pid: process.pid, host: HOST, at: Date.now() };
  let fd;
  try {
    fd = openSync(lock, "wx", 384);
  } catch (e) {
    if (e.code === "EEXIST") return void 0;
    if (e.code === "ENOENT") {
      mkdirSync(dirname(lock), { recursive: true, mode: 448 });
      return tryCreate(lock);
    }
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(me));
  } finally {
    closeSync(fd);
  }
  return me;
}
function stale(s, rules, now) {
  if (!s.holder) return now - s.mtimeMs > UNREADABLE_GRACE_MS;
  const h = s.holder;
  if (h.at - now > rules.staleMs) return true;
  if (h.host === HOST) return !pidAlive(h.pid) || now - h.at > rules.maxHoldMs;
  return now - h.at > rules.staleMs;
}
function breakStale(lock, judged, rules) {
  const guard = `${lock}.break`;
  const me = tryCreate(guard);
  if (!me) {
    const g = readState(guard);
    if (g && stale(g, { staleMs: BREAK_GUARD_STALE_MS, maxHoldMs: BREAK_GUARD_STALE_MS }, Date.now())) rmIfSame(guard, g);
    return false;
  }
  try {
    const now = readState(lock);
    if (now && sameState(now, judged) && stale(now, rules, Date.now())) rmSync(lock, { force: true });
    return true;
  } finally {
    releaseIfMine(guard, me);
  }
}
function rmIfSame(path3, s) {
  const now = readState(path3);
  if (now && sameState(now, s)) rmSync(path3, { force: true });
}
function releaseIfMine(lock, me) {
  const h = readState(lock)?.holder;
  if (h && h.pid === me.pid && h.at === me.at && h.host === me.host) rmSync(lock, { force: true });
}
function attempt(lock, rules) {
  const me = tryCreate(lock);
  if (me) return { me };
  const s = readState(lock);
  if (!s) return {};
  if (stale(s, rules, Date.now()) && breakStale(lock, s, rules)) {
    const again = tryCreate(lock);
    if (again) return { me: again };
  }
  return { holder: s.holder };
}
async function withFileLock(lock, fn, opts = {}) {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const rules = { staleMs: opts.staleMs ?? DEFAULT_STALE_MS, maxHoldMs: opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS };
  const deadline = Date.now() + waitMs;
  let holder;
  for (let i = 0; ; i++) {
    const a = attempt(lock, rules);
    if (a.me) {
      try {
        return await fn();
      } finally {
        releaseIfMine(lock, a.me);
      }
    }
    holder = a.holder;
    if (Date.now() >= deadline) throw new LockTimeoutError(lock, holder);
    await sleep(backoff(i));
  }
}
function withFileLockSync(lock, fn, opts = {}) {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const rules = { staleMs: opts.staleMs ?? DEFAULT_STALE_MS, maxHoldMs: opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS };
  const deadline = Date.now() + waitMs;
  let holder;
  for (let i = 0; ; i++) {
    const a = attempt(lock, rules);
    if (a.me) {
      try {
        return fn();
      } finally {
        releaseIfMine(lock, a.me);
      }
    }
    holder = a.holder;
    if (Date.now() >= deadline) throw new LockTimeoutError(lock, holder);
    Atomics.wait(waitCell, 0, 0, backoff(i));
  }
}
function sweepLockDebris(dir, olderThanMs = 36e5, now = Date.now()) {
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.(stale\.\d+\.\w+|\d+\.\w+\.tmp|break)$/.test(name)) continue;
      const p = join2(dir, name);
      try {
        if (now - statSync(p).mtimeMs > olderThanMs) rmSync(p, { force: true });
      } catch {
      }
    }
  } catch {
  }
}
var LockTimeoutError, DEFAULT_WAIT_MS, DEFAULT_STALE_MS, DEFAULT_MAX_HOLD_MS, UNREADABLE_GRACE_MS, BREAK_GUARD_STALE_MS, LOCK_HOST, HOST, sameState, sleep, backoff, waitCell, lockFileFor;
var init_fs_lock = __esm({
  "packages/core/src/fs-lock.ts"() {
    "use strict";
    LockTimeoutError = class extends Error {
      constructor(path3, holder) {
        super(`could not take ${path3} in time${holder ? ` (held by pid ${holder.pid} on ${holder.host} since ${new Date(holder.at).toISOString()})` : ""}`);
        this.path = path3;
        this.holder = holder;
        this.name = "LockTimeoutError";
      }
      path;
      holder;
      code = "lock_timeout";
    };
    DEFAULT_WAIT_MS = 5e3;
    DEFAULT_STALE_MS = 3e4;
    DEFAULT_MAX_HOLD_MS = 6e5;
    UNREADABLE_GRACE_MS = 2e3;
    BREAK_GUARD_STALE_MS = 5e3;
    LOCK_HOST = `${hostname()}${pidNamespace() ? `#${pidNamespace()}` : ""}`;
    HOST = LOCK_HOST;
    sameState = (a, b) => a.ino === b.ino && (a.holder?.pid ?? -1) === (b.holder?.pid ?? -1) && (a.holder?.at ?? -1) === (b.holder?.at ?? -1) && (a.holder?.host ?? "") === (b.holder?.host ?? "");
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    backoff = (i) => Math.min(100, 5 * 2 ** Math.min(i, 5)) * (0.5 + Math.random());
    waitCell = new Int32Array(new SharedArrayBuffer(4));
    lockFileFor = (file) => join2(dirname(file), `${basename(file)}.lock`);
  }
});

// packages/core/src/store/local-adapter.ts
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
function embedderId() {
  return `${getConfig().EMBEDDING_PROVIDER}:${getEmbeddingModel() || "default"}`;
}
function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 2;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function matchesFilter(metadata, filter) {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (expected === void 0 || expected === null) continue;
    const value = metadata[key];
    if (typeof expected === "object" && expected !== null && "$eq" in expected) {
      if (value !== expected.$eq) return false;
    } else if (Array.isArray(expected)) {
      const hay = typeof value === "string" ? value.split(",") : value;
      if (!Array.isArray(hay) || !expected.every((e) => hay.includes(e))) return false;
    } else if (value !== expected) {
      return false;
    }
  }
  return true;
}
function createLocalStore(rootDir) {
  const cache = /* @__PURE__ */ new Map();
  const cacheMtimes = /* @__PURE__ */ new Map();
  const identity = (st) => `${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`;
  const writeChains = /* @__PURE__ */ new Map();
  const fileFor = (name) => join3(rootDir, `${encodeURIComponent(name)}.json`);
  async function readFromDisk(name) {
    try {
      const fh = await open(fileFor(name), "r");
      let raw;
      let id;
      try {
        id = identity(await fh.stat({ bigint: true }));
        raw = await fh.readFile("utf-8");
      } finally {
        await fh.close();
      }
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1) throw new Error(`unsupported version ${parsed.version}`);
      cache.set(name, parsed);
      cacheMtimes.set(name, id);
      return parsed;
    } catch (e) {
      if (e?.code === "ENOENT") {
        cache.delete(name);
        cacheMtimes.delete(name);
        return void 0;
      }
      throw new Error(`local store: collection "${name}" is unreadable: ${e.message ?? e}`);
    }
  }
  async function load2(name) {
    const cached2 = cache.get(name);
    if (!cached2) return readFromDisk(name);
    try {
      const st = await stat(fileFor(name), { bigint: true });
      if (identity(st) !== cacheMtimes.get(name)) return readFromDisk(name);
    } catch (e) {
      if (e?.code === "ENOENT") {
        cache.delete(name);
        cacheMtimes.delete(name);
        return void 0;
      }
      throw e;
    }
    return cached2;
  }
  const fresh = (name) => ({ version: 1, name, created: (/* @__PURE__ */ new Date()).toISOString(), docs: {} });
  async function writeAtomic(cf) {
    await mkdir(rootDir, { recursive: true });
    const file = fileFor(cf.name);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(cf));
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    cache.set(cf.name, cf);
    cacheMtimes.set(cf.name, identity(await stat(file, { bigint: true })));
  }
  function mutate(name, apply) {
    const prev = writeChains.get(name) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(rootDir, { recursive: true });
      await withFileLock(lockFileFor(fileFor(name)), async () => {
        const cur = await load2(name);
        try {
          const out = apply(cur);
          if (out) await writeAtomic(out);
        } catch (e) {
          cache.delete(name);
          cacheMtimes.delete(name);
          throw e;
        }
      }, { waitMs: 15e3 });
    });
    writeChains.set(name, next.catch(() => {
    }));
    return next;
  }
  async function collectionNames() {
    await mkdir(rootDir, { recursive: true });
    return (await readdir(rootDir)).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5)));
  }
  function toResult(cf, id) {
    const doc = cf.docs[id];
    return { id, content: doc.content, metadata: fromChroma(doc.metadata) };
  }
  return {
    kind: "local",
    async listCollections() {
      const names = await collectionNames();
      return names.map((name) => ({ id: name, name }));
    },
    async createCollection(name, metadata) {
      await mutate(name, (cur) => {
        if (cur) throw new Error(`Collection "${name}" already exists`);
        return fresh(name);
      });
    },
    async deleteCollection(name) {
      await mkdir(rootDir, { recursive: true });
      await withFileLock(lockFileFor(fileFor(name)), async () => {
        await rm(fileFor(name), { force: true });
      }, { waitMs: 15e3 });
      cache.delete(name);
      cacheMtimes.delete(name);
      writeChains.delete(name);
    },
    async getCollectionCount(name) {
      const cf = await load2(name);
      return cf ? Object.keys(cf.docs).length : 0;
    },
    async getOrCreateCollection(name) {
      if (!await load2(name)) await mutate(name, (cur) => cur ?? fresh(name));
      return name;
    },
    async addDocument(collection, id, content, metadata) {
      const doc = { content, metadata: toChroma(metadata), embedding: await generateEmbedding(content), embedding_model: embedderId() };
      await mutate(collection, (cur) => {
        const cf = cur ?? fresh(collection);
        cf.docs[id] = doc;
        return cf;
      });
    },
    async addDocumentsBatch(collection, documents) {
      const docs = [];
      for (const d of documents) {
        docs.push([d.id, { content: d.content, metadata: toChroma(d.metadata), embedding: await generateEmbedding(d.content), embedding_model: embedderId() }]);
      }
      await mutate(collection, (cur) => {
        const cf = cur ?? fresh(collection);
        for (const [id, doc] of docs) cf.docs[id] = doc;
        return cf;
      });
    },
    async queryDocuments(collection, queryText, nResults = 5, filter) {
      const cf = await load2(collection);
      if (!cf) return [];
      const qe = await generateEmbedding(queryText);
      const model = embedderId();
      const out = [];
      for (const [id, doc] of Object.entries(cf.docs)) {
        if (doc.embedding_model !== model) continue;
        if (!matchesFilter(doc.metadata, filter)) continue;
        out.push({ ...toResult(cf, id), distance: cosineDistance(qe, doc.embedding) });
      }
      out.sort((a, b) => a.distance - b.distance);
      return out.slice(0, nResults);
    },
    async queryAllCollections(queryText, nResults = 5, filter) {
      const qe = await generateEmbedding(queryText);
      const model = embedderId();
      const out = [];
      for (const name of await collectionNames()) {
        const cf = await load2(name);
        if (!cf) continue;
        for (const [id, doc] of Object.entries(cf.docs)) {
          if (doc.embedding_model !== model) continue;
          if (!matchesFilter(doc.metadata, filter)) continue;
          out.push({ ...toResult(cf, id), distance: cosineDistance(qe, doc.embedding), collection: name });
        }
      }
      out.sort((a, b) => a.distance - b.distance);
      return out.slice(0, nResults);
    },
    async getDocumentsByFilter(collection, filter, limit = 1e3) {
      const cf = await load2(collection);
      if (!cf) return [];
      const out = [];
      for (const id of Object.keys(cf.docs)) {
        if (out.length >= limit) break;
        if (matchesFilter(cf.docs[id].metadata, filter)) out.push(toResult(cf, id));
      }
      return out;
    },
    async getDocumentsByIds(collection, ids) {
      const cf = await load2(collection);
      if (!cf) return [];
      return ids.filter((id) => cf.docs[id]).map((id) => toResult(cf, id));
    },
    async updateDocument(collection, id, metadata) {
      await mutate(collection, (cf) => {
        if (!cf?.docs[id]) throw new Error(`Document "${id}" not found in collection "${collection}"`);
        cf.docs[id].metadata = toChroma(metadata);
        return cf;
      });
    },
    async updateDocumentsBatch(collection, entries) {
      if (entries.length === 0) return;
      await mutate(collection, (cf) => {
        if (!cf) throw new Error(`Collection "${collection}" not found`);
        let changed = 0;
        for (const e of entries) {
          if (!cf.docs[e.id]) continue;
          cf.docs[e.id].metadata = toChroma(e.metadata);
          changed++;
        }
        return changed > 0 ? cf : false;
      });
    },
    async patchDocuments(collection, entries) {
      if (entries.length === 0) return;
      await mutate(collection, (cf) => {
        if (!cf) return false;
        let changed = 0;
        for (const e of entries) {
          const doc = cf.docs[e.id];
          if (!doc) continue;
          const set = Object.fromEntries(Object.entries(e.patch).filter(([, v]) => v !== null && v !== void 0));
          const next = { ...doc.metadata, ...toChroma(set) };
          for (const [k, v] of Object.entries(e.patch)) if (v === null || v === void 0) delete next[k];
          doc.metadata = next;
          changed++;
        }
        return changed > 0 ? cf : false;
      });
    },
    async deleteDocument(collection, id) {
      await mutate(collection, (cf) => cf && cf.docs[id] && delete cf.docs[id] ? cf : false);
    },
    async findAndDeleteDocument(id) {
      for (const name of await collectionNames()) {
        if (!(await load2(name))?.docs[id]) continue;
        let deleted = false;
        await mutate(name, (cf) => {
          if (!cf?.docs[id]) return false;
          delete cf.docs[id];
          deleted = true;
          return cf;
        });
        if (deleted) return name;
      }
      throw new Error(`Document "${id}" not found in any collection`);
    }
  };
}
var init_local_adapter = __esm({
  "packages/core/src/store/local-adapter.ts"() {
    "use strict";
    init_embeddings();
    init_config();
    init_fs_lock();
    init_metadata_adapter();
  }
});

// packages/core/src/store/types.ts
var init_types = __esm({
  "packages/core/src/store/types.ts"() {
    "use strict";
  }
});

// packages/core/src/store/index.ts
var store_exports = {};
__export(store_exports, {
  addDocument: () => addDocument2,
  addDocumentsBatch: () => addDocumentsBatch2,
  chromaStore: () => chromaStore,
  createCollection: () => createCollection2,
  createLocalStore: () => createLocalStore,
  deleteCollection: () => deleteCollection2,
  deleteDocument: () => deleteDocument2,
  findAndDeleteDocument: () => findAndDeleteDocument2,
  getCollectionCount: () => getCollectionCount2,
  getDocumentsByFilter: () => getDocumentsByFilter2,
  getDocumentsByIds: () => getDocumentsByIds2,
  getOrCreateCollection: () => getOrCreateCollection2,
  getStore: () => getStore,
  listCollections: () => listCollections2,
  metadataDelta: () => metadataDelta,
  patchDocument: () => patchDocument,
  patchDocuments: () => patchDocuments2,
  queryAllCollections: () => queryAllCollections2,
  queryDocuments: () => queryDocuments2,
  resetStore: () => resetStore,
  setStore: () => setStore,
  updateDocument: () => updateDocument2,
  updateDocumentsBatch: () => updateDocumentsBatch2
});
function setStore(store) {
  active2 = store;
}
function getStore() {
  if (!active2) {
    active2 = getConfig().STORAGE === "local" ? createLocalStore(getConfig().LOCAL_STORE_PATH) : chromaStore;
  }
  return active2;
}
function resetStore() {
  active2 = void 0;
}
function metadataDelta(before, after) {
  const out = {};
  const same2 = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [k, v] of Object.entries(after)) if (!same2(before[k], v)) out[k] = v ?? null;
  for (const k of Object.keys(before)) if (!(k in after) && before[k] != null) out[k] = null;
  return out;
}
var active2, listCollections2, createCollection2, deleteCollection2, getCollectionCount2, getOrCreateCollection2, addDocument2, addDocumentsBatch2, queryDocuments2, queryAllCollections2, getDocumentsByFilter2, getDocumentsByIds2, updateDocument2, updateDocumentsBatch2, patchDocuments2, patchDocument, deleteDocument2, findAndDeleteDocument2;
var init_store = __esm({
  "packages/core/src/store/index.ts"() {
    "use strict";
    init_config();
    init_chroma_adapter();
    init_local_adapter();
    init_types();
    init_chroma_adapter();
    init_local_adapter();
    listCollections2 = () => getStore().listCollections();
    createCollection2 = (name, metadata) => getStore().createCollection(name, metadata);
    deleteCollection2 = (name) => getStore().deleteCollection(name);
    getCollectionCount2 = (name) => getStore().getCollectionCount(name);
    getOrCreateCollection2 = (name) => getStore().getOrCreateCollection(name);
    addDocument2 = (collection, id, content, metadata) => getStore().addDocument(collection, id, content, metadata);
    addDocumentsBatch2 = (collection, documents) => getStore().addDocumentsBatch(collection, documents);
    queryDocuments2 = (collection, queryText, nResults, filter) => getStore().queryDocuments(collection, queryText, nResults, filter);
    queryAllCollections2 = (queryText, nResults, filter) => getStore().queryAllCollections(queryText, nResults, filter);
    getDocumentsByFilter2 = (collection, filter, limit) => getStore().getDocumentsByFilter(collection, filter, limit);
    getDocumentsByIds2 = (collection, ids) => getStore().getDocumentsByIds(collection, ids);
    updateDocument2 = (collection, id, metadata) => getStore().updateDocument(collection, id, metadata);
    updateDocumentsBatch2 = (collection, entries) => getStore().updateDocumentsBatch(collection, entries);
    patchDocuments2 = (collection, entries) => entries.length ? getStore().patchDocuments(collection, entries) : Promise.resolve();
    patchDocument = (collection, id, patch) => patchDocuments2(collection, [{ id, patch }]);
    deleteDocument2 = (collection, id) => getStore().deleteDocument(collection, id);
    findAndDeleteDocument2 = (id) => getStore().findAndDeleteDocument(id);
  }
});

// packages/core/src/chunking.ts
function chunkText(text) {
  if (text.length <= CHUNK_SIZE) {
    return [{ content: text, index: 0, total: 1 }];
  }
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push({ content: text.slice(start, end), index: chunks.length, total: 0 });
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  for (const chunk2 of chunks) {
    chunk2.total = chunks.length;
  }
  return chunks;
}
var init_chunking = __esm({
  "packages/core/src/chunking.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/lifecycle.ts
function touchDocument(metadata, now = Math.floor(Date.now() / 1e3)) {
  const day = Math.floor(now / 86400);
  const boostsToday = metadata.boost_day === day ? metadata.boosts_today ?? 0 : 0;
  if (boostsToday >= getConfig().SALIENCE_MAX_BOOSTS_PER_DAY) {
    return { ...metadata, accessed_at: now };
  }
  return {
    ...metadata,
    accessed_at: now,
    salience: Math.min(metadata.salience + SALIENCE_BOOST_ON_ACCESS, SALIENCE_MAX),
    boost_day: day,
    boosts_today: boostsToday + 1
  };
}
function decayFactor(sector, days) {
  const perDay = sector === "semantic" ? Math.pow(getConfig().SALIENCE_DECAY_RATE, 0.5) : getConfig().SALIENCE_DECAY_RATE;
  return Math.pow(perDay, Math.max(0, days));
}
function applyDecay(metadata, days = 1) {
  return {
    ...metadata,
    salience: Math.max(metadata.salience * decayFactor(metadata.sector, days), SALIENCE_FLOOR)
  };
}
function detectSector(content) {
  const semanticSignals = /\b(my|i am|i'm|i prefer|remember|always|never|they use|they have|their|runs on|version)\b/i;
  return semanticSignals.test(content) ? "semantic" : "episodic";
}
var init_lifecycle = __esm({
  "packages/core/src/lifecycle.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/sync/sentinel.ts
async function getSyncPullTimestamp() {
  try {
    const results = await getDocumentsByFilter2("global", {
      type: { $eq: "sync_pull_sentinel" }
    }, 1);
    if (results.length === 0) return 0;
    return results[0].metadata.last_pull ?? 0;
  } catch {
    return 0;
  }
}
async function updateSyncPullTimestamp(at = Math.floor(Date.now() / 1e3)) {
  await getOrCreateCollection2("global");
  await addDocument2("global", SYNC_PULL_SENTINEL_ID, "sync pull sentinel", {
    type: "sync_pull_sentinel",
    last_pull: at
  });
}
async function getSyncSubscriptions() {
  try {
    const results = await getDocumentsByFilter2("global", {
      type: { $eq: "sync_subscriptions" }
    }, 1);
    if (results.length === 0) return [];
    const raw = results[0].metadata.collections;
    if (!raw) return [];
    return raw.split(",").filter(Boolean);
  } catch {
    return [];
  }
}
async function updateSyncSubscriptions(collections) {
  await getOrCreateCollection2("global");
  const deduped = [...new Set(collections)].sort();
  await addDocument2("global", SYNC_SUBSCRIPTIONS_ID, "sync subscriptions", {
    type: "sync_subscriptions",
    collections: deduped.join(",")
  });
}
async function getCollectionRedirects() {
  try {
    const results = await getDocumentsByFilter2("global", {
      type: { $eq: "collection_redirects" }
    }, 1);
    if (results.length === 0) return {};
    const raw = results[0].metadata.redirects ?? {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string"));
  } catch {
    return {};
  }
}
async function writeCollectionRedirects(redirects) {
  await getOrCreateCollection2("global");
  await addDocument2("global", COLLECTION_REDIRECTS_ID, "collection redirects", {
    type: "collection_redirects",
    redirects
    // stored as JSON by the adapters
  });
}
async function addCollectionRedirect(from, into) {
  if (from === into || from === "global") return;
  const redirects = await getCollectionRedirects();
  redirects[from] = into;
  delete redirects[into];
  await writeCollectionRedirects(redirects);
}
async function clearCollectionRedirect(name) {
  const redirects = await getCollectionRedirects();
  if (!Object.hasOwn(redirects, name)) return;
  delete redirects[name];
  await writeCollectionRedirects(redirects);
}
async function getLeftCollections() {
  try {
    const r = await getDocumentsByFilter2("global", { type: { $eq: "collections_left" } }, 1);
    const raw = r[0]?.metadata.collections;
    return Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",").filter(Boolean);
  } catch {
    return [];
  }
}
async function writeLeftCollections(names) {
  await getOrCreateCollection2("global");
  await addDocument2("global", COLLECTIONS_LEFT_ID, "collections removed from this machine", {
    type: "collections_left",
    collections: [...new Set(names)].sort().join(",")
  });
}
async function addLeftCollection(name) {
  const left = await getLeftCollections();
  if (!left.includes(name)) await writeLeftCollections([...left, name]);
}
async function clearLeftCollection(name) {
  const left = await getLeftCollections();
  if (left.includes(name)) await writeLeftCollections(left.filter((n) => n !== name));
}
async function getUnfollowedCollections() {
  return /* @__PURE__ */ new Set([...Object.keys(await getCollectionRedirects()), ...await getLeftCollections()]);
}
function resolveCollectionRedirect(name, redirects) {
  let current = name;
  const seen = /* @__PURE__ */ new Set([name]);
  while (Object.hasOwn(redirects, current)) {
    const next = redirects[current];
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current === name ? { collection: name } : { collection: current, redirectedFrom: name };
}
async function resolveWriteCollection(name) {
  if (name === "global") return { collection: name };
  const w = resolveCollectionRedirect(name, await getCollectionRedirects());
  if ((await getLeftCollections()).includes(w.collection)) throw new CollectionLeftError(w.collection);
  return w;
}
async function getPendingBackfills() {
  try {
    const r = await getDocumentsByFilter2("global", { type: { $eq: "collections_backfill" } }, 1);
    return String(r[0]?.metadata.collections ?? "").split(",").filter(Boolean);
  } catch {
    return [];
  }
}
async function writePendingBackfills(names) {
  await getOrCreateCollection2("global");
  await addDocument2("global", COLLECTIONS_BACKFILL_ID, "collections to backfill", {
    type: "collections_backfill",
    collections: [...new Set(names)].sort().join(",")
  });
}
async function addPendingBackfill(name) {
  const p = await getPendingBackfills();
  if (!p.includes(name)) await writePendingBackfills([...p, name]);
}
async function clearPendingBackfill(name) {
  const p = await getPendingBackfills();
  if (p.includes(name)) await writePendingBackfills(p.filter((n) => n !== name));
}
async function rejoinCollection(name) {
  if (!(await getLeftCollections()).includes(name)) return false;
  await clearLeftCollection(name);
  const subs = await getSyncSubscriptions();
  if (!subs.includes(name)) await updateSyncSubscriptions([...subs, name]);
  await addPendingBackfill(name);
  return true;
}
function redirectNote(w) {
  return w.redirectedFrom ? `"${w.redirectedFrom}" was merged into "${w.collection}" on this machine, so this was written to "${w.collection}".` : "";
}
var SYNC_PULL_SENTINEL_ID, SYNC_SUBSCRIPTIONS_ID, COLLECTION_REDIRECTS_ID, COLLECTIONS_LEFT_ID, CollectionLeftError, COLLECTIONS_BACKFILL_ID;
var init_sentinel = __esm({
  "packages/core/src/sync/sentinel.ts"() {
    "use strict";
    init_store();
    SYNC_PULL_SENTINEL_ID = "__sync_pull_sentinel__";
    SYNC_SUBSCRIPTIONS_ID = "__sync_subscriptions__";
    COLLECTION_REDIRECTS_ID = "__collection_redirects__";
    COLLECTIONS_LEFT_ID = "__collections_left__";
    CollectionLeftError = class extends Error {
      constructor(collection) {
        super(`"${collection}" was removed from this machine (collection_delete), so writes to it are refused: written here it would be pushed but never pulled, and teammates' documents in it would be missing. To follow it again with its full history, run sync subscribe ${collection} (or collection_create ${collection}), then write again.`);
        this.collection = collection;
        this.name = "CollectionLeftError";
      }
      collection;
      code = "collection_left";
    };
    COLLECTIONS_BACKFILL_ID = "__collections_backfill__";
  }
});

// packages/core/src/scope.ts
import path2 from "node:path";
import { realpathSync } from "node:fs";
function matchCollectionMap(cwd, entries, opts = {}) {
  const P = opts.path ?? path2;
  const real = opts.realpath ?? realpathOrUndefined;
  const fold = P.sep === "\\" ? (s) => s.toLowerCase() : (s) => s;
  const forms = (p) => [...new Set([p, real(p)].filter((x) => !!x).map(fold))];
  const here = forms(P.resolve(cwd));
  const holds = (dir, c) => c === dir || c.startsWith(dir.endsWith(P.sep) ? dir : dir + P.sep);
  let best;
  for (const entry of entries) {
    const eq = entry.lastIndexOf("=");
    if (eq < 0) continue;
    const dir = entry.slice(0, eq).trim();
    const collection = entry.slice(eq + 1).trim();
    if (!dir || !collection || !P.isAbsolute(dir)) continue;
    const resolved = P.resolve(dir);
    if (!forms(resolved).some((d) => here.some((c) => holds(d, c)))) continue;
    if (!best || resolved.length > best.length) best = { length: resolved.length, collection };
  }
  return best?.collection;
}
async function detectCollection(cwd, roots = getConfig().PROJECT_ROOTS, customers = getConfig().CUSTOMERS, map = getConfig().COLLECTION_MAP) {
  const d = await detect(cwd, roots, customers, map);
  if (d.collection !== "global" && (await getLeftCollections()).includes(d.collection)) d.left = true;
  return d;
}
async function detect(cwd, roots, customers, map) {
  if (!cwd) return { collection: "global" };
  const mapped = matchCollectionMap(cwd, map);
  if (mapped) return follow({ collection: mapped, mapped: true }, await getCollectionRedirects());
  for (const rawRoot of roots) {
    const root = rawRoot.replace(/\/+$/, "");
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    const relative = cwd.slice(root.length).replace(/^\/+/, "");
    const segment = relative.split("/")[0];
    if (!segment || segment.startsWith(".")) return { collection: "global" };
    const existing = (await listCollections2().catch(() => [])).map((c) => c.name);
    const redirects = await getCollectionRedirects();
    const known = (name) => existing.includes(name) || Object.hasOwn(redirects, name);
    const hasCustomer = known(`customer-${segment}`);
    const hasProject = known(`project-${segment}`);
    if (hasCustomer && hasProject) {
      return follow({
        collection: `project-${segment}`,
        ambiguous: [`project-${segment}`, `customer-${segment}`]
      }, redirects);
    }
    if (hasCustomer) return follow({ collection: `customer-${segment}` }, redirects);
    if (hasProject) return follow({ collection: `project-${segment}` }, redirects);
    if (customers.includes(segment)) return follow({ collection: `customer-${segment}` }, redirects);
    return follow({ collection: `project-${segment}` }, redirects);
  }
  return { collection: "global" };
}
function scopeNotes(d) {
  const notes = [];
  if (d.collection !== "global" && !isSyncableCollection(d.collection)) notes.push("(local only, never synced)");
  else if (d.mapped && looksPrivateButShared(d.collection)) {
    notes.push("(shared: this name syncs; local-only names start with lowercase `private-` or `local-`)");
  }
  if (d.redirectedFrom) notes.push(`(merged from \`${d.redirectedFrom}\`)`);
  if (d.left) notes.push(`(removed from this machine: writes to it are refused; \`sync subscribe ${d.collection}\` follows it again)`);
  return notes.length ? ` ${notes.join(" ")}` : "";
}
function follow(d, redirects) {
  const { collection, redirectedFrom } = resolveCollectionRedirect(d.collection, redirects);
  const out = { ...d, collection };
  if (redirectedFrom) out.redirectedFrom = redirectedFrom;
  if (d.ambiguous) {
    const [a, b] = d.ambiguous.map((n) => resolveCollectionRedirect(n, redirects).collection);
    if (a === b) delete out.ambiguous;
    else out.ambiguous = [a, b];
  }
  return out;
}
async function isDetectionStale(d) {
  const redirects = await getCollectionRedirects();
  if (Object.hasOwn(redirects, d.collection)) return true;
  if (d.redirectedFrom && !Object.hasOwn(redirects, d.redirectedFrom)) return true;
  return !!d.ambiguous?.some((n) => Object.hasOwn(redirects, n));
}
var realpathOrUndefined;
var init_scope = __esm({
  "packages/core/src/scope.ts"() {
    "use strict";
    init_config();
    init_store();
    init_sentinel();
    init_syncable();
    realpathOrUndefined = (p) => {
      try {
        return realpathSync.native(p);
      } catch {
        return void 0;
      }
    };
  }
});

// packages/core/src/memory/archive.ts
function archivedMetadata(metadata, extra, now = Math.floor(Date.now() / 1e3)) {
  return { ...metadata, ...extra, archived: true, updated_at: now, is_synced: false };
}
var init_archive = __esm({
  "packages/core/src/memory/archive.ts"() {
    "use strict";
  }
});

// packages/core/src/memory/kinds.ts
function isMemoryKind(k) {
  return typeof k === "string" && MEMORY_KINDS.includes(k);
}
function normalizeTyped(fields, current = {}) {
  const out = {};
  for (const k of TYPED_KEYS) {
    const v = fields[k];
    if (v === void 0) continue;
    out[k] = k === "task_ids" || k === "options" || k === "disposition_ids" ? list2(v) : typeof v === "string" ? v.trim() : v;
  }
  if (!Object.keys(out).length) return out;
  const curKind = isMemoryKind(current.kind) ? current.kind : void 0;
  if (out.kind !== void 0 && !isMemoryKind(out.kind)) {
    throw new TypedMemoryError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  }
  if (out.kind && curKind && out.kind !== curKind) {
    throw new TypedMemoryError(`this memory is a ${curKind}; store a new ${out.kind} instead of changing its kind`);
  }
  const kind = out.kind ?? curKind;
  const kindSpecific = Object.keys(out).filter((k) => k !== "task_ids" && k !== "external_ref" && k !== "owner");
  if (!kind && kindSpecific.length) {
    throw new TypedMemoryError(`${kindSpecific.join(", ")} need a kind (${MEMORY_KINDS.join(", ")})`);
  }
  if (kind) {
    for (const k of Object.keys(out)) {
      const only = KIND_ONLY[k];
      if (only && only !== kind) throw new TypedMemoryError(`${k} applies to a ${only}, not a ${kind}`);
    }
    if (out.kind && out.status === void 0 && current.status === void 0) out.status = DEFAULT_STATUS[kind];
    const status = out.status ?? current.status;
    if (!KIND_STATUSES[kind].includes(status)) {
      throw new TypedMemoryError(`a ${kind}'s status is one of ${KIND_STATUSES[kind].join(", ")}`);
    }
    const merged = { ...current, ...out };
    if (kind === "decision" && status === "needed" && list2(merged.options).length < 2) {
      throw new TypedMemoryError("a decision that is needed lists at least two options (and ideally a recommendation)");
    }
    if (kind === "finding" && status === "resolved") {
      const d = merged.disposition;
      if (!DISPOSITIONS.includes(d)) {
        throw new TypedMemoryError(`a resolved finding says what became of it: disposition ${DISPOSITIONS.join(", ")}`);
      }
      if (d === "no-action" && !String(merged.disposition_reason ?? "").trim()) {
        throw new TypedMemoryError("a no-action disposition gives disposition_reason");
      }
      if (d !== "no-action" && !list2(merged.disposition_ids).length) {
        throw new TypedMemoryError(`a ${d} disposition names it in disposition_ids`);
      }
    }
  }
  return out;
}
function isOpenTyped(meta) {
  if (!meta || !isMemoryKind(meta.kind)) return false;
  return OPEN_STATUSES[meta.kind].includes(meta.status ?? DEFAULT_STATUS[meta.kind]);
}
function carryTyped(meta) {
  const out = {};
  if (!meta) return out;
  for (const k of TYPED_KEYS) if (meta[k] !== void 0 && meta[k] !== "") out[k] = meta[k];
  return out;
}
function waitsOnPeople(meta) {
  return meta.owner ? [String(meta.owner)] : [];
}
function typedLabel(meta) {
  if (!meta || !isMemoryKind(meta.kind)) return "";
  const parts = [meta.kind, meta.status ?? DEFAULT_STATUS[meta.kind]];
  if (meta.owner && (meta.kind === "decision" || meta.kind === "question")) parts.push(`for ${meta.owner}`);
  return `[${parts.join(", ")}]`;
}
var MEMORY_KINDS, KIND_STATUSES, DEFAULT_STATUS, OPEN_STATUSES, DISPOSITIONS, TYPED_KEYS, KIND_ONLY, TypedMemoryError, list2;
var init_kinds = __esm({
  "packages/core/src/memory/kinds.ts"() {
    "use strict";
    MEMORY_KINDS = ["finding", "decision", "limitation", "question", "idea"];
    KIND_STATUSES = {
      finding: ["open", "resolved"],
      decision: ["needed", "proposed", "accepted", "superseded", "rejected"],
      limitation: ["open", "mitigated", "accepted", "closed"],
      question: ["open", "answered"],
      idea: ["proposed", "adopted", "dropped"]
    };
    DEFAULT_STATUS = {
      finding: "open",
      decision: "proposed",
      limitation: "open",
      question: "open",
      idea: "proposed"
    };
    OPEN_STATUSES = {
      finding: ["open"],
      decision: ["needed", "proposed"],
      limitation: ["open"],
      question: ["open"],
      idea: ["proposed"]
    };
    DISPOSITIONS = ["decision", "task", "limitation", "no-action"];
    TYPED_KEYS = [
      "kind",
      "status",
      "owner",
      "task_ids",
      "options",
      "recommendation",
      "disposition",
      "disposition_ids",
      "disposition_reason",
      "exit_criteria",
      "external_ref"
    ];
    KIND_ONLY = {
      options: "decision",
      recommendation: "decision",
      disposition: "finding",
      disposition_ids: "finding",
      disposition_reason: "finding",
      exit_criteria: "limitation"
    };
    TypedMemoryError = class extends Error {
      code = "typed_memory_invalid";
      constructor(message2) {
        super(message2);
        this.name = "TypedMemoryError";
      }
    };
    list2 = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map(String).map((s) => s.trim()).filter(Boolean);
  }
});

// packages/core/src/doc-lock.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join as join4 } from "node:path";
function docLockPath(collection, id) {
  const h = createHash("sha256").update(`${collection}\0${id}`).digest("hex").slice(0, 32);
  return join4(getConfig().LOCAL_COORD_DIR, "locks", `${h}.lock`);
}
async function withDocLock(collection, id, fn) {
  const path3 = docLockPath(collection, id);
  const mine = (held.getStore() ?? []).filter((h) => h.active);
  if (mine.some((h) => h.paths.has(path3))) return fn();
  return withFileLock(path3, async () => {
    const me = { paths: /* @__PURE__ */ new Set([path3]), active: true };
    try {
      return await held.run([...mine, me], fn);
    } finally {
      me.active = false;
    }
  }, { waitMs: WAIT_MS });
}
var held, WAIT_MS;
var init_doc_lock = __esm({
  "packages/core/src/doc-lock.ts"() {
    "use strict";
    init_config();
    init_fs_lock();
    held = new AsyncLocalStorage();
    WAIT_MS = 2e4;
  }
});

// packages/core/src/memory/links.ts
async function findDoc(id) {
  for (const c of await listCollections2().catch(() => [])) {
    const [d] = await getDocumentsByIds2(c.name, [id]).catch(() => []);
    if (d) return { collection: c.name, metadata: d.metadata };
  }
  return null;
}
async function linkMemoryToTasks(memoryId, taskIds) {
  const out = { linked: [], missing: [] };
  for (const tid of [...new Set(taskIds)]) {
    const t = await findDoc(tid);
    if (!t || t.metadata.type !== "task" || t.metadata.read_only === true) {
      out.missing.push(tid);
      continue;
    }
    const present = await withDocLock(t.collection, tid, async () => {
      const fresh = (await getDocumentsByIds2(t.collection, [tid]))[0];
      if (!fresh) return false;
      const cur = list3(fresh.metadata.memory_ids);
      if (cur.includes(memoryId)) return true;
      await updateDocument2(t.collection, tid, {
        ...fresh.metadata,
        memory_ids: [...cur, memoryId],
        updated_at: Math.floor(Date.now() / 1e3),
        is_synced: false
      });
      return true;
    });
    (present ? out.linked : out.missing).push(tid);
  }
  return out;
}
var list3;
var init_links = __esm({
  "packages/core/src/memory/links.ts"() {
    "use strict";
    init_doc_lock();
    init_store();
    list3 = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map(String).filter(Boolean);
  }
});

// packages/core/src/memory/store.ts
function findConflicts(candidates, threshold = getConfig().CONTRADICTION_DISTANCE_THRESHOLD, maxResults = getConfig().CONTRADICTION_MAX_RESULTS) {
  return candidates.filter((c) => c.distance < threshold).sort((a, b) => a.distance - b.distance).slice(0, maxResults).map((c) => ({
    id: c.id,
    content: c.content.length > 200 ? c.content.slice(0, 200) + "\u2026" : c.content,
    distance: c.distance,
    salience: c.metadata.salience ?? 1
  }));
}
async function detectConflicts(collection, content) {
  try {
    const candidates = await queryDocuments2(
      collection,
      content,
      getConfig().CONTRADICTION_MAX_RESULTS * 2,
      { type: "memory" }
    );
    return findConflicts(candidates);
  } catch {
    return [];
  }
}
async function archiveSuperseded(collection, oldId, newId) {
  try {
    const existing = await getDocumentsByIds2(collection, [oldId]);
    if (!existing.length) {
      process.stderr.write(`[yapa] store: supersedes target "${oldId}" not found in ${collection} \u2014 skipped
`);
      return;
    }
    await patchDocument(collection, oldId, metadataDelta(existing[0].metadata, archivedMetadata(existing[0].metadata, { superseded_by: newId })));
  } catch (e) {
    process.stderr.write(`[yapa] store: failed to archive superseded ${oldId}: ${e}
`);
  }
}
async function storeMemory(content, options = {}) {
  const { collection } = await resolveWriteCollection(options.collection ?? "global");
  const typed = options.typed ? normalizeTyped(options.typed) : {};
  await getOrCreateCollection2(collection);
  if (options.supersedes) {
    const [old] = await getDocumentsByIds2(collection, [options.supersedes]).catch(() => []);
    assertWritable(options.supersedes, old?.metadata);
  }
  if (options.metadata && "read_only" in options.metadata) {
    const { read_only: _ignored, ...rest } = options.metadata;
    options = { ...options, metadata: rest };
  }
  const potential_conflicts = await detectConflicts(collection, content);
  const now = Math.floor(Date.now() / 1e3);
  const sector = options.sector ?? detectSector(content);
  const salience = options.salience ?? SALIENCE_START;
  const chunks = chunkText(content);
  if (chunks.length === 1) {
    const id = `mem-${getConfig().USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata = {
      ...options.metadata ?? {},
      ...typed,
      type: "memory",
      username: getConfig().USERNAME,
      tags: options.tags ?? [],
      salience,
      sector,
      created_at: now,
      accessed_at: now
    };
    if (options.supersedes) metadata.supersedes = options.supersedes;
    metadata.is_synced = false;
    await addDocument2(collection, id, content, metadata);
    if (options.supersedes) await archiveSuperseded(collection, options.supersedes, id);
    if (typed.task_ids?.length) await linkMemoryToTasks(id, typed.task_ids);
    return { ids: [id], potential_conflicts };
  }
  const baseId = `mem-${getConfig().USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const docs = chunks.map((chunk2) => {
    const chunkMeta = {
      ...options.metadata ?? {},
      ...typed,
      type: "memory",
      username: getConfig().USERNAME,
      tags: options.tags ?? [],
      salience,
      sector,
      created_at: now,
      accessed_at: now,
      chunk_index: chunk2.index,
      chunk_total: chunk2.total,
      parent_id: baseId
    };
    if (options.supersedes) chunkMeta.supersedes = options.supersedes;
    chunkMeta.is_synced = false;
    return {
      id: `${baseId}-${chunk2.index}`,
      content: chunk2.content,
      metadata: chunkMeta
    };
  });
  await addDocumentsBatch2(collection, docs);
  if (options.supersedes) await archiveSuperseded(collection, options.supersedes, baseId);
  if (typed.task_ids?.length) await linkMemoryToTasks(baseId, typed.task_ids);
  return { ids: docs.map((d) => d.id), potential_conflicts };
}
var init_store2 = __esm({
  "packages/core/src/memory/store.ts"() {
    "use strict";
    init_store();
    init_archive();
    init_lifecycle();
    init_chunking();
    init_config();
    init_syncable();
    init_kinds();
    init_links();
    init_sentinel();
  }
});

// packages/core/src/memory/filters.ts
function passesPromotedFilter(metadata, includePromoted) {
  if (includePromoted) return true;
  return metadata.promoted_to == null;
}
function passesScoreFilters(metadata, filters) {
  if (!filters) return true;
  if (filters.trainable_min != null && (metadata.trainable ?? -Infinity) < filters.trainable_min) {
    return false;
  }
  if (filters.durability_min != null && (metadata.durability ?? -Infinity) < filters.durability_min) {
    return false;
  }
  if (filters.generalizability_min != null && (metadata.generalizability ?? -Infinity) < filters.generalizability_min) {
    return false;
  }
  if (filters.classified === true && metadata.classified_at == null) return false;
  if (filters.classified === false && metadata.classified_at != null) return false;
  return true;
}
function normalizedSalience(salience) {
  const s = salience ?? SALIENCE_START;
  const span = SALIENCE_MAX - SALIENCE_FLOOR;
  if (span <= 0) return 0;
  const n = (s - SALIENCE_FLOOR) / span;
  return Math.max(0, Math.min(1, n));
}
function rankScore(distance, salience) {
  return distance - getConfig().SALIENCE_RANKING_WEIGHT * normalizedSalience(salience);
}
var init_filters = __esm({
  "packages/core/src/memory/filters.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/memory/recall.ts
function isFenced(collection) {
  return !!collection && collection !== "global" && !isSyncableCollection(collection);
}
async function recallMemory(query, options = {}) {
  const nResults = options.nResults ?? 5;
  const includePromoted = options.include_promoted ?? false;
  const filter = { type: "memory" };
  if (options.kind) filter.kind = options.kind;
  if (options.status) filter.status = options.status;
  let results;
  if (options.collection) {
    const docs = await queryDocuments2(options.collection, query, nResults, filter);
    results = docs.map((d) => ({ ...d, collection: options.collection }));
    const extra = options.crossCollection ?? 0;
    if (extra > 0) {
      const maxDistance = getConfig().CROSS_COLLECTION_MAX_DISTANCE;
      const others = (await queryAllCollections2(query, nResults + extra * 4, filter).catch(() => [])).filter((r) => r.collection !== options.collection && r.distance < maxDistance && r.metadata.archived !== true && !isFenced(r.collection)).slice(0, extra);
      results = [...results, ...others];
    }
  } else {
    const docs = await queryAllCollections2(query, nResults, filter);
    results = docs;
  }
  if (options.tags?.length) {
    results = results.filter((r) => {
      const docTags = Array.isArray(r.metadata.tags) ? r.metadata.tags : (r.metadata.tags ?? "").split(",").filter(Boolean);
      return options.tags.some((t) => docTags.includes(t));
    });
  }
  const includeArchived = options.include_archived ?? false;
  results = results.filter(
    (r) => passesPromotedFilter(r.metadata, includePromoted) && passesScoreFilters(r.metadata, options.filters) && (includeArchived || r.metadata.archived !== true)
  );
  results.sort(
    (a, b) => rankScore(a.distance, a.metadata.salience) - rankScore(b.distance, b.metadata.salience)
  );
  const boostMaxDistance = getConfig().SALIENCE_BOOST_MAX_DISTANCE;
  const boosts = /* @__PURE__ */ new Map();
  for (const r of results) {
    if (options.boost === false || r.distance >= boostMaxDistance) continue;
    if (r.collection) {
      const lifecycleMeta = {
        salience: r.metadata.salience ?? 1,
        accessed_at: r.metadata.accessed_at ?? Math.floor(Date.now() / 1e3),
        created_at: r.metadata.created_at ?? Math.floor(Date.now() / 1e3),
        sector: r.metadata.sector ?? "episodic"
      };
      const boosted = touchDocument(lifecycleMeta);
      const patch = metadataDelta(r.metadata, { ...r.metadata, ...boosted });
      if (Object.keys(patch).length) boosts.set(r.collection, [...boosts.get(r.collection) ?? [], { id: r.id, patch }]);
    }
  }
  for (const [collection, entries] of boosts) track(patchDocuments2(collection, entries).catch(() => {
  }));
  return results;
}
function track(p) {
  pendingBoosts.add(p);
  p.finally(() => pendingBoosts.delete(p));
}
async function settleRecallBoosts() {
  while (pendingBoosts.size) await Promise.all([...pendingBoosts]);
}
var pendingBoosts;
var init_recall = __esm({
  "packages/core/src/memory/recall.ts"() {
    "use strict";
    init_store();
    init_config();
    init_syncable();
    init_lifecycle();
    init_filters();
    pendingBoosts = /* @__PURE__ */ new Set();
  }
});

// packages/core/src/memory/chunks.ts
async function docGroupIn(collection, id) {
  const [doc] = await getDocumentsByIds2(collection, [id]).catch(() => []);
  const baseId = doc ? doc.metadata.parent_id ?? doc.id : id;
  const chunks = await getDocumentsByFilter2(collection, { parent_id: baseId }, 1e4).catch(() => []);
  if (!doc && !chunks.length) return void 0;
  const docs = doc && !chunks.some((c) => c.id === doc.id) ? [doc, ...chunks] : chunks;
  return { collection, baseId, docs: docs.sort(byChunk) };
}
async function findDocGroup(id, collections) {
  for (const c of collections ?? (await listCollections2().catch(() => [])).map((x) => x.name)) {
    const g = await docGroupIn(c, id);
    if (g) return g;
  }
  return void 0;
}
var byChunk;
var init_chunks = __esm({
  "packages/core/src/memory/chunks.ts"() {
    "use strict";
    init_store();
    byChunk = (a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0);
  }
});

// packages/core/src/sync/deletes.ts
async function queueSyncDelete(docId, collection) {
  await getOrCreateCollection2("global");
  const existing = await getPendingDeletes();
  const entry = `${collection}:${docId}`;
  if (!existing.includes(entry)) {
    existing.push(entry);
  }
  await addDocument2("global", SYNC_DELETES_ID, "sync delete queue", {
    type: "sync_sentinel",
    pending_deletes: existing.join(",")
  });
}
async function queueSyncDeletes(docIds, collection) {
  if (docIds.length === 0) return;
  await getOrCreateCollection2("global");
  const existing = new Set(await getPendingDeletes());
  for (const id of docIds) existing.add(`${collection}:${id}`);
  await addDocument2("global", SYNC_DELETES_ID, "sync delete queue", {
    type: "sync_sentinel",
    pending_deletes: [...existing].join(",")
  });
}
async function getPendingDeletes() {
  try {
    const results = await getDocumentsByFilter2("global", { type: "sync_sentinel" }, 10);
    const sentinel = results.find((r) => r.id === SYNC_DELETES_ID);
    if (!sentinel) return [];
    const raw = sentinel.metadata.pending_deletes;
    if (!raw || raw === "") return [];
    return typeof raw === "string" ? raw.split(",").filter(Boolean) : [];
  } catch {
    return [];
  }
}
async function clearPendingDeletes(processed) {
  try {
    const done = processed ? new Set(processed) : void 0;
    const remaining = done ? (await getPendingDeletes()).filter((e) => !done.has(e)) : [];
    await addDocument2("global", SYNC_DELETES_ID, "sync delete queue", {
      type: "sync_sentinel",
      pending_deletes: remaining.join(",")
    });
  } catch {
  }
}
async function addLocalTombstone(docId) {
  await addLocalTombstones([docId]);
}
async function addLocalTombstones(docIds) {
  if (docIds.length === 0) return;
  await getOrCreateCollection2("global");
  const existing = await getLocalTombstones();
  const before = existing.size;
  for (const id of docIds) existing.add(id);
  if (existing.size === before) return;
  await addDocument2("global", SYNC_TOMBSTONES_ID, "sync tombstones", {
    type: "sync_tombstones",
    ids: [...existing].join(",")
  });
}
async function getLocalTombstones() {
  try {
    const results = await getDocumentsByFilter2("global", { type: "sync_tombstones" }, 1);
    const raw = results[0]?.metadata.ids;
    return new Set(typeof raw === "string" ? raw.split(",").filter(Boolean) : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function queueSyncPurges(docIds) {
  if (docIds.length === 0) return;
  await getOrCreateCollection2("global");
  const existing = new Set(await getPendingPurges());
  for (const id of docIds) existing.add(id);
  await addDocument2("global", SYNC_PURGES_ID, "sync purge queue", {
    type: "sync_sentinel",
    pending_purges: [...existing].join(",")
  });
}
async function getPendingPurges() {
  try {
    const results = await getDocumentsByFilter2("global", { type: "sync_sentinel" }, 10);
    const raw = results.find((r) => r.id === SYNC_PURGES_ID)?.metadata.pending_purges;
    return typeof raw === "string" ? raw.split(",").filter(Boolean) : [];
  } catch {
    return [];
  }
}
async function clearPendingPurges(processed) {
  try {
    const done = new Set(processed);
    const remaining = (await getPendingPurges()).filter((id) => !done.has(id));
    await addDocument2("global", SYNC_PURGES_ID, "sync purge queue", { type: "sync_sentinel", pending_purges: remaining.join(",") });
  } catch {
  }
}
var SYNC_DELETES_ID, SYNC_TOMBSTONES_ID, SYNC_PURGES_ID;
var init_deletes = __esm({
  "packages/core/src/sync/deletes.ts"() {
    "use strict";
    init_store();
    SYNC_DELETES_ID = "__sync_deletes__";
    SYNC_TOMBSTONES_ID = "__sync_tombstones__";
    SYNC_PURGES_ID = "__sync_purges__";
  }
});

// packages/core/src/memory/forget.ts
function isSyncable(collection) {
  return !collection.startsWith("private-") && !collection.startsWith("local-");
}
async function deleteDocumentEverywhere(id) {
  const group = await findDocGroup(id);
  if (!group) throw new Error(`Document '${id}' not found in any collection`);
  for (const d of group.docs) assertWritable(d.id, d.metadata);
  const { collection, docs } = group;
  for (const d of docs) await deleteDocument2(collection, d.id);
  if (getConfig().SYNC_ENABLED && isSyncable(collection)) {
    for (const d of docs) {
      const owner = d.metadata.origin_user;
      if (!owner || owner === getConfig().USERNAME) await queueSyncDelete(d.id, collection);
      else await addLocalTombstone(d.id);
    }
  }
  return collection;
}
async function forgetMemory(id) {
  return deleteDocumentEverywhere(id);
}
var init_forget = __esm({
  "packages/core/src/memory/forget.ts"() {
    "use strict";
    init_config();
    init_store();
    init_chunks();
    init_deletes();
    init_syncable();
  }
});

// packages/core/src/memory/list.ts
async function listMemories(options = {}) {
  const limit = options.limit ?? 50;
  const includePromoted = options.include_promoted ?? false;
  const filter = { type: "memory" };
  if (options.sector) filter.sector = options.sector;
  if (options.kind) filter.kind = options.kind;
  if (options.status) filter.status = options.status;
  if (options.owner) filter.owner = options.owner;
  const fetchLimit = options.tags?.length ? Math.max(limit, 5e3) : limit;
  const collectionNames = options.collection ? [options.collection] : (await listCollections2()).map((c) => c.name);
  const allResults = [];
  for (const name of collectionNames) {
    try {
      const docs = await getDocumentsByFilter2(name, filter, fetchLimit);
      for (const doc of docs) {
        allResults.push({ ...doc, collection: name });
      }
    } catch {
      continue;
    }
  }
  let filtered = allResults;
  if (options.tags?.length) {
    filtered = filtered.filter((r) => {
      const docTags = Array.isArray(r.metadata.tags) ? r.metadata.tags : (r.metadata.tags ?? "").split(",").filter(Boolean);
      return options.tags.some((t) => docTags.includes(t));
    });
  }
  const includeArchived = options.include_archived ?? false;
  filtered = filtered.filter(
    (r) => passesPromotedFilter(r.metadata, includePromoted) && passesScoreFilters(r.metadata, options.filters) && (includeArchived || r.metadata.archived !== true)
  );
  return filtered.sort((a, b) => (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0)).slice(0, limit);
}
var init_list = __esm({
  "packages/core/src/memory/list.ts"() {
    "use strict";
    init_store();
    init_filters();
  }
});

// packages/core/src/sync/health.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
function healthStatusFor(code) {
  if (typeof code === "string" && SIGNED_OUT.has(code)) return "signed_out";
  if (code === "unreachable") return "unreachable";
  return "error";
}
function readSyncHealth(path3 = getConfig().SYNC_HEALTH_FILE) {
  if (!path3) return void 0;
  try {
    const h = JSON.parse(readFileSync3(path3, "utf-8"));
    return h && typeof h.status === "string" && typeof h.at === "number" ? h : void 0;
  } catch {
    return void 0;
  }
}
function recordSyncHealth(update, now = Date.now(), path3 = getConfig().SYNC_HEALTH_FILE) {
  if (!path3) return void 0;
  const prev = readSyncHealth(path3);
  const config = getConfig();
  const next = { status: update.status, at: now, interval_ms: config.SYNC_INTERVAL_MS, label: config.STATUS_LABEL };
  if (config.REMOTE_NAME) next.remote = config.REMOTE_NAME;
  if (config.SYNC_MCP_URL) next.sign_in = "sign in to the MCP gateway";
  if (prev?.last_ok_at) next.last_ok_at = prev.last_ok_at;
  const unpushed = update.unpushed ?? prev?.unpushed;
  if (unpushed !== void 0) next.unpushed = unpushed;
  if (update.status === "ok") {
    next.last_ok_at = now;
  } else if (update.status !== "disabled") {
    const failing = prev && prev.status !== "ok" && prev.status !== "disabled";
    next.since = failing ? prev.since ?? now : now;
    if ("code" in update && update.code) next.code = update.code;
    if ("message" in update && update.message) next.message = update.message.slice(0, 300);
  }
  try {
    mkdirSync2(dirname2(path3), { recursive: true, mode: 448 });
    const tmp = `${path3}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 384 });
    renameSync2(tmp, path3);
  } catch {
  }
  return next;
}
function recordUnpushed(unpushed, path3 = getConfig().SYNC_HEALTH_FILE) {
  const prev = readSyncHealth(path3);
  if (!prev || prev.unpushed === unpushed) return;
  try {
    const tmp = `${path3}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...prev, unpushed }) + "\n", { mode: 384 });
    renameSync2(tmp, path3);
  } catch {
  }
}
function refreshSyncHealthNames(syncConfigured, path3 = getConfig().SYNC_HEALTH_FILE) {
  if (!path3) return;
  const prev = readSyncHealth(path3);
  if (!prev) {
    if (!syncConfigured) recordSyncHealth({ status: "disabled" }, Date.now(), path3);
    return;
  }
  const config = getConfig();
  const remote = config.REMOTE_NAME || void 0;
  if (prev.remote === remote && prev.label === config.STATUS_LABEL) return;
  const next = { ...prev, label: config.STATUS_LABEL };
  if (remote) next.remote = remote;
  else delete next.remote;
  try {
    const tmp = `${path3}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 384 });
    renameSync2(tmp, path3);
  } catch {
  }
}
var SIGNED_OUT;
var init_health = __esm({
  "packages/core/src/sync/health.ts"() {
    "use strict";
    init_config();
    SIGNED_OUT = /* @__PURE__ */ new Set(["token_command", "unauthenticated", "cloud_run_unauthenticated"]);
  }
});

// packages/core/src/sync/device.ts
import { randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3 } from "node:path";
function getDeviceId() {
  const config = getConfig();
  if (config.DEVICE_ID) return config.DEVICE_ID;
  if (cached?.path === config.DEVICE_ID_PATH) return cached.id;
  const path3 = config.DEVICE_ID_PATH;
  let id;
  try {
    id = readFileSync4(path3, "utf-8").trim();
  } catch {
    id = "";
  }
  if (!id) {
    id = randomUUID();
    try {
      mkdirSync3(dirname3(path3), { recursive: true });
      writeFileSync2(path3, `${id}
`, { flag: "wx" });
    } catch {
      try {
        id = readFileSync4(path3, "utf-8").trim() || id;
      } catch {
      }
    }
  }
  cached = { path: path3, id };
  return id;
}
function resetDeviceId() {
  cached = void 0;
}
var cached;
var init_device = __esm({
  "packages/core/src/sync/device.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/sync/postgres.ts
import { readFileSync as readFileSync5 } from "node:fs";
import pg from "pg";
function buildPoolConfig(databaseUrl, caCertPath) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
  }
  if (!url) {
    const host = /[?&]host=([^&]*)/.exec(databaseUrl)?.[1];
    if (host && decodeURIComponent(host).startsWith("/")) return { connectionString: databaseUrl, ssl: false, tls: "off" };
    if (caCertPath) {
      return { connectionString: databaseUrl, ssl: { ca: readFileSync5(caCertPath, "utf-8"), rejectUnauthorized: true, checkServerIdentity: () => void 0 }, tls: "verify-ca" };
    }
    return { connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, tls: "unverified" };
  }
  const sslmode = url.searchParams.get("sslmode");
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(k);
  const connectionString = url.toString();
  const verified = () => ({
    connectionString,
    ssl: { ca: readFileSync5(caCertPath, "utf-8"), rejectUnauthorized: true, checkServerIdentity: () => void 0 },
    tls: "verify-ca"
  });
  const unverified = { connectionString, ssl: { rejectUnauthorized: false }, tls: "unverified" };
  if (sslmode === "disable") return { connectionString, ssl: false, tls: "off" };
  if (caCertPath) return verified();
  if (sslmode === "verify-ca" || sslmode === "verify-full") {
    throw new Error(`sslmode=${sslmode} needs the server CA: set YAPA_SYNC_CA_CERT (plugin option sync_ca_cert)`);
  }
  if (sslmode) return unverified;
  const hostParam = url.searchParams.get("host");
  const local2 = hostParam ? hostParam.startsWith("/") || LOCAL_HOSTS.has(hostParam) : LOCAL_HOSTS.has(url.hostname);
  if (local2) return { connectionString, ssl: false, tls: "off" };
  return unverified;
}
function getSyncTlsMode() {
  return poolTls;
}
function getPool() {
  if (!pool) {
    const cfg = getConfig();
    const { connectionString, ssl, tls } = buildPoolConfig(cfg.SYNC_DATABASE_URL, cfg.SYNC_CA_CERT);
    if (tls === "unverified") {
      process.stderr.write("[yapa-sync] TLS without server verification: set YAPA_SYNC_CA_CERT (plugin option sync_ca_cert) to the server CA\n");
    }
    poolTls = tls;
    pool = new Pool({ connectionString, ssl, max: 5 });
  }
  return pool;
}
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
async function upsertRemoteDocument(doc) {
  const p = getPool();
  const embeddingStr = `[${doc.embedding.join(",")}]`;
  await p.query(
    `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at)
     VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, to_timestamp($7), to_timestamp($8))
     ON CONFLICT (id) DO UPDATE SET
       collection = EXCLUDED.collection,
       content = EXCLUDED.content,
       embedding = EXCLUDED.embedding,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at,
       synced_at = now()`,
    [doc.id, doc.collection, doc.content, embeddingStr, JSON.stringify(doc.metadata), doc.origin_user, doc.created_at, doc.updated_at]
  );
}
async function getRemoteCreatedAt(id) {
  const p = getPool();
  const result = await p.query("SELECT extract(epoch from created_at)::bigint AS c FROM documents WHERE id = $1", [id]);
  return result.rows[0] ? Number(result.rows[0].c) : void 0;
}
async function getRemoteOwnersByIds(ids) {
  if (ids.length === 0) return /* @__PURE__ */ new Map();
  const p = getPool();
  const result = await p.query("SELECT id, origin_user, extract(epoch from created_at)::bigint AS c FROM documents WHERE id = ANY($1::text[])", [ids]);
  return new Map(result.rows.map((r) => [r.id, { owner: r.origin_user, createdAt: Number(r.c) }]));
}
async function getRemoteCollectionsByIds(ids) {
  if (ids.length === 0) return /* @__PURE__ */ new Map();
  const p = getPool();
  const result = await p.query("SELECT id, collection FROM documents WHERE id = ANY($1::text[])", [ids]);
  return new Map(result.rows.map((r) => [r.id, r.collection]));
}
async function getRemoteMaxTaskNumber(user) {
  const p = getPool();
  const result = await p.query(
    `SELECT COALESCE(MAX(substring(id from $2)::bigint), 0) AS n FROM documents WHERE id ~ $1`,
    [`^${user.replace(/[^A-Za-z0-9_-]/g, "")}-[0-9]+$`, `^${user.replace(/[^A-Za-z0-9_-]/g, "")}-([0-9]+)$`]
  );
  return Number(result.rows[0]?.n ?? 0);
}
async function findSimilarRemote(collection, embedding, threshold = getConfig().SYNC_SIMILARITY_THRESHOLD, owner) {
  const p = getPool();
  const embeddingStr = `[${embedding.join(",")}]`;
  const result = await p.query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
     FROM documents
     WHERE collection = $2
       AND 1 - (embedding <=> $1::vector) > $3${owner ? "\n       AND origin_user = $4" : ""}
     ORDER BY similarity DESC
     LIMIT 5`,
    owner ? [embeddingStr, collection, threshold, owner] : [embeddingStr, collection, threshold]
  );
  return result.rows.map((r) => ({ id: r.id, similarity: parseFloat(r.similarity) }));
}
async function addRemoteRelatedIds(id, newRelatedIds) {
  const p = getPool();
  await p.query(
    `UPDATE documents
     SET related_ids = ARRAY(SELECT DISTINCT unnest(array_cat(related_ids, $1::text[]))),
         synced_at = now()
     WHERE id = $2`,
    [newRelatedIds, id]
  );
}
function buildRemoteDocsSinceQuery(collection, sinceTimestamp, self2, opts = {}) {
  const values = [collection, sinceTimestamp];
  const param = (v) => {
    values.push(v);
    return `$${values.length}`;
  };
  let text = `SELECT id, collection, content, embedding::text, metadata, origin_user, related_ids, synced_at, created_at, updated_at
     FROM documents
     WHERE collection = $1
       AND synced_at > to_timestamp($2)`;
  let userParam;
  if (!opts.includeOwnDevice) {
    userParam = param(self2.user);
    const deviceParam = param(self2.device);
    text += `
       AND COALESCE(metadata->>'origin_device', '') <> ${deviceParam}
       AND NOT (origin_user = ${userParam} AND metadata->>'origin_device' IS NULL)`;
  }
  if (opts.onlyOwnRows) text += `
       AND origin_user = ${userParam ?? param(self2.user)}`;
  text += `
     ORDER BY synced_at ASC`;
  return { text, values };
}
async function getRemoteDocsSince(collection, sinceTimestamp, self2, opts = {}) {
  const p = getPool();
  const query = buildRemoteDocsSinceQuery(collection, sinceTimestamp, self2, opts);
  const result = await p.query(query.text, query.values);
  return result.rows.map((r) => ({
    id: r.id,
    collection: r.collection,
    content: r.content,
    embedding: parseEmbedding(r.embedding),
    metadata: r.metadata,
    origin_user: r.origin_user,
    related_ids: r.related_ids ?? [],
    synced_at: r.synced_at,
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}
async function deleteRemoteDocuments(ids, owner) {
  if (ids.length === 0) return 0;
  const p = getPool();
  const result = await p.query(
    "DELETE FROM documents WHERE id = ANY($1::text[]) AND origin_user = $2",
    [ids, owner]
  );
  return result.rowCount ?? 0;
}
async function getRemoteCollectionsForUser(user) {
  const p = getPool();
  const result = await p.query("SELECT DISTINCT collection FROM documents WHERE origin_user = $1 ORDER BY collection", [user]);
  return result.rows.map((r) => r.collection);
}
async function getRemoteCollections() {
  const p = getPool();
  const result = await p.query(
    "SELECT collection, COUNT(*) AS count FROM documents GROUP BY collection ORDER BY collection"
  );
  return result.rows.map((r) => ({ name: r.collection, count: parseInt(r.count, 10) }));
}
async function checkRemoteHealth() {
  try {
    const p = getPool();
    const result = await p.query("SELECT 1 FROM schema_version LIMIT 1");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function parseEmbedding(embeddingStr) {
  return JSON.parse(embeddingStr);
}
var Pool, pool, LOCAL_HOSTS, poolTls;
var init_postgres = __esm({
  "packages/core/src/sync/postgres.ts"() {
    "use strict";
    init_config();
    ({ Pool } = pg);
    pool = null;
    LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
    poolTls = "off";
  }
});

// packages/core/src/sync/schema.ts
async function migrateSchema() {
  const pool2 = getPool();
  const tableCheck = await pool2.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'schema_version'
    ) AS exists
  `);
  if (!tableCheck.rows[0].exists) {
    process.stderr.write("[yapa-sync] Creating remote schema (v1)...\n");
    await pool2.query(SCHEMA_V1);
    await pool2.query("INSERT INTO schema_version (version) VALUES ($1)", [CURRENT_VERSION]);
    process.stderr.write("[yapa-sync] Remote schema created.\n");
    return;
  }
  const versionResult = await pool2.query("SELECT MAX(version) AS version FROM schema_version");
  const currentVersion = versionResult.rows[0]?.version ?? 0;
  if (currentVersion >= CURRENT_VERSION) {
    return;
  }
  process.stderr.write(`[yapa-sync] Schema is at v${currentVersion}, current is v${CURRENT_VERSION}.
`);
}
async function ensureVectorIndex() {
  try {
    const pool2 = getPool();
    const countResult = await pool2.query("SELECT COUNT(*) AS cnt FROM documents");
    const count = parseInt(countResult.rows[0].cnt, 10);
    if (count >= 100) {
      await pool2.query(IVFFLAT_INDEX);
    }
  } catch {
  }
}
var CURRENT_VERSION, SCHEMA_V1, IVFFLAT_INDEX;
var init_schema = __esm({
  "packages/core/src/sync/schema.ts"() {
    "use strict";
    init_postgres();
    CURRENT_VERSION = 1;
    SCHEMA_V1 = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  origin_user TEXT NOT NULL,
  related_ids TEXT[] DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_docs_collection ON documents(collection);
CREATE INDEX IF NOT EXISTS idx_docs_synced_at ON documents(synced_at);
CREATE INDEX IF NOT EXISTS idx_docs_origin_user ON documents(origin_user);
`;
    IVFFLAT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_docs_embedding ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
`;
  }
});

// packages/core/src/sync/postgres-backend.ts
var postgres_backend_exports = {};
__export(postgres_backend_exports, {
  PostgresBackend: () => PostgresBackend
});
var TLS_LABEL, PostgresBackend;
var init_postgres_backend = __esm({
  "packages/core/src/sync/postgres-backend.ts"() {
    "use strict";
    init_config();
    init_device();
    init_postgres();
    init_schema();
    TLS_LABEL = {
      "verify-ca": "encrypted, server verified",
      unverified: "encrypted, server NOT verified (set sync_ca_cert)",
      off: "off (local database)"
    };
    PostgresBackend = class {
      kind = "postgres";
      capabilities = { deletionsFeed: false };
      get target() {
        return getConfig().SYNC_DATABASE_URL.replace(/:[^:@/]*@/, ":***@");
      }
      async pull(collection, req) {
        const documents = await getRemoteDocsSince(
          collection,
          req.since,
          { user: getConfig().USERNAME, device: getDeviceId() },
          { includeOwnDevice: req.includeOwnDevice }
        );
        return { documents, deletions: [], hasMore: false };
      }
      async upsertMany(docs) {
        const out = [];
        for (const doc of docs) out.push(await this.upsertOne(doc));
        return out;
      }
      /**
       * Same checks the service makes, done client-side: a task id that already
       * belongs to a different task (creation time more than 1 s away) is not
       * overwritten but reported as `id_taken`; similar rows come back for linking.
       */
      async upsertOne(doc) {
        const me = getConfig().USERNAME;
        if (doc.metadata.type === "task") {
          const localCreated = Number(doc.metadata.created_at);
          if (Number.isFinite(localCreated) && localCreated > 0) {
            const remoteCreated = await getRemoteCreatedAt(doc.id);
            if (remoteCreated !== void 0 && Math.abs(remoteCreated - localCreated) > 1) {
              const max = await getRemoteMaxTaskNumber(me);
              return { id: doc.id, ok: false, code: "id_taken", message: "this task id belongs to a different task", permanent: false, suggestedId: `${me}-${max + 1}` };
            }
          }
        }
        const similar = doc.embedding.length > 0 ? (await findSimilarRemote(doc.collection, doc.embedding)).filter((s) => s.id !== doc.id) : [];
        await upsertRemoteDocument(doc);
        return { id: doc.id, ok: true, status: "updated", similar };
      }
      delete(ids) {
        return deleteRemoteDocuments(ids, getConfig().USERNAME);
      }
      collections() {
        return getRemoteCollections();
      }
      collectionsForUser() {
        return getRemoteCollectionsForUser(getConfig().USERNAME);
      }
      collectionsByIds(ids) {
        return getRemoteCollectionsByIds(ids);
      }
      ownersByIds(ids) {
        return getRemoteOwnersByIds(ids);
      }
      createdAt(id) {
        return getRemoteCreatedAt(id);
      }
      maxTaskNumber() {
        return getRemoteMaxTaskNumber(getConfig().USERNAME);
      }
      similar(collection, embedding, threshold) {
        return findSimilarRemote(collection, embedding, threshold);
      }
      addRelatedIds(id, add) {
        return addRemoteRelatedIds(id, add);
      }
      health() {
        return checkRemoteHealth();
      }
      async prepare() {
        const h = await checkRemoteHealth();
        if (!h.ok) await migrateSchema();
      }
      maintain() {
        return ensureVectorIndex();
      }
      async describe() {
        const lines = ["Backend: direct database (advanced/self-host)", `Remote: ${this.target}`];
        try {
          const health = await checkRemoteHealth();
          lines.push(`Connection: ${health.ok ? "healthy" : `error - ${health.error}`}`);
          lines.push(`TLS: ${TLS_LABEL[getSyncTlsMode()]}`);
        } catch (e) {
          lines.push(`Connection: error - ${e instanceof Error ? e.message : e}`);
        }
        return lines;
      }
      close() {
        return closePool();
      }
    };
  }
});

// packages/core/src/sync/http-backend.ts
var http_backend_exports = {};
__export(http_backend_exports, {
  FetchTransport: () => FetchTransport,
  HttpBackend: () => HttpBackend,
  IdTokenProvider: () => IdTokenProvider,
  ServiceError: () => ServiceError,
  TransportError: () => TransportError,
  decodeJwtPayload: () => decodeJwtPayload,
  programOf: () => programOf,
  redactTokens: () => redactTokens,
  runCommand: () => runCommand
});
import { readFileSync as readFileSync6, writeFileSync as writeFileSync3, mkdirSync as mkdirSync4, rmSync as rmSync2, renameSync as renameSync3 } from "node:fs";
import { dirname as dirname4 } from "node:path";
import { exec, execFile } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
function redactTokens(text) {
  return text.replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g, "<token>");
}
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) return void 0;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return json && typeof json === "object" ? json : void 0;
  } catch {
    return void 0;
  }
}
function runCommand(cmd, explain2, fallback) {
  return new Promise((resolve3, reject) => {
    const done = (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr).trim() || (err.killed ? "timed out" : exitText(err.code));
        const detail = redactTokens(why.split("\n").filter(Boolean).slice(-2).join(" ")).slice(0, 300);
        reject(new Error(explain2(detail)));
        return;
      }
      resolve3(String(stdout));
    };
    const opts = { timeout: TOKEN_CMD_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 };
    if (cmd || !fallback) exec(cmd, opts, done);
    else execFile(fallback.file, fallback.args, { ...opts, shell: process.platform === "win32" }, done);
  });
}
function programOf(cmd) {
  const word = cmd.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word && /^[\w./-]+$/.test(word) ? word.split("/").pop() || "the token command" : "the token command";
}
function exitText(code) {
  return typeof code === "number" ? `exit code ${code}` : String(code ?? "failed");
}
function runTokenCommand(cmd) {
  return runCommand(
    cmd,
    (detail) => `could not get a Google ID token from \`${cmd ? programOf(cmd) : "gcloud auth print-identity-token"}\`: ${detail}. Run \`gcloud auth login\` (or fix YAPA_SYNC_ID_TOKEN_CMD).`,
    { file: "gcloud", args: ["auth", "print-identity-token"] }
  );
}
function explain(status, code, message2, transport) {
  switch (code) {
    case "unauthenticated":
      return `the ${transport.label} rejected the sign-in (401). ${transport.signInHint}`;
    case "gateway_forbidden":
      return `the ${transport.label} refused the request (403): your account may not use this MCP server. Ask its admin.`;
    case "not_member":
      return "your Google account is not mapped to a YAPA user; ask a YAPA admin to add you.";
    case "user_inactive":
      return "your YAPA user is disabled; ask a YAPA admin.";
    case "rate_limited":
      return `rate limited by the sync service (${message2}); sync retries next cycle.`;
    case "unavailable":
      return "the sync service is temporarily unavailable; local changes stay unsynced and retry next cycle.";
    case "cloud_run_forbidden":
      return "Cloud Run refused the request (403): your Google account has no access to the sync service (roles/run.invoker). Ask a YAPA admin, then `gcloud auth login` with that account.";
    case "cloud_run_unauthenticated":
      return "Cloud Run rejected the ID token (401). Run `gcloud auth login`.";
    default:
      if (code.startsWith("http_")) {
        const body = message2.replace(/^HTTP \d+:?\s*/, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
        return `the ${transport.label} answered HTTP ${status}${body ? `: ${body}` : ""}`;
      }
      return `sync service error ${status} ${code}: ${message2}`;
  }
}
function toOutcome(id, r) {
  if (!r) return { id, ok: false, code: "internal", message: "no result for this document", permanent: false };
  if (r.status === "error") {
    const err = r.error ?? {};
    const code = String(err.code ?? "internal");
    return {
      id,
      ok: false,
      code,
      message: String(err.message ?? code),
      permanent: PERMANENT_ITEM_ERRORS.has(code),
      ...typeof err.suggested_id === "string" ? { suggestedId: err.suggested_id } : {}
    };
  }
  return { id, ok: true, status: String(r.status), ...r.stale ? { stale: true } : {}, similar: Array.isArray(r.similar) ? r.similar : [] };
}
function toDeletion(d) {
  const out = { id: d.id, deleted_by: d.deleted_by, deleted_at: Number(d.deleted_at) };
  if (d.reason === "delete" || d.reason === "retract") out.reason = d.reason;
  if (typeof d.purged === "boolean") out.purged = d.purged;
  return out;
}
function embeddingModelLabel() {
  const c = getConfig();
  if (c.EMBEDDING_PROVIDER === "chromadb") return "Xenova/all-MiniLM-L6-v2:q8";
  const m = getEmbeddingModel(c);
  return m ? `${c.EMBEDDING_PROVIDER}:${m}`.slice(0, 200) : void 0;
}
function byteBatches(items, maxItems, maxBytes) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (cur.length > 0 && (cur.length >= maxItems || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(item);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
var REFRESH_MARGIN_MS, OPAQUE_TOKEN_TTL_MS, TOKEN_CMD_TIMEOUT_MS, MAX_UPSERT_DOCS, MAX_UPSERT_BODY_BYTES, MAX_DELETE_IDS, MAX_LOOKUP_IDS, MAX_RELATED_IDS, PULL_PAGE_LIMIT, PERMANENT_ITEM_ERRORS, IdTokenProvider, ServiceError, TransportError, FetchTransport, HttpBackend;
var init_http_backend = __esm({
  "packages/core/src/sync/http-backend.ts"() {
    "use strict";
    init_config();
    init_device();
    init_backend();
    REFRESH_MARGIN_MS = 5 * 6e4;
    OPAQUE_TOKEN_TTL_MS = 6e4;
    TOKEN_CMD_TIMEOUT_MS = 2e4;
    MAX_UPSERT_DOCS = 50;
    MAX_UPSERT_BODY_BYTES = 15e5;
    MAX_DELETE_IDS = 500;
    MAX_LOOKUP_IDS = 1e3;
    MAX_RELATED_IDS = 100;
    PULL_PAGE_LIMIT = 500;
    PERMANENT_ITEM_ERRORS = /* @__PURE__ */ new Set([
      "secret_detected",
      "embedding_dimension",
      "embedding_invalid",
      "invalid_request",
      "invalid_collection",
      "local_only_collection",
      "task_namespace",
      "payload_too_large",
      "not_owner",
      // The owner purged the id: no write of it will ever be accepted.
      "purged"
    ]);
    IdTokenProvider = class {
      constructor(cmd = "", now = Date.now, cachePath = "", opaqueTtlMs) {
        this.now = now;
        this.cachePath = cachePath;
        this.opaqueTtlMs = opaqueTtlMs;
        this.run = typeof cmd === "function" ? cmd : () => runTokenCommand(cmd);
      }
      now;
      cachePath;
      opaqueTtlMs;
      token;
      validUntil = 0;
      inFlight;
      run;
      /** Bumped on every newly minted token (identity caches key on it). */
      generation = 0;
      async get() {
        if (this.token && this.now() < this.validUntil) return this.token;
        if (this.loadCached()) return this.token;
        this.inFlight ??= this.fetch().finally(() => {
          this.inFlight = void 0;
        });
        return this.inFlight;
      }
      invalidate() {
        this.token = void 0;
        this.validUntil = 0;
        if (this.cachePath) rmSync2(this.cachePath, { force: true });
      }
      validity(token, now) {
        const exp = Number(decodeJwtPayload(token)?.exp);
        if (!Number.isFinite(exp) || exp <= 0) return now + (this.opaqueTtlMs ?? OPAQUE_TOKEN_TTL_MS);
        const life = exp * 1e3 - now;
        return now + (life > 2 * REFRESH_MARGIN_MS ? life - REFRESH_MARGIN_MS : Math.max(0, life / 2));
      }
      /** Adopt a still-valid token cached by an earlier process (JWTs with `exp`, or opaque ones stored with their expiry). */
      loadCached() {
        if (!this.cachePath) return false;
        try {
          const [first = "", stored] = readFileSync6(this.cachePath, "utf-8").split("\n");
          const token = first.trim();
          if (!token) return false;
          const jwt = Number.isFinite(Number(decodeJwtPayload(token)?.exp));
          if (!jwt && (this.opaqueTtlMs === void 0 || !Number.isFinite(Number(stored)))) return false;
          const until = jwt ? this.validity(token, this.now()) : Number(stored);
          if (this.now() >= until) return false;
          this.token = token;
          this.validUntil = until;
          this.generation++;
          return true;
        } catch {
          return false;
        }
      }
      saveCached(token) {
        if (!this.cachePath) return;
        try {
          mkdirSync4(dirname4(this.cachePath), { recursive: true, mode: 448 });
          const tmp = `${this.cachePath}.${process.pid}.tmp`;
          const opaque = this.opaqueTtlMs !== void 0 && !Number.isFinite(Number(decodeJwtPayload(token)?.exp));
          writeFileSync3(tmp, opaque ? `${token}
${this.validUntil}` : token, { mode: 384 });
          renameSync3(tmp, this.cachePath);
        } catch {
        }
      }
      /** `email` claim of the cached token, if any (display only; the service verifies). */
      email() {
        const e = this.token ? decodeJwtPayload(this.token)?.email : void 0;
        return typeof e === "string" ? e : void 0;
      }
      async fetch() {
        const out = (await this.run()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const token = out[out.length - 1];
        if (!token || /\s/.test(token)) throw new Error("the ID token command printed no token. Run `gcloud auth login`.");
        this.token = token;
        this.validUntil = this.validity(token, this.now());
        this.generation++;
        this.saveCached(token);
        return token;
      }
    };
    ServiceError = class extends Error {
      constructor(message2, status, code, requestId, details = {}) {
        super(message2);
        this.status = status;
        this.code = code;
        this.requestId = requestId;
        this.details = details;
        this.name = "ServiceError";
      }
      status;
      code;
      requestId;
      details;
    };
    TransportError = class extends Error {
    };
    FetchTransport = class {
      kind = "http";
      label = "sync service";
      signInHint = "Run `gcloud auth login` (or check YAPA_SYNC_ID_TOKEN_CMD).";
      target;
      constructor(baseUrl) {
        this.target = baseUrl.replace(/\/+$/, "");
        if (!/^https?:\/\//.test(this.target)) throw new Error(`sync service URL must start with https:// (got "${this.target}")`);
      }
      async send(req, timeoutMs) {
        const body = req.body === void 0 ? void 0 : JSON.stringify(req.body);
        const headers = {
          authorization: `Bearer ${req.token}`,
          "x-yapa-id-token": req.token,
          "x-yapa-device": req.device,
          accept: "application/json"
        };
        if (body !== void 0) headers["content-type"] = "application/json";
        if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;
        let res;
        try {
          res = await fetch(`${this.target}${req.path}`, { method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
          throw new TransportError(e?.name === "TimeoutError" || e?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : redactTokens(String(e?.cause?.message ?? e?.message ?? e)));
        }
        const text = await res.text().catch(() => "");
        let json;
        try {
          json = text ? JSON.parse(text) : void 0;
        } catch {
          json = void 0;
        }
        return { status: res.status, statusText: res.statusText, json, header: (name) => res.headers.get(name) };
      }
      describe() {
        return ["Backend: YAPA sync service", `Service: ${this.target}`];
      }
      async close() {
      }
    };
    HttpBackend = class {
      kind = "service";
      capabilities = { deletionsFeed: true };
      target;
      transport;
      tokens;
      timeoutMs;
      device;
      meCache;
      constructor(opts = {}) {
        const config = getConfig();
        this.transport = opts.transport ?? new FetchTransport(opts.baseUrl ?? config.SYNC_SERVICE_URL);
        this.target = this.transport.target;
        this.tokens = opts.tokens ?? new IdTokenProvider(config.SYNC_ID_TOKEN_CMD, Date.now, config.SYNC_ID_TOKEN_CACHE);
        this.timeoutMs = opts.timeoutMs ?? config.SYNC_HTTP_TIMEOUT_MS;
        this.device = opts.device ?? getDeviceId;
      }
      get identitySource() {
        return this.transport.kind === "mcp" ? "your sign-in" : "your Google account";
      }
      fail(err, quiet = false) {
        if (!quiet || isSignedOutError(err)) noteSyncError(err);
        throw err;
      }
      async request(method, path3, opts = {}) {
        const idemKey = opts.idempotent ? randomUUID2() : void 0;
        for (let attempt2 = 0; ; attempt2++) {
          let token;
          try {
            token = await this.tokens.get();
          } catch (e) {
            return this.fail(new ServiceError(e instanceof Error ? e.message : String(e), 0, "token_command"), opts.quiet);
          }
          let res;
          try {
            res = await this.transport.send({ method, path: path3, body: opts.body, token, device: this.device(), idempotencyKey: idemKey }, this.timeoutMs);
          } catch (e) {
            if (e instanceof ServiceError) return this.fail(e, opts.quiet);
            const why = e instanceof TransportError ? e.message : redactTokens(String(e?.message ?? e));
            return this.fail(new ServiceError(`${this.transport.label} unreachable (${new URL(this.target).host}): ${why}`, 0, "unreachable"), opts.quiet);
          }
          const json = res.json;
          if (res.status >= 200 && res.status < 300) return json;
          if (res.status === 404 && opts.allow404) return void 0;
          const apiErr = json?.error;
          const iam = this.transport.kind === "http";
          const code = apiErr?.code ?? (iam && res.status === 401 ? "cloud_run_unauthenticated" : iam && res.status === 403 ? "cloud_run_forbidden" : `http_${res.status}`);
          if (res.status === 401 && attempt2 === 0) {
            this.tokens.invalidate();
            continue;
          }
          const message2 = redactTokens(String(apiErr?.message ?? res.statusText ?? "")).slice(0, 300);
          const details = { ...apiErr?.details ?? {} };
          const retryAfter = res.header("retry-after");
          if (retryAfter) details.retry_after = Number(retryAfter);
          return this.fail(new ServiceError(explain(res.status, code, message2, this.transport), res.status, code, apiErr?.request_id, details), opts.quiet);
        }
      }
      /** GET /v1/me, cached per process until the token is re-minted. */
      async me(refresh = false) {
        if (!this.meCache || refresh || this.meCache.generation !== this.tokens.generation) {
          const r = await this.request("GET", "/v1/me");
          this.meCache = { username: r.username, email: r.email, limits: r.limits, generation: this.tokens.generation };
        }
        return { username: this.meCache.username, email: this.meCache.email };
      }
      identity() {
        return this.me();
      }
      async dataRules() {
        await this.me();
        return parseDataRules(this.meCache?.limits);
      }
      cachedDataRules() {
        return this.meCache ? parseDataRules(this.meCache.limits) : void 0;
      }
      async pull(collection, req) {
        const q = new URLSearchParams();
        if (req.cursor) q.set("cursor", req.cursor);
        else q.set("since", String(Math.max(0, Math.floor(req.since))));
        q.set("limit", String(req.limit ?? PULL_PAGE_LIMIT));
        if (req.includeOwnDevice) q.set("include_own_device", "true");
        q.set("embeddings", "false");
        const r = await this.request("GET", `/v1/collections/${encodeURIComponent(collection)}/documents?${q}`);
        return {
          documents: (r.documents ?? []).map((d) => ({ ...d, related_ids: d.related_ids ?? [], metadata: d.metadata ?? {} })),
          deletions: (r.deletions ?? []).map(toDeletion),
          nextCursor: r.next_cursor,
          hasMore: Boolean(r.has_more)
        };
      }
      async upsertMany(docs) {
        const model = embeddingModelLabel();
        const items = docs.map((d) => ({
          id: d.id,
          collection: d.collection,
          content: d.content,
          embedding: d.embedding,
          ...model ? { embedding_model: model } : {},
          metadata: d.metadata,
          created_at: d.created_at,
          updated_at: d.updated_at
        }));
        const out = [];
        for (const batch of byteBatches(items, MAX_UPSERT_DOCS, MAX_UPSERT_BODY_BYTES)) {
          const r = await this.request("POST", "/v1/documents:batchUpsert", { body: { documents: batch }, idempotent: true });
          batch.forEach((item, i) => out.push(toOutcome(item.id, r.results?.[i])));
        }
        return out;
      }
      async delete(ids, reason = "delete") {
        let deleted = 0;
        for (const part of chunk(ids, MAX_DELETE_IDS)) {
          const r = await this.request("POST", "/v1/documents:batchDelete", { body: { ids: part, reason }, idempotent: true });
          deleted += Number(r.deleted ?? 0);
        }
        return deleted;
      }
      /**
       * Soft-delete routes (service schema v4) are user actions, not sync: they
       * are quiet (a failure does not mark sync unhealthy, a sign-out still
       * does), and an older service's `404 not_found` becomes an
       * UnsupportedByRemoteError.
       */
      async softDeleteCall(feature, method, path3, opts = {}) {
        try {
          return await this.request(method, path3, { ...opts, quiet: true });
        } catch (e) {
          if (e instanceof ServiceError && e.status === 404 && e.code === "not_found") throw new UnsupportedByRemoteError(feature);
          throw e;
        }
      }
      async listDeleted(collection, limit) {
        const q = new URLSearchParams();
        if (collection) q.set("collection", collection);
        if (limit !== void 0) q.set("limit", String(limit));
        const qs = q.toString();
        const r = await this.softDeleteCall("listing deleted documents", "GET", `/v1/me/deleted${qs ? `?${qs}` : ""}`);
        return (r.documents ?? []).map((d) => ({
          id: String(d.id),
          collection: String(d.collection),
          content: String(d.content ?? ""),
          metadata: d.metadata ?? {},
          deleted_at: Number(d.deleted_at),
          reason: d.reason === "retract" ? "retract" : "delete"
        }));
      }
      async restore(ids) {
        const out = [];
        for (const part of chunk([...new Set(ids)], MAX_DELETE_IDS)) {
          const r = await this.softDeleteCall("restoring deleted documents", "POST", "/v1/documents:restore", { body: { ids: part }, idempotent: true });
          const byId = new Map((r.results ?? []).map((x) => [x?.id, x]));
          for (const id of part) {
            const x = byId.get(id);
            if (x?.status === "restored") out.push({ id, status: "restored", synced_at: Number(x.synced_at ?? 0) });
            else out.push({ id, status: x?.status === "id_taken" ? "id_taken" : "not_found" });
          }
        }
        return out;
      }
      async purge(ids) {
        const out = [];
        for (const part of chunk([...new Set(ids)], MAX_DELETE_IDS)) {
          const r = await this.softDeleteCall("purging documents", "POST", "/v1/documents:purge", { body: { ids: part }, idempotent: true });
          const byId = new Map((r.results ?? []).map((x) => [x?.id, x]));
          for (const id of part) {
            const x = byId.get(id);
            if (x?.status === "purged" || x?.status === "purged_copies" || x?.status === "not_found") out.push({ id, status: x.status });
            else {
              const code = String(x?.error?.code ?? "internal");
              out.push({ id, status: "error", code, message: redactTokens(String(x?.error?.message ?? (x ? code : "no result for this id"))).slice(0, 300), permanent: PERMANENT_ITEM_ERRORS.has(code) });
            }
          }
        }
        return out;
      }
      async collections() {
        return (await this.request("GET", "/v1/collections")).collections ?? [];
      }
      async collectionsForUser() {
        return (await this.request("GET", "/v1/me/collections")).collections ?? [];
      }
      async collectionsByIds(ids) {
        const out = /* @__PURE__ */ new Map();
        for (const part of chunk(ids, MAX_LOOKUP_IDS)) {
          const r = await this.request("POST", "/v1/documents:collections", { body: { ids: part } });
          for (const [id, c] of Object.entries(r.collections ?? {})) out.set(id, c);
        }
        return out;
      }
      async ownersByIds(ids) {
        const out = /* @__PURE__ */ new Map();
        for (const part of chunk(ids, MAX_LOOKUP_IDS)) {
          const r = await this.request("POST", "/v1/documents:owners", { body: { ids: part } });
          for (const [id, owner] of Object.entries(r.owners ?? {})) out.set(id, { owner, createdAt: Number(r.created_at?.[id] ?? 0) });
        }
        return out;
      }
      async createdAt(id) {
        const r = await this.request("GET", `/v1/documents/${encodeURIComponent(id)}/created-at`, { allow404: true });
        return r ? Number(r.created_at) : void 0;
      }
      async maxTaskNumber() {
        return Number((await this.request("GET", "/v1/me/max-task-number")).max ?? 0);
      }
      coordination = {
        leaseAcquire: (req) => this.request("POST", "/v1/leases:acquire", {
          // scope and ttl_seconds only when given: an omitted one keeps a renewed lease's stored value.
          body: {
            collection: req.collection,
            key: req.key,
            session: req.session,
            scope: req.scope,
            ttl_seconds: req.ttlSeconds,
            title: req.title,
            ...req.reclaim ? { reclaim: true } : {}
          },
          quiet: true
        }),
        leaseHeartbeat: (collection, session, keys) => this.request("POST", "/v1/leases:heartbeat", { body: { collection, session, keys }, quiet: true }),
        leaseRelease: (collection, key, session, outcome) => this.request("POST", "/v1/leases:release", { body: { collection, key, session, outcome }, quiet: true }),
        leaseList: (collection, includeExpired = false) => {
          const q = new URLSearchParams({ collection });
          if (includeExpired) q.set("include_expired", "true");
          return this.request("GET", `/v1/leases?${q}`, { quiet: true });
        },
        // Idempotent: a retried request (401 refresh) must not burn a second value.
        counterNext: async (collection, name, floor) => Number((await this.request("POST", "/v1/counters:next", { body: { collection, name, floor }, idempotent: true, quiet: true })).value),
        nextTaskId: async (floor) => (await this.request("POST", "/v1/me/task-ids:next", { body: { floor }, idempotent: true, quiet: true })).id
      };
      async similar(collection, embedding, threshold) {
        const r = await this.request("POST", `/v1/collections/${encodeURIComponent(collection)}:similar`, {
          body: { embedding, ...threshold !== void 0 ? { threshold } : {}, limit: 5 }
        });
        return r.matches ?? [];
      }
      async addRelatedIds(id, add) {
        for (const part of chunk(add, MAX_RELATED_IDS)) {
          await this.request("POST", `/v1/documents/${encodeURIComponent(id)}/related-ids`, { body: { add: part } });
        }
      }
      async health() {
        try {
          await this.request("GET", "/v1/health");
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      /** Sign in once at startup; the service's username becomes the effective USERNAME. */
      async prepare() {
        applyServerUsername((await this.me(true)).username);
        const note = syncUsernameNote(this.identitySource);
        if (note) process.stderr.write(`[yapa-sync] ${note}
`);
      }
      async maintain() {
      }
      async describe() {
        const lines = this.transport.describe();
        try {
          const me = await this.me(true);
          applyServerUsername(me.username);
          lines.push(`Signed in as: ${me.username} (${me.email})`);
          const note = syncUsernameNote(this.identitySource);
          if (note) lines.push(note);
          lines.push(`Data rules: ${describeDataRules(parseDataRules(this.meCache?.limits))}`);
          lines.push("Connection: healthy");
        } catch (e) {
          lines.push(`Connection: error - ${e instanceof Error ? e.message : e}`);
        }
        return lines;
      }
      async close() {
        this.tokens.invalidate();
        this.meCache = void 0;
        await this.transport.close();
      }
    };
  }
});

// packages/core/src/sync/mcp-transport.ts
var mcp_transport_exports = {};
__export(mcp_transport_exports, {
  McpTransport: () => McpTransport,
  SYNC_TOOL: () => SYNC_TOOL,
  mcpTokenProvider: () => mcpTokenProvider,
  pickSyncTool: () => pickSyncTool,
  readSse: () => readSse
});
import { join as join5, dirname as dirname5 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
function mcpTokenProvider(config) {
  const cmd = config.SYNC_MCP_TOKEN_CMD.trim();
  const cache = config.SYNC_ID_TOKEN_CACHE ? join5(dirname5(config.SYNC_ID_TOKEN_CACHE), "mcp-token") : "";
  const fix = "Sign in to the MCP gateway again (or fix YAPA_SYNC_MCP_TOKEN_CMD).";
  return new IdTokenProvider(async () => {
    if (!cmd) throw new Error("sync over MCP needs a token command: set YAPA_SYNC_MCP_TOKEN_CMD (plugin option sync_mcp_token_cmd) to a command that prints your bearer token for the MCP gateway.");
    const out = await runCommand(cmd, (detail) => `could not get a token for the MCP gateway from \`${programOf(cmd)}\`: ${detail}. ${fix}`);
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const token = (lines[lines.length - 1] ?? "").replace(/^Bearer\s+/i, "");
    if (!token || /\s/.test(token)) throw new Error(`the MCP token command (\`${programOf(cmd)}\`) printed no token. ${fix}`);
    return token;
  }, Date.now, cache, OPAQUE_TOKEN_TTL_MS2);
}
function pickSyncTool(names, host, explicit = "") {
  if (explicit) {
    if (names.includes(explicit)) return explicit;
    throw new ServiceError(`the MCP server at ${host} has no tool named ${explicit} (YAPA_SYNC_MCP_TOOL).`, 0, "no_sync_tool");
  }
  if (names.includes(SYNC_TOOL)) return SYNC_TOOL;
  const prefixed = [...new Set(names.filter((n) => PREFIX_SEPARATORS.some((sep) => n.endsWith(`${sep}${SYNC_TOOL}`) && n.length > sep.length + SYNC_TOOL.length)))];
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ServiceError(`the MCP server at ${host} has several sync tools (${prefixed.join(", ")}). Set YAPA_SYNC_MCP_TOOL (plugin option sync_mcp_tool) to the one to use.`, 0, "ambiguous_sync_tool");
  }
  const near = names.filter((n) => n.endsWith(SYNC_TOOL));
  if (near.length) {
    throw new ServiceError(`the MCP server at ${host} has no ${SYNC_TOOL} tool, but has ${near.join(", ")}. If that is the sync tool, set YAPA_SYNC_MCP_TOOL (plugin option sync_mcp_tool) to it.`, 0, "no_sync_tool");
  }
  throw new ServiceError(`the MCP server at ${host} has no ${SYNC_TOOL} tool. Check YAPA_SYNC_MCP_URL, and that your account may use it.`, 0, "no_sync_tool");
}
async function readSse(res, id) {
  if (!res.body) throw new Error("the MCP server sent an empty event stream");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let data = [];
  const line = (l) => {
    if (l !== "") {
      if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
      return void 0;
    }
    const payload = data.join("\n");
    data = [];
    if (!payload) return void 0;
    try {
      const msg = JSON.parse(payload);
      return msg?.id === id && ("result" in msg || "error" in msg) ? msg : void 0;
    } catch {
      return void 0;
    }
  };
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      for (let m = /\r\n|\r|\n/.exec(buf); m; m = /\r\n|\r|\n/.exec(buf)) {
        if (m[0] === "\r" && m.index === buf.length - 1) break;
        const found2 = line(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        if (found2) return found2;
      }
    }
    const found = (buf ? line(buf) : void 0) ?? line("");
    if (found) return found;
  } finally {
    reader.cancel().catch(() => void 0);
  }
  throw new Error("the MCP server closed the event stream without a response");
}
function toResponse(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = void 0;
  }
  if (parsed && typeof parsed === "object" && Number.isInteger(parsed.status)) {
    const headers = new Map(Object.entries(parsed.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status: parsed.status, statusText: "", json: parsed.body ?? void 0, header: (name) => headers.get(name.toLowerCase()) ?? null };
  }
  const message2 = redactTokens(text).slice(0, 300) || "the tool returned no result";
  if (result?.isError && /unauthori[sz]ed|unauthenticated|\b401\b|(expired|invalid) token/i.test(message2)) return refusal(401, "unauthenticated", message2);
  return refusal(502, result?.isError ? "mcp_tool_error" : "bad_response", message2);
}
function refusal(status, code, message2, retryAfter = null) {
  return { status, statusText: "", json: { error: { code, message: message2 } }, header: (name) => name.toLowerCase() === "retry-after" ? retryAfter : null };
}
function describeFailure(e, timeoutMs) {
  const err = e;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `timed out after ${timeoutMs} ms`;
  return redactTokens(String(err?.cause?.message ?? err?.message ?? e)).slice(0, 300);
}
var SYNC_TOOL, PROTOCOL_VERSION, MAX_TOOL_PAGES, OPAQUE_TOKEN_TTL_MS2, END_SESSION_TIMEOUT_MS, PREFIX_SEPARATORS, LOOPBACK, HttpStatusError, RpcError, McpTransport;
var init_mcp_transport = __esm({
  "packages/core/src/sync/mcp-transport.ts"() {
    "use strict";
    init_http_backend();
    SYNC_TOOL = "yapa_sync";
    PROTOCOL_VERSION = "2025-06-18";
    MAX_TOOL_PAGES = 50;
    OPAQUE_TOKEN_TTL_MS2 = 50 * 6e4;
    END_SESSION_TIMEOUT_MS = 2e3;
    PREFIX_SEPARATORS = ["__", ".", "/", "-"];
    LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
    HttpStatusError = class extends Error {
      constructor(status, message2, retryAfter) {
        super(message2);
        this.status = status;
        this.retryAfter = retryAfter;
      }
      status;
      retryAfter;
    };
    RpcError = class extends Error {
    };
    McpTransport = class {
      constructor(url, opts = {}) {
        this.opts = opts;
        this.target = url.trim();
        if (!/^https?:\/\//.test(this.target)) throw new Error(`sync MCP URL must start with https:// (got "${this.target}")`);
        this.url = new URL(this.target);
        if (this.url.protocol === "http:" && !LOOPBACK.has(this.url.hostname)) {
          throw new Error(`sync MCP URL must use https:// (http:// only for localhost; got "${this.target}")`);
        }
      }
      opts;
      kind = "mcp";
      label = "MCP gateway";
      signInHint = "Sign in to the MCP gateway again (or check YAPA_SYNC_MCP_TOKEN_CMD).";
      target;
      url;
      session;
      opening;
      nextId = 1;
      async send(req, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        const args = {
          method: req.method,
          // The tool's path pattern has no room for the characters encodeURIComponent and URLSearchParams leave alone.
          path: req.path.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
          ...req.body === void 0 ? {} : { body: req.body },
          device: req.device,
          ...req.idempotencyKey ? { idempotency_key: req.idempotencyKey } : {},
          request_id: randomUUID3()
        };
        for (let attempt2 = 0; ; attempt2++) {
          const reused = this.session?.token === req.token;
          let session;
          try {
            session = await this.connect(req.token, deadline);
            const result = await this.rpc(session, "tools/call", { name: session.tool, arguments: args }, deadline);
            return toResponse(result);
          } catch (e) {
            if (session && this.session === session) this.session = void 0;
            if (e instanceof ServiceError) throw e;
            if (e instanceof RpcError) return refusal(502, "mcp_error", redactTokens(e.message).slice(0, 300));
            if (!(e instanceof HttpStatusError)) throw new TransportError(describeFailure(e, timeoutMs));
            const { status } = e;
            if (status === 401) return refusal(401, "unauthenticated", "the MCP gateway rejected the token");
            if (status === 403) return refusal(403, "gateway_forbidden", "the MCP gateway refused the request");
            if (status === 404 && reused && session?.id && attempt2 === 0) continue;
            if (status === 429) return refusal(429, "rate_limited", "the MCP gateway is rate limiting requests", e.retryAfter);
            return { status, statusText: e.message, json: void 0, header: () => null };
          }
        }
      }
      async connect(token, deadline) {
        if (this.session?.token === token) return this.session;
        if (this.session) this.end(this.session);
        this.session = void 0;
        if (this.opening?.token !== token) {
          const promise = this.open(token, deadline).finally(() => {
            if (this.opening?.promise === promise) this.opening = void 0;
          });
          this.opening = { token, promise };
        }
        return this.opening.promise;
      }
      async open(token, deadline) {
        const session = { token, tool: "" };
        try {
          const init = await this.rpc(session, "initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "yapa", version: "1" }
          }, deadline);
          session.protocol = typeof init?.protocolVersion === "string" ? init.protocolVersion : PROTOCOL_VERSION;
          await this.post(session, { jsonrpc: "2.0", method: "notifications/initialized" }, deadline);
          const names = [];
          let cursor;
          for (let page = 0; page < MAX_TOOL_PAGES; page++) {
            const r = await this.rpc(session, "tools/list", cursor ? { cursor } : {}, deadline);
            names.push(...(r?.tools ?? []).map((t) => String(t?.name ?? "")));
            cursor = r?.nextCursor;
            if (!cursor) break;
          }
          session.tool = pickSyncTool(names, this.url.host, this.opts.tool);
          this.session = session;
          return session;
        } catch (e) {
          this.end(session);
          throw e;
        }
      }
      async rpc(session, method, params, deadline) {
        const id = this.nextId++;
        const msg = await this.post(session, { jsonrpc: "2.0", id, method, params }, deadline, id);
        if (msg?.error) throw new RpcError(`MCP error ${msg.error.code}: ${msg.error.message}`);
        return msg?.result;
      }
      headers(session) {
        const headers = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${session.token}`
        };
        if (session.id) headers["mcp-session-id"] = session.id;
        if (session.protocol) headers["mcp-protocol-version"] = session.protocol;
        return headers;
      }
      /** POST one JSON-RPC message; with `id`, resolve with the response to it (JSON body or SSE stream). */
      async post(session, message2, deadline, id) {
        const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        const res = await fetch(this.url, { method: "POST", headers: this.headers(session), body: JSON.stringify(message2), signal });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new HttpStatusError(res.status, redactTokens(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`), res.headers.get("retry-after"));
        }
        session.id ??= res.headers.get("mcp-session-id") ?? void 0;
        if (id === void 0) {
          await res.body?.cancel();
          return void 0;
        }
        const type = res.headers.get("content-type") ?? "";
        if (type.includes("text/event-stream")) return readSse(res, id);
        const body = await res.json();
        const found = (Array.isArray(body) ? body : [body]).find((m) => m?.id === id);
        if (!found) throw new Error("the MCP server answered without a response to the request");
        return found;
      }
      /** Best effort: tell the server a session is over (DELETE), without waiting for it. */
      end(session) {
        if (!session.id) return;
        fetch(this.url, { method: "DELETE", headers: this.headers(session), signal: AbortSignal.timeout(END_SESSION_TIMEOUT_MS) }).then((r) => r.body?.cancel()).catch(() => void 0);
      }
      describe() {
        const lines = [`Backend: YAPA sync over MCP (${this.url.host})`, `MCP server: ${this.target}`];
        if (this.session) lines.push(`Tool: ${this.session.tool}`);
        return lines;
      }
      async close() {
        this.opening = void 0;
        if (this.session) this.end(this.session);
        this.session = void 0;
      }
    };
  }
});

// packages/core/src/sync/backend.ts
function syncBackendKind(config = getConfig()) {
  if (config.SYNC_MCP_URL || config.SYNC_SERVICE_URL) return "service";
  if (config.SYNC_DATABASE_URL) return "postgres";
  return void 0;
}
function syncTransportKind(config = getConfig()) {
  if (config.SYNC_MCP_URL) return "mcp";
  if (config.SYNC_SERVICE_URL) return "http";
  return void 0;
}
function isSyncConfigured(config = getConfig()) {
  return config.SYNC_ENABLED && syncBackendKind(config) !== void 0;
}
function keyOf(config) {
  return JSON.stringify([config.SYNC_MCP_URL, config.SYNC_MCP_TOKEN_CMD, config.SYNC_MCP_TOOL, config.SYNC_SERVICE_URL, config.SYNC_ID_TOKEN_CMD, config.SYNC_DATABASE_URL, config.SYNC_CA_CERT, config.SYNC_HTTP_TIMEOUT_MS]);
}
async function getSyncBackend() {
  const b = await selectBackend();
  if (b?.kind === "service" && serverUsername && getConfig().USERNAME !== serverUsername) applyServerUsername(serverUsername);
  return b;
}
async function selectBackend() {
  if (override) return override;
  const config = getConfig();
  const kind = syncBackendKind(config);
  if (!kind) return void 0;
  const key = keyOf(config);
  if (active3?.key === key) return active3.backend;
  if (active3) await active3.backend.close().catch(() => void 0);
  serverUsername = void 0;
  const backend = kind === "postgres" ? new (await Promise.resolve().then(() => (init_postgres_backend(), postgres_backend_exports))).PostgresBackend() : syncTransportKind(config) === "mcp" ? await mcpBackend(config) : new (await Promise.resolve().then(() => (init_http_backend(), http_backend_exports))).HttpBackend();
  active3 = { key, backend };
  return backend;
}
async function mcpBackend(config) {
  const [{ HttpBackend: HttpBackend2 }, { McpTransport: McpTransport2, mcpTokenProvider: mcpTokenProvider2 }] = await Promise.all([Promise.resolve().then(() => (init_http_backend(), http_backend_exports)), Promise.resolve().then(() => (init_mcp_transport(), mcp_transport_exports))]);
  return new HttpBackend2({ transport: new McpTransport2(config.SYNC_MCP_URL, { tool: config.SYNC_MCP_TOOL }), tokens: mcpTokenProvider2(config) });
}
async function requireSyncBackend() {
  const b = await getSyncBackend();
  if (!b) throw new Error("sync has no target: set YAPA_SYNC_SERVICE_URL (plugin option sync_service_url) or YAPA_SYNC_MCP_URL (sync_mcp_url)");
  return b;
}
function setSyncBackend(backend) {
  override = backend;
  serverUsername = void 0;
  configuredUsername = void 0;
}
async function closeSyncBackend() {
  const b = active3?.backend;
  active3 = void 0;
  serverUsername = void 0;
  if (b) await b.close();
}
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function noteSyncError(e) {
  const message2 = e instanceof Error ? e.message : String(e);
  lastError = { message: message2, at: Date.now() };
  const code = e?.code;
  recordSyncHealth({ status: healthStatusFor(code), code: typeof code === "string" ? code : void 0, message: message2 });
}
function noteSyncOk(unpushed) {
  lastError = void 0;
  recordSyncHealth({ status: "ok", unpushed });
}
function isSignedOutError(e) {
  return healthStatusFor(e?.code) === "signed_out";
}
function lastSyncError() {
  return lastError;
}
function isCycleFatal(e) {
  const code = e?.code;
  return typeof code === "string" && [
    "unreachable",
    "unauthenticated",
    "cloud_run_unauthenticated",
    "cloud_run_forbidden",
    "not_member",
    "user_inactive",
    "rate_limited",
    "unavailable",
    "token_command",
    "gateway_forbidden",
    "no_sync_tool",
    "ambiguous_sync_tool"
  ].includes(code);
}
function applyServerUsername(username) {
  serverUsername = username;
  const c = getConfig();
  if (c.USERNAME === username) return;
  configuredUsername = c.USERNAME;
  setConfig({ ...c, USERNAME: username });
}
async function resolveSyncUsername() {
  const b = await getSyncBackend();
  if (b?.identity) {
    try {
      applyServerUsername((await b.identity()).username);
    } catch {
    }
  }
  return getConfig().USERNAME;
}
function parseDataRules(limits) {
  const l = limits && typeof limits === "object" ? limits : {};
  const unrecognized = [];
  const days = l.deleted_retention_days;
  let deletedRetentionDays = REFERENCE_DATA_RULES.deletedRetentionDays;
  if (days === null || typeof days === "number" && Number.isInteger(days) && days >= 1) deletedRetentionDays = days;
  else if (days !== void 0) {
    deletedRetentionDays = void 0;
    unrecognized.push(`deleted_retention_days=${JSON.stringify(days)}`);
  }
  let erasure = REFERENCE_DATA_RULES.erasure;
  if (l.erasure === "delete" || l.erasure === "redact" || l.erasure === "none") erasure = l.erasure;
  else if (l.erasure !== void 0) {
    erasure = "none";
    unrecognized.push(`erasure=${JSON.stringify(l.erasure)}`);
  }
  return { deletedRetentionDays, erasure, ...unrecognized.length ? { unrecognized } : {} };
}
async function remoteDataRules(opts = {}) {
  if (!isSyncConfigured()) return void 0;
  try {
    const b = await getSyncBackend();
    if (opts.cachedOnly) return b?.cachedDataRules?.();
    return b?.dataRules ? await b.dataRules() : void 0;
  } catch {
    return void 0;
  }
}
function describeDataRules(r) {
  const kept = r.deletedRetentionDays === null ? "until purged" : r.deletedRetentionDays === void 0 ? "for an unknown time" : `${r.deletedRetentionDays} days`;
  if (r.unrecognized) {
    return `deleted documents restorable ${kept}; the remote declares rules this client does not know (${r.unrecognized.join(", ")}), so retracted or purged content may stay on it`;
  }
  const erased = { delete: "removed", redact: "redacted (an audit stub stays)", none: "kept on the remote, hidden (it cannot erase)" }[r.erasure];
  return `deleted documents restorable ${kept}; retracted or purged content ${erased}`;
}
function syncUsernameNote(source = (override ?? active3?.backend)?.identitySource) {
  if (!serverUsername || !configuredUsername || configuredUsername === serverUsername) return void 0;
  return `Username: using '${serverUsername}' from ${source ?? "your Google account"} (the username option '${configuredUsername}' is informational with the sync service)`;
}
var UnsupportedByRemoteError, override, active3, lastError, serverUsername, configuredUsername, REFERENCE_DATA_RULES;
var init_backend = __esm({
  "packages/core/src/sync/backend.ts"() {
    "use strict";
    init_config();
    init_health();
    UnsupportedByRemoteError = class extends Error {
      constructor(feature, message2 = `the sync service does not support ${feature} yet (it needs a newer service release)`) {
        super(message2);
        this.feature = feature;
        this.name = "UnsupportedByRemoteError";
      }
      feature;
      code = "unsupported_by_remote";
    };
    REFERENCE_DATA_RULES = { deletedRetentionDays: 30, erasure: "delete" };
  }
});

// packages/core/src/sync/local-coordination.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync7 } from "node:fs";
import { join as join6 } from "node:path";
function assertMatch(v, re, what) {
  if (typeof v !== "string" || !re.test(v)) throw bad(`${what} must match ${re.source}`);
  return v;
}
function assertScope(v) {
  if (v === void 0) return void 0;
  if (!Array.isArray(v) || v.length > MAX_SCOPE) throw bad(`scope must be an array of at most ${MAX_SCOPE} strings`);
  return [...new Set(v.map((s) => assertMatch(s, KEY_RE, "scope entries")))].sort();
}
function assertTtl(v) {
  if (v === void 0) return void 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < LEASE_TTL_MIN || v > LEASE_TTL_MAX) {
    throw bad(`ttl_seconds must be an integer from ${LEASE_TTL_MIN} to ${LEASE_TTL_MAX}`);
  }
  return v;
}
function assertFloor(v) {
  if (v === void 0 || v === null) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw bad("floor must be a non-negative integer");
  return v;
}
function effectiveScope(key, scope) {
  return [.../* @__PURE__ */ new Set([`key:${key}`, ...scope])].sort();
}
function localCoordinationDir() {
  return getConfig().LOCAL_COORD_DIR;
}
function stateFile(dir, collection) {
  return join6(dir, `${encodeURIComponent(collection)}.json`);
}
function readState2(file) {
  try {
    const s = JSON.parse(readFileSync7(file, "utf-8"));
    return { leases: s?.leases ?? {}, counters: s?.counters ?? {} };
  } catch (e) {
    if (e.code === "ENOENT") return { leases: {}, counters: {} };
    throw new Error(`local coordination state ${file} is unreadable (${e.message}). It holds only this collection's leases and counters on this machine: move it aside (mv "${file}" "${file}.bad") to start fresh. Live claims are then forgotten, and counters restart above the floor callers pass.`);
  }
}
function toLease(collection, l, now) {
  return {
    collection,
    key: l.key,
    holder: { user: l.user, session: l.session, device: l.device },
    title: l.title,
    scope: l.scope,
    ttl_seconds: l.ttl_seconds,
    acquired_at: l.acquired_at,
    heartbeat_at: l.heartbeat_at,
    expires_at: l.expires_at,
    expired: l.expires_at <= now,
    took_over_from: l.took_over_from
  };
}
function createLocalCoordination(opts = {}) {
  const dir = () => opts.dir ?? localCoordinationDir();
  const user = () => opts.user ?? getConfig().USERNAME;
  const clock = () => opts.now ? opts.now() : Math.floor(Date.now() / 1e3);
  function update(collection, fn, reserved = false) {
    if (!(reserved && RESERVED_RE.test(collection))) assertMatch(collection, COLLECTION_RE, "collection");
    const file = stateFile(dir(), collection);
    return withFileLockSync(lockFileFor(file), () => {
      const s = readState2(file);
      const { result, changed } = fn(s, clock());
      if (changed) writeJsonAtomic(file, s);
      return result;
    });
  }
  function collections() {
    try {
      return readdirSync2(dir()).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5)));
    } catch {
      return [];
    }
  }
  function bump(collection, name, floor, reserved) {
    assertMatch(name, COUNTER_RE, "name");
    const f = assertFloor(floor);
    return update(collection, (s) => {
      const value = Math.max(s.counters[name] ?? 0, f) + 1;
      s.counters[name] = value;
      return { result: value, changed: true };
    }, reserved);
  }
  const prune = (s, now) => {
    let changed = false;
    for (const [k, l] of Object.entries(s.leases)) {
      if (l.expires_at < now - EXPIRED_KEEP_SECONDS) {
        delete s.leases[k];
        changed = true;
      }
    }
    return changed;
  };
  const api = {
    local: true,
    async leaseAcquire(req) {
      const key = assertMatch(req.key, KEY_RE, "key");
      const session = assertMatch(req.session, SESSION_RE, "session");
      const reqScope = assertScope(req.scope);
      const reqTtl = assertTtl(req.ttlSeconds);
      if (req.title !== void 0 && req.title !== null && (typeof req.title !== "string" || req.title.length > 300)) {
        throw bad("title must be a string of at most 300 characters");
      }
      if (req.reclaim !== void 0 && typeof req.reclaim !== "boolean") throw bad("reclaim must be a boolean");
      const me = user();
      return update(req.collection, (s, now) => {
        prune(s, now);
        const prev = s.leases[key];
        const renewed = prev !== void 0 && isMine(prev, me, session);
        const scope = reqScope !== void 0 ? effectiveScope(key, reqScope) : renewed ? effectiveScope(key, prev.scope) : effectiveScope(key, []);
        const ttl = reqTtl ?? (renewed ? prev.ttl_seconds : LEASE_TTL_DEFAULT);
        const live = Object.values(s.leases).filter((l) => l.expires_at > now && (l.key === key || l.scope.some((x) => scope.includes(x))));
        const conflicts = live.filter((l) => !isMine(l, me, session) && !(req.reclaim && l.user === me)).map((l) => ({ lease: toLease(req.collection, l, now), overlap: l.key === key ? [`key:${key}`] : l.scope.filter((x) => scope.includes(x)) }));
        if (conflicts.length) return { result: { granted: false, conflicts }, changed: false };
        const reclaimed = !renewed && live.some((l) => l.key === key);
        const takeover = prev !== void 0 && !renewed ? {
          user: prev.user,
          session: prev.session,
          device: prev.device,
          expired_at: prev.expires_at,
          acquired_at: prev.acquired_at,
          ...reclaimed ? { reclaim: true } : {}
        } : void 0;
        const lease = {
          key,
          user: me,
          session,
          device: safeDeviceId(),
          // As the service's COALESCE: a takeover without a title keeps the old one.
          title: req.title ?? prev?.title ?? null,
          scope,
          ttl_seconds: ttl,
          acquired_at: renewed ? prev.acquired_at : now,
          heartbeat_at: now,
          expires_at: now + ttl,
          took_over_from: renewed ? prev.took_over_from : takeover ?? null
        };
        s.leases[key] = lease;
        return {
          result: { granted: true, lease: toLease(req.collection, lease, now), renewed, ...takeover ? { took_over_from: takeover } : {} },
          changed: true
        };
      });
    },
    async leaseHeartbeat(collection, session, keys) {
      assertMatch(session, SESSION_RE, "session");
      if (keys && collection === void 0) throw bad("keys needs a collection");
      const me = user();
      const renewed = [];
      for (const c of collection !== void 0 ? [collection] : collections()) {
        renewed.push(...update(c, (s, now) => {
          const out = [];
          for (const l of Object.values(s.leases)) {
            if (!isMine(l, me, session) || keys && !keys.includes(l.key)) continue;
            l.heartbeat_at = now;
            l.expires_at = now + l.ttl_seconds;
            out.push(toLease(c, l, now));
          }
          return { result: out, changed: out.length > 0 };
        }));
      }
      const lost = (keys ?? []).filter((k) => !renewed.some((l) => l.key === k));
      return { renewed, lost };
    },
    async leaseRelease(collection, key, session, outcome) {
      assertMatch(key, KEY_RE, "key");
      assertMatch(session, SESSION_RE, "session");
      if (outcome !== void 0) assertMatch(outcome, OUTCOME_RE, "outcome");
      const me = user();
      return update(collection, (s, now) => {
        const l = s.leases[key];
        if (!l) return { result: { released: false, reason: "not_held" }, changed: false };
        if (!isMine(l, me, session)) return { result: { released: false, reason: "held_by_other", lease: toLease(collection, l, now) }, changed: false };
        delete s.leases[key];
        return { result: { released: true, lease: toLease(collection, l, now) }, changed: true };
      });
    },
    async leaseList(collection, includeExpired = false) {
      assertMatch(collection, COLLECTION_RE, "collection");
      const now = clock();
      const s = readState2(stateFile(dir(), collection));
      const leases = Object.values(s.leases).filter((l) => includeExpired || l.expires_at > now).sort((a, b) => a.acquired_at - b.acquired_at || a.key.localeCompare(b.key)).map((l) => toLease(collection, l, now));
      return { leases, now };
    },
    async counterNext(collection, name, floor) {
      return bump(collection, name, floor, false);
    },
    async nextTaskId(floor) {
      const me = user();
      const n = bump(TASK_COUNTER_COLLECTION, assertMatch(me, COUNTER_RE, "username"), floor, true);
      return `${me}-${n}`;
    }
  };
  return api;
}
function safeDeviceId() {
  try {
    return getDeviceId();
  } catch {
    return null;
  }
}
var LEASE_TTL_MIN, LEASE_TTL_MAX, LEASE_TTL_DEFAULT, MAX_SCOPE, EXPIRED_KEEP_SECONDS, TASK_COUNTER_COLLECTION, KEY_RE, SESSION_RE, COUNTER_RE, OUTCOME_RE, COLLECTION_RE, RESERVED_RE, LocalCoordinationError, bad, isMine;
var init_local_coordination = __esm({
  "packages/core/src/sync/local-coordination.ts"() {
    "use strict";
    init_config();
    init_fs_lock();
    init_device();
    LEASE_TTL_MIN = 30;
    LEASE_TTL_MAX = 24 * 3600;
    LEASE_TTL_DEFAULT = 2 * 3600;
    MAX_SCOPE = 64;
    EXPIRED_KEEP_SECONDS = 7 * 24 * 3600;
    TASK_COUNTER_COLLECTION = "@tasks";
    KEY_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;
    SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
    COUNTER_RE = /^[A-Za-z0-9._:-]{1,64}$/;
    OUTCOME_RE = /^[A-Za-z0-9._ :-]{0,64}$/;
    COLLECTION_RE = /^[A-Za-z0-9._-]{1,200}$/;
    RESERVED_RE = /^@[a-z]+$/;
    LocalCoordinationError = class extends Error {
      constructor(code, message2) {
        super(message2);
        this.code = code;
        this.name = "LocalCoordinationError";
      }
      code;
      status = 400;
    };
    bad = (message2) => new LocalCoordinationError("invalid_request", message2);
    isMine = (l, user, session) => l.user === user && l.session === session;
  }
});

// packages/core/src/sync/coordination.ts
import { readdirSync as readdirSync3, readFileSync as readFileSync8, rmSync as rmSync3 } from "node:fs";
import { join as join7 } from "node:path";
function currentSession(explicit, env = process.env) {
  for (const v of [explicit, env.YAPA_SESSION, env.CLAUDE_CODE_SESSION_ID]) {
    if (v && SESSION_RE2.test(v)) return v;
  }
  return void 0;
}
function markerPath(session) {
  return join7(getConfig().LEASE_STATE_DIR, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function readMarker(session) {
  try {
    return JSON.parse(readFileSync8(markerPath(session), "utf-8"));
  } catch {
    return void 0;
  }
}
function writeMarker(m) {
  try {
    writeJsonAtomic(markerPath(m.session), m);
  } catch {
  }
}
function withMarker(session, fn, fallback) {
  try {
    return withFileLockSync(lockFileFor(markerPath(session)), fn, { waitMs: 2e3 });
  } catch {
    return fallback;
  }
}
function heldKeys(session, collection) {
  const prefix = heldKey(collection, "");
  return (readMarker(session)?.keys ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}
function noteLeaseHeld(session, ttlSeconds, now = Math.floor(Date.now() / 1e3), held2) {
  withMarker(session, () => {
    const prev = readMarker(session);
    const keys = new Set(prev?.keys ?? []);
    if (held2) keys.add(heldKey(held2.collection, held2.key));
    writeMarker({ session, min_ttl: Math.min(prev?.min_ttl ?? ttlSeconds, ttlSeconds), last_beat: now, ...keys.size ? { keys: [...keys] } : {} });
  }, void 0);
}
function noteLeaseReleased(session, collection, key) {
  withMarker(session, () => {
    const prev = readMarker(session);
    if (!prev?.keys) return;
    const keys = prev.keys.filter((k) => k !== heldKey(collection, key));
    writeMarker({ ...prev, keys });
  }, void 0);
}
function noteRenewed(session, renewed, now, answered = () => true, complete = true) {
  return withMarker(session, () => {
    const prev = readMarker(session);
    const have = new Set(renewed.map((l) => heldKey(l.collection, l.key)));
    const split2 = (k) => {
      const [collection, key] = k.split("\0");
      return { collection, key };
    };
    const watched = prev?.keys ?? [];
    const lost = watched.filter((k) => !have.has(k) && answered(split2(k).collection)).map(split2);
    const keys = watched.filter((k) => have.has(k) || !answered(split2(k).collection));
    if (renewed.length === 0 && keys.length === 0 && complete) {
      try {
        rmSync3(markerPath(session), { force: true });
      } catch {
      }
      return lost;
    }
    const ttls = renewed.map((l) => l.ttl_seconds);
    const minTtl = complete ? ttls.length ? Math.min(...ttls) : prev?.min_ttl ?? HEARTBEAT_MAX_INTERVAL_S * 3 : Math.min(prev?.min_ttl ?? Infinity, ...ttls, HEARTBEAT_MAX_INTERVAL_S * 3);
    writeMarker({ session, min_ttl: minTtl, last_beat: complete ? now : prev?.last_beat ?? now, ...keys.length ? { keys } : {} });
    return lost;
  }, []);
}
function sessionsHoldingLeases() {
  try {
    return readdirSync3(getConfig().LEASE_STATE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}
function noticesPath() {
  return join7(getConfig().LEASE_STATE_DIR, "notices.state");
}
function addClaimNotice(text, now = Math.floor(Date.now() / 1e3)) {
  try {
    withFileLockSync(lockFileFor(noticesPath()), () => {
      let list9 = [];
      try {
        list9 = JSON.parse(readFileSync8(noticesPath(), "utf-8"));
      } catch {
      }
      if (!Array.isArray(list9)) list9 = [];
      if (list9.some((n) => n.text === text)) return;
      list9.push({ at: now, text });
      writeJsonAtomic(noticesPath(), list9.slice(-20));
    }, { waitMs: 2e3 });
  } catch {
  }
}
function takeClaimNotices() {
  try {
    return withFileLockSync(lockFileFor(noticesPath()), () => {
      let list9 = [];
      try {
        list9 = JSON.parse(readFileSync8(noticesPath(), "utf-8"));
      } catch {
        return [];
      }
      rmSync3(noticesPath(), { force: true });
      return Array.isArray(list9) ? list9.map((n) => n.text) : [];
    }, { waitMs: 2e3 });
  } catch {
    return [];
  }
}
async function heartbeatIfDue(sessions, now = Math.floor(Date.now() / 1e3)) {
  let n = 0;
  for (const session of new Set(sessions.filter((s) => !!s && SESSION_RE2.test(s)))) {
    const m = readMarker(session);
    if (!m) continue;
    const interval = Math.max(10, Math.min(HEARTBEAT_MAX_INTERVAL_S, Math.floor(m.min_ttl / 3)));
    if (now - m.last_beat < interval) continue;
    const renewed = [];
    let localOk = false;
    let serviceOk = !isSyncConfigured();
    try {
      renewed.push(...(await localCoordination().leaseHeartbeat(void 0, session)).renewed);
      localOk = true;
    } catch {
    }
    if (!serviceOk) {
      try {
        renewed.push(...(await (await serviceCoordination()).leaseHeartbeat(void 0, session)).renewed);
        serviceOk = true;
      } catch {
      }
    }
    if (!localOk && !serviceOk) continue;
    const answered = (c) => coordinatedLocally(c) ? localOk : serviceOk;
    for (const l of noteRenewed(session, renewed, now, answered, localOk && serviceOk)) {
      addClaimNotice(`Your claim on ${l.key} (${l.collection}) is no longer held: another session took it over or released it. Check \`task_list\` (id ${l.key}) or \`lease list\` before continuing that work.`, now);
    }
    n += renewed.length;
  }
  return n;
}
async function serviceCoordination() {
  if (!isSyncConfigured()) {
    throw new CoordinationUnavailableError("not_configured", "leases and counters need the YAPA sync service (sync_enabled + sync_service_url or sync_mcp_url)");
  }
  const backend = await getSyncBackend();
  if (!backend?.coordination) {
    throw new CoordinationUnavailableError("unsupported", "leases and counters need the YAPA sync service; a direct Postgres sync target has none");
  }
  return wrap(backend.coordination);
}
function localCoordination() {
  if (!local) {
    const dir = getConfig().LOCAL_COORD_DIR;
    sweepLockDebris(dir);
    sweepLockDebris(join7(dir, "locks"));
    sweepLockDebris(getConfig().LEASE_STATE_DIR);
    local = guardLocal(createLocalCoordination());
  }
  return local;
}
function resetLocalCoordination() {
  local = void 0;
}
function coordinatedLocally(collection) {
  return !isSyncableCollection(collection) || !isSyncConfigured();
}
async function requireCoordination() {
  const pick = async (collection) => coordinatedLocally(collection) ? localCoordination() : serviceCoordination();
  return {
    leaseAcquire: async (req) => (await pick(req.collection)).leaseAcquire(req),
    leaseHeartbeat: async (collection, session, keys) => {
      if (collection !== void 0) return (await pick(collection)).leaseHeartbeat(collection, session, keys);
      const mine = await localCoordination().leaseHeartbeat(void 0, session);
      if (!isSyncConfigured()) return mine;
      try {
        const theirs = await (await serviceCoordination()).leaseHeartbeat(void 0, session);
        return { renewed: [...mine.renewed, ...theirs.renewed], lost: [] };
      } catch (e) {
        if (mine.renewed.length && isCoordinationUnavailable(e)) return { ...mine, unreachable: e.message };
        throw e;
      }
    },
    leaseRelease: async (collection, key, session, outcome) => (await pick(collection)).leaseRelease(collection, key, session, outcome),
    leaseList: async (collection, includeExpired) => (await pick(collection)).leaseList(collection, includeExpired),
    counterNext: async (collection, name, floor) => (await pick(collection)).counterNext(collection, name, floor),
    nextTaskId: async (floor) => (isSyncConfigured() ? serviceCoordination() : Promise.resolve(localCoordination())).then((c) => c.nextTaskId(floor))
  };
}
function isCoordinationUnavailable(e) {
  if (e instanceof CoordinationUnavailableError) return true;
  const err = e;
  return isCycleFatal(e) || err?.status === 404 && err?.code === "not_found";
}
function guardLocal(c) {
  const guard = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e?.code === "lock_timeout") {
        throw new CoordinationUnavailableError("unreachable", `this machine's coordination is busy: ${e.message}`);
      }
      throw e;
    }
  };
  return {
    leaseAcquire: guard(c.leaseAcquire),
    leaseHeartbeat: guard(c.leaseHeartbeat),
    leaseRelease: guard(c.leaseRelease),
    leaseList: guard(c.leaseList),
    counterNext: guard(c.counterNext),
    nextTaskId: guard(c.nextTaskId)
  };
}
function wrap(c) {
  const guard = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (isCoordinationUnavailable(e)) {
        throw new CoordinationUnavailableError("unreachable", `YAPA sync service could not coordinate: ${e.message}`);
      }
      throw e;
    }
  };
  return {
    leaseAcquire: guard(c.leaseAcquire),
    leaseHeartbeat: guard(c.leaseHeartbeat),
    leaseRelease: guard(c.leaseRelease),
    leaseList: guard(c.leaseList),
    counterNext: guard(c.counterNext),
    nextTaskId: guard(c.nextTaskId)
  };
}
var SESSION_RE2, HEARTBEAT_MAX_INTERVAL_S, heldKey, CoordinationUnavailableError, local;
var init_coordination = __esm({
  "packages/core/src/sync/coordination.ts"() {
    "use strict";
    init_config();
    init_fs_lock();
    init_backend();
    init_local_coordination();
    init_syncable();
    SESSION_RE2 = /^[A-Za-z0-9._:-]{1,128}$/;
    HEARTBEAT_MAX_INTERVAL_S = 300;
    heldKey = (collection, key) => `${collection}\0${key}`;
    CoordinationUnavailableError = class extends Error {
      constructor(reason, message2) {
        super(message2);
        this.reason = reason;
        this.name = "CoordinationUnavailableError";
      }
      reason;
      code = "coordination_unavailable";
    };
  }
});

// packages/core/src/tasks/create.ts
var create_exports = {};
__export(create_exports, {
  createTask: () => createTask,
  getNextTaskId: () => getNextTaskId
});
async function getNextTaskId(floor = 0, localOnly = false) {
  if (isSyncConfigured() && !localOnly) {
    await Promise.race([
      resolveSyncUsername(),
      new Promise((resolve3) => setTimeout(resolve3, 3e3).unref())
    ]).catch(() => void 0);
  }
  const collections = await listCollections2();
  let maxId = floor;
  for (const collection of collections) {
    try {
      const tasks = await getDocumentsByFilter2(collection.name, { type: "task" }, 1e3);
      for (const task of tasks) {
        const match = task.id.match(new RegExp(`^${getConfig().USERNAME}-(\\d+)$`));
        if (match) {
          maxId = Math.max(maxId, parseInt(match[1]));
        }
      }
    } catch {
      continue;
    }
  }
  if (isSyncConfigured() && !localOnly) {
    try {
      const backend = await getSyncBackend();
      if (backend?.coordination) {
        const id = await Promise.race([
          backend.coordination.nextTaskId(maxId),
          new Promise((resolve3) => setTimeout(() => resolve3(void 0), 3e3).unref())
        ]);
        if (id && id.startsWith(`${getConfig().USERNAME}-`)) return id;
      }
    } catch {
    }
  }
  if (isSyncConfigured() && !localOnly) {
    try {
      const backend = await getSyncBackend();
      const remote = !backend ? 0 : await Promise.race([
        backend.maxTaskNumber(),
        new Promise((resolve3) => setTimeout(() => resolve3(0), 3e3).unref())
      ]);
      maxId = Math.max(maxId, remote);
    } catch {
    }
  }
  try {
    const id = await localCoordination().nextTaskId(maxId);
    if (id.startsWith(`${getConfig().USERNAME}-`)) return id;
  } catch {
  }
  return `${getConfig().USERNAME}-${maxId + 1}`;
}
async function idTaken(id) {
  for (const c of await listCollections2().catch(() => [])) {
    try {
      if ((await getDocumentsByIds2(c.name, [id])).length) return true;
    } catch {
    }
  }
  return false;
}
async function freshTaskId() {
  let floor = 0;
  let id = await getNextTaskId();
  for (let i = 1; i < ID_ATTEMPTS && await idTaken(id); i++) {
    floor = Math.max(floor, Number(id.slice(id.lastIndexOf("-") + 1)) || 0);
    id = await getNextTaskId(floor, true);
  }
  return id;
}
async function createTask(title, options = {}, requested = "global") {
  const { collection } = await resolveWriteCollection(requested);
  await getOrCreateCollection2(collection);
  const id = await freshTaskId();
  const now = Math.floor(Date.now() / 1e3);
  const metadata = {
    type: "task",
    id,
    username: getConfig().USERNAME,
    title,
    notes: options.notes ?? "",
    tags: options.tags ?? [],
    status: options.status ?? "pending",
    priority: options.priority ?? "medium",
    due_date: options.due_date,
    customer: options.customer,
    project: options.project,
    depends_on: options.depends_on ?? [],
    blocks: options.blocks ?? [],
    ...options.claim_scope?.length ? { claim_scope: options.claim_scope } : {},
    is_recurring: options.is_recurring ?? false,
    recurrence_pattern: options.recurrence_pattern,
    created_at: now,
    updated_at: now,
    accessed_at: now,
    completed_at: options.completed_at ?? null,
    duration_minutes: options.duration_minutes ?? null,
    salience: options.salience ?? PRIORITY_SALIENCE[options.priority ?? "medium"],
    sector: "semantic"
  };
  metadata.is_synced = false;
  await addDocument2(collection, id, title, metadata);
  return id;
}
var PRIORITY_SALIENCE, ID_ATTEMPTS;
var init_create = __esm({
  "packages/core/src/tasks/create.ts"() {
    "use strict";
    init_config();
    init_store();
    init_backend();
    init_sentinel();
    init_coordination();
    PRIORITY_SALIENCE = {
      critical: 3,
      high: 2.5,
      medium: 2,
      low: 1.5
    };
    ID_ATTEMPTS = 5;
  }
});

// packages/core/src/memory/trash.ts
function toCopy(collection, d) {
  const at = Number(d.metadata.deleted_upstream_at) || 0;
  return {
    id: d.id,
    collection,
    type: String(d.metadata.type ?? "memory"),
    content: d.content,
    deleted_by: String(d.metadata.deleted_upstream_by ?? ""),
    deleted_at: at,
    reason: String(d.metadata.deleted_upstream_reason ?? "delete"),
    expires_at: at + getConfig().DELETED_RETENTION_DAYS * DAY,
    by_you: String(d.metadata.deleted_upstream_by ?? "") === getConfig().USERNAME
  };
}
async function listDeletedUpstream(collection) {
  const names = collection ? [collection] : (await listCollections2().catch(() => [])).map((c) => c.name);
  const out = [];
  for (const c of names) {
    for (const d of await getDocumentsByFilter2(c, { deleted_upstream: true }, 1e5).catch(() => [])) {
      if (isDeletedUpstream(d.metadata) && !(d.metadata.parent_id && (d.metadata.chunk_index ?? 0) !== 0)) out.push(toCopy(c, d));
    }
  }
  return out.sort((a, b) => b.deleted_at - a.deleted_at);
}
async function sweepDeletedUpstream(now = Math.floor(Date.now() / 1e3)) {
  const cutoff = now - getConfig().DELETED_RETENTION_DAYS * DAY;
  let n = 0;
  for (const c of (await listCollections2().catch(() => [])).map((x) => x.name)) {
    for (const d of await getDocumentsByFilter2(c, { deleted_upstream: true }, 1e5).catch(() => [])) {
      if (!isDeletedUpstream(d.metadata) || Number(d.metadata.deleted_upstream_at) > cutoff) continue;
      await deleteDocument2(c, d.id).catch(() => void 0);
      n++;
    }
  }
  return n;
}
async function keepDeletedUpstream(id, collection) {
  return withDocLock(collection, id, async () => {
    const [d] = await getDocumentsByIds2(collection, [id]);
    if (!d || !isDeletedUpstream(d.metadata)) throw new Error(`${id} is not a deleted copy in ${collection}`);
    const m = d.metadata;
    const tags = Array.isArray(m.tags) ? m.tags : String(m.tags ?? "").split(",").filter(Boolean);
    let newId;
    if (m.type === "task") {
      newId = await createTask(d.content, { priority: m.priority, tags, notes: m.notes ? `${m.notes}
(kept from ${id}, deleted by ${m.deleted_upstream_by})` : `(kept from ${id}, deleted by ${m.deleted_upstream_by})` }, collection);
    } else {
      const base = m.parent_id ?? d.id;
      const chunks = m.parent_id ? (await getDocumentsByFilter2(collection, { parent_id: base }, 1e3)).sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0)) : [d];
      newId = (await storeMemory(chunks.map((c) => c.content).join("\n"), { collection, tags, salience: m.salience })).ids[0];
      for (const c of chunks) if (c.id !== id) await deleteDocument2(collection, c.id);
    }
    await deleteDocument2(collection, id);
    return { id: newId, type: String(m.type ?? "memory") };
  });
}
async function listTrash(collection) {
  const out = { upstream: await listDeletedUpstream(collection), remote: [] };
  if (!isSyncConfigured()) {
    out.remoteUnavailable = "sync is off";
    return out;
  }
  try {
    const backend = await getSyncBackend();
    if (!backend?.listDeleted) out.remoteUnavailable = "this sync target has no soft delete";
    else out.remote = await backend.listDeleted(collection);
    out.rules = await remoteDataRules();
  } catch (e) {
    out.remoteUnavailable = e instanceof UnsupportedByRemoteError ? e.message : `the sync service could not be asked: ${e.message}`;
  }
  return out;
}
async function restoreDeleted(ids) {
  if (!isSyncConfigured()) throw new Error("restore needs the sync service (sync is off)");
  const backend = await getSyncBackend();
  if (!backend?.restore) throw new UnsupportedByRemoteError("restore");
  return backend.restore([...new Set(ids)]);
}
async function remoteGroup(id, deleted) {
  if (!deleted) return [];
  const row = deleted.find((d) => d.id === id);
  const base = row?.metadata?.parent_id ?? id;
  return deleted.filter((d) => d.id === base || d.metadata?.parent_id === base || d.id === id).map((d) => d.id);
}
async function purgeDocuments(ids) {
  const me = getConfig().USERNAME;
  const out = { queued: [], local: [], refused: [] };
  const collections = (await listCollections2().catch(() => [])).map((c) => c.name);
  let deleted = null;
  const queue = (xs) => {
    for (const x of xs) if (!out.queued.includes(x)) out.queued.push(x);
  };
  for (const id of [...new Set(ids)]) {
    const group = await findDocGroup(id, collections);
    if (!group) {
      if (deleted === null) {
        deleted = void 0;
        try {
          const backend = isSyncConfigured() ? await getSyncBackend() : void 0;
          if (backend?.listDeleted) deleted = await backend.listDeleted(void 0, 500);
        } catch {
        }
      }
      const rows = await remoteGroup(id, deleted);
      queue(rows.length ? rows : [id]);
      continue;
    }
    const theirs = group.docs.find((d) => d.metadata.origin_user && d.metadata.origin_user !== me);
    if (theirs) {
      out.refused.push({ id, collection: group.collection, owner: String(theirs.metadata.origin_user) });
      continue;
    }
    await withDocLock(group.collection, group.baseId, async () => {
      for (const d of group.docs) await deleteDocument2(group.collection, d.id);
    });
    const docIds = group.docs.map((d) => d.id);
    if (!isSyncableCollection(group.collection) || !isSyncConfigured()) out.local.push(...docIds);
    else queue(docIds);
  }
  await queueSyncPurges(out.queued);
  return out;
}
async function stillQueuedForPurge(ids) {
  const pending = new Set(await getPendingPurges());
  return ids.filter((id) => pending.has(id));
}
var DAY;
var init_trash = __esm({
  "packages/core/src/memory/trash.ts"() {
    "use strict";
    init_config();
    init_doc_lock();
    init_store();
    init_syncable();
    init_backend();
    init_deletes();
    init_chunks();
    init_store2();
    init_create();
    DAY = 86400;
  }
});

// packages/core/src/memory/decay.ts
async function lastSweepAt() {
  try {
    const results = await getDocumentsByFilter2("global", { type: { $eq: "decay_sentinel" } }, 1);
    return results[0]?.metadata.last_run;
  } catch {
    return void 0;
  }
}
async function runDecaySweep(now = Math.floor(Date.now() / 1e3)) {
  const collections = await listCollections2();
  const fallbackAnchor = await lastSweepAt() ?? now - DAY2;
  let decayedCount = 0;
  for (const collection of collections) {
    try {
      const docs = await getDocumentsByFilter2(collection.name, { type: "memory" }, SWEEP_LIMIT);
      const updates = [];
      for (const doc of docs) {
        const anchor = typeof doc.metadata.decayed_at === "number" ? doc.metadata.decayed_at : fallbackAnchor;
        const days = (now - anchor) / DAY2;
        if (days <= 0) continue;
        const lifecycleMeta = {
          salience: doc.metadata.salience ?? 1,
          accessed_at: doc.metadata.accessed_at ?? now,
          created_at: doc.metadata.created_at ?? now,
          sector: doc.metadata.sector ?? "episodic"
        };
        const decayed = applyDecay(lifecycleMeta, days);
        updates.push({ id: doc.id, patch: { salience: decayed.salience, decayed_at: now } });
      }
      if (updates.length > 0) {
        await patchDocuments2(collection.name, updates);
        decayedCount += updates.length;
      }
    } catch {
      continue;
    }
  }
  await sweepDeletedUpstream(now).catch(() => 0);
  return decayedCount;
}
async function shouldRunDecay(now = Math.floor(Date.now() / 1e3)) {
  const last = await lastSweepAt();
  return last === void 0 || now - last > DAY2;
}
async function markDecayRun(now = Math.floor(Date.now() / 1e3)) {
  const { addDocument: addDocument3, getOrCreateCollection: getOrCreateCollection3 } = await Promise.resolve().then(() => (init_store(), store_exports));
  await getOrCreateCollection3("global");
  await addDocument3("global", DECAY_SENTINEL_ID, "decay sentinel", {
    type: "decay_sentinel",
    last_run: now
  });
}
var DECAY_SENTINEL_ID, DAY2, SWEEP_LIMIT;
var init_decay = __esm({
  "packages/core/src/memory/decay.ts"() {
    "use strict";
    init_store();
    init_trash();
    init_lifecycle();
    DECAY_SENTINEL_ID = "__decay_sentinel__";
    DAY2 = 86400;
    SWEEP_LIMIT = 1e4;
  }
});

// packages/core/src/memory/compact.ts
async function collectionSize(collection) {
  try {
    const docs = await getDocumentsByFilter2(collection, { type: "memory" }, 1e4);
    return docs.filter((d) => d.metadata.archived !== true).length;
  } catch {
    return 0;
  }
}
function tagsOf(metadata) {
  if (Array.isArray(metadata.tags)) return metadata.tags;
  if (typeof metadata.tags === "string") return metadata.tags.split(",").filter(Boolean);
  return [];
}
function intersect(a, b) {
  const set = new Set(a);
  return b.filter((t) => set.has(t));
}
async function suggestCompaction(collection) {
  const all = (await getDocumentsByFilter2(collection, { type: "memory" }, 1e4)).filter((d) => d.metadata.archived !== true && !isMemoryKind(d.metadata.kind));
  if (all.length < getConfig().COMPACTION_MIN_GROUP_SIZE) return [];
  all.sort((a, b) => (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0));
  const consumed = /* @__PURE__ */ new Set();
  const groups = [];
  for (const seed of all) {
    if (consumed.has(seed.id)) continue;
    const neighbors = await queryDocuments2(collection, seed.content, 20, { type: "memory" });
    const matches = neighbors.filter(
      (n) => n.id !== seed.id && !consumed.has(n.id) && n.metadata.archived !== true && !isMemoryKind(n.metadata.kind) && n.distance < getConfig().COMPACTION_SIMILARITY_DISTANCE
    );
    if (matches.length + 1 < getConfig().COMPACTION_MIN_GROUP_SIZE) continue;
    const memberIds = [seed.id, ...matches.map((m) => m.id)];
    memberIds.forEach((id) => consumed.add(id));
    const sharedTags = matches.reduce(
      (acc, m) => intersect(acc, tagsOf(m.metadata)),
      tagsOf(seed.metadata)
    );
    groups.push({
      seed_id: seed.id,
      member_ids: memberIds,
      seed_content: seed.content,
      similar_content: matches.map((m) => m.content),
      shared_tags: sharedTags
    });
  }
  return groups;
}
async function applyCompaction(input2) {
  input2 = { ...input2, collection: (await resolveWriteCollection(input2.collection)).collection };
  const stored = await storeMemory(input2.summary, {
    collection: input2.collection,
    salience: 2,
    tags: ["compacted", ...input2.tags ?? []],
    sector: "semantic"
  });
  const summaryId = stored.ids[0];
  const archivedIds = [];
  for (const id of input2.member_ids) {
    try {
      const existing = await getDocumentsByIds2(input2.collection, [id]);
      if (!existing.length) continue;
      await patchDocument(input2.collection, id, metadataDelta(existing[0].metadata, archivedMetadata(existing[0].metadata, { compacted_into: summaryId })));
      archivedIds.push(id);
    } catch (e) {
      process.stderr.write(`[yapa] compact: failed to archive ${id}: ${e}
`);
    }
  }
  try {
    const summaryDocs = await getDocumentsByIds2(input2.collection, [summaryId]);
    if (summaryDocs.length) {
      await patchDocument(input2.collection, summaryId, { compacted_from: archivedIds });
    }
  } catch (e) {
    process.stderr.write(`[yapa] compact: failed to set back-reference on summary: ${e}
`);
  }
  return { summary_id: summaryId, archived_ids: archivedIds };
}
var init_compact = __esm({
  "packages/core/src/memory/compact.ts"() {
    "use strict";
    init_config();
    init_archive();
    init_store();
    init_store2();
    init_kinds();
    init_sentinel();
  }
});

// packages/core/src/memory/journal.ts
import { randomBytes } from "crypto";
async function journalAppend(entry, collection, sessionId2) {
  const { collection: col } = await resolveWriteCollection(collection ?? "global");
  const sid = sessionId2 ?? SESSION_ID;
  await getOrCreateCollection2(col);
  const now = Math.floor(Date.now() / 1e3);
  const id = `journal-${getConfig().USERNAME}-${sid}-${now}-${Math.random().toString(36).slice(2, 6)}`;
  await addDocument2(col, id, entry, {
    type: DRAFT_TYPE,
    username: getConfig().USERNAME,
    session_id: sid,
    created_at: now,
    is_synced: false
  });
  return id;
}
async function listSessionDrafts(collection, sessionId2) {
  const col = collection ?? "global";
  const sid = sessionId2 ?? SESSION_ID;
  try {
    const docs = await getDocumentsByFilter2(col, {
      type: DRAFT_TYPE,
      session_id: sid
    }, 1e3);
    return docs.map((d) => ({
      id: d.id,
      entry: d.content,
      created_at: d.metadata.created_at ?? 0,
      session_id: d.metadata.session_id ?? sid
    })).sort((a, b) => a.created_at - b.created_at);
  } catch {
    return [];
  }
}
async function journalConsolidate(input2 = {}) {
  const { collection: col } = await resolveWriteCollection(input2.collection ?? "global");
  const sid = input2.sessionId ?? SESSION_ID;
  const drafts = await listSessionDrafts(col, sid);
  if (drafts.length === 0) return null;
  const body = input2.summary ? input2.summary : drafts.map((d) => `- ${d.entry}`).join("\n");
  const stored = await storeMemory(`# Session journal (${sid})

${body}`, {
    collection: col,
    salience: 1.5,
    sector: "episodic",
    tags: ["journal"]
  });
  for (const d of drafts) {
    try {
      await deleteDocument2(col, d.id);
    } catch (e) {
      process.stderr.write(`[yapa] journal: failed to delete draft ${d.id}: ${e}
`);
    }
  }
  return { memory_id: stored.ids[0], draft_count: drafts.length };
}
async function consolidateSessionEverywhere(sessionId2 = SESSION_ID) {
  const out = [];
  for (const col of await listCollections2().catch(() => [])) {
    try {
      const result = await journalConsolidate({ collection: col.name, sessionId: sessionId2 });
      if (result) out.push(result);
    } catch (e) {
      process.stderr.write(`[yapa] journal: consolidate failed in ${col.name}: ${e}
`);
    }
  }
  return out;
}
async function consolidateStaleDrafts(maxAgeSeconds = 24 * 3600) {
  const cutoff = Math.floor(Date.now() / 1e3) - maxAgeSeconds;
  const out = [];
  for (const col of await listCollections2().catch(() => [])) {
    let drafts;
    try {
      drafts = await getDocumentsByFilter2(col.name, { type: DRAFT_TYPE }, 1e3);
    } catch {
      continue;
    }
    const sessions = /* @__PURE__ */ new Map();
    for (const d of drafts) {
      const sid = d.metadata.session_id;
      if (!sid) continue;
      if (d.metadata.username && d.metadata.username !== getConfig().USERNAME) continue;
      sessions.set(sid, Math.max(sessions.get(sid) ?? 0, d.metadata.created_at ?? 0));
    }
    for (const [sid, newest] of sessions) {
      if (newest > cutoff) continue;
      const result = await journalConsolidate({ collection: col.name, sessionId: sid }).catch(() => null);
      if (result) out.push(result);
    }
  }
  return out;
}
var SESSION_ID, DRAFT_TYPE;
var init_journal = __esm({
  "packages/core/src/memory/journal.ts"() {
    "use strict";
    init_config();
    init_store();
    init_store2();
    init_sentinel();
    SESSION_ID = process.env.YAPA_SESSION_ID ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
    DRAFT_TYPE = "journal_draft";
  }
});

// packages/core/src/tasks/list.ts
async function listTasks(filters = {}) {
  const collectionNames = filters.collection ? [filters.collection] : (await listCollections2()).map((c) => c.name);
  const allTasks = [];
  for (const name of collectionNames) {
    const where = { type: "task" };
    if (filters.status) where.status = filters.status;
    if (filters.priority) where.priority = filters.priority;
    if (filters.customer) where.customer = filters.customer;
    if (filters.project) where.project = filters.project;
    try {
      const tasks = await getDocumentsByFilter2(name, where, READ_LIMIT);
      for (const task of tasks) {
        if (!filters.includeComplete && task.metadata.status === "complete") continue;
        if (task.metadata.archived === true && !filters.includeArchived) continue;
        allTasks.push({
          id: task.id,
          title: task.content,
          collection: name,
          metadata: task.metadata
        });
      }
    } catch {
      continue;
    }
  }
  const sorted = allTasks.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.metadata.priority] ?? 0;
    const pB = PRIORITY_ORDER[b.metadata.priority] ?? 0;
    if (pB !== pA) return pB - pA;
    return (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0);
  });
  return filters.limit !== void 0 ? sorted.slice(0, filters.limit) : sorted;
}
async function getDueTasks(includeOverdue = true) {
  const now = Math.floor(Date.now() / 1e3);
  const tasks = await listTasks({ includeComplete: false });
  return tasks.filter((t) => t.metadata.due_date).map((t) => {
    const daysUntil = Math.ceil((t.metadata.due_date - now) / (24 * 60 * 60));
    return { ...t, daysUntil };
  }).filter((t) => includeOverdue || t.daysUntil >= 0).sort((a, b) => a.daysUntil - b.daysUntil);
}
var PRIORITY_ORDER, READ_LIMIT;
var init_list2 = __esm({
  "packages/core/src/tasks/list.ts"() {
    "use strict";
    init_store();
    PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };
    READ_LIMIT = 1e4;
  }
});

// packages/core/src/tasks/close.ts
function validateLearned(items = []) {
  for (const it of items) {
    if (!it.content?.trim()) throw new Error("each learned item needs content");
    const { content: _c, tags: _t, ...typed } = it;
    normalizeTyped(typed);
  }
}
async function recordForTask(task, input2) {
  const out = { memories: [], follow_ups: [] };
  for (const it of input2.learned ?? []) {
    const { content, tags, ...typed } = it;
    const r = await storeMemory(content, {
      collection: task.collection,
      tags,
      typed: { ...typed, task_ids: [.../* @__PURE__ */ new Set([task.id, ...typed.task_ids ?? []])] }
    });
    out.memories.push(r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, "") : r.ids[0]);
  }
  for (const f of input2.follow_ups ?? []) {
    if (!f.title?.trim()) continue;
    const notes = [f.notes?.trim(), `From ${task.id}.`].filter(Boolean).join("\n");
    out.follow_ups.push(await createTask(f.title.trim(), { priority: f.priority, tags: f.tags, notes }, f.collection ?? task.collection));
  }
  return out;
}
async function requestDecision(taskId, d, ctx = {}, extra = {}) {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!d.question?.trim()) throw new Error("decision_needed needs a question");
  const content = [d.question.trim(), d.context?.trim()].filter(Boolean).join("\n\n");
  const typed = normalizeTyped({
    kind: "decision",
    status: "needed",
    options: d.options,
    task_ids: [task.id],
    ...d.recommendation ? { recommendation: d.recommendation } : {},
    ...d.owner ? { owner: d.owner } : {}
  });
  const r = await storeMemory(content, { collection: task.collection, typed });
  const decision = r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, "") : r.ids[0];
  const waits = [.../* @__PURE__ */ new Set([...list4(task.metadata.waits_on), decision])];
  const u = await updateTask(task.id, { ...extra, status: "pending", waits_on: waits }, ctx);
  return { ...u, decision };
}
async function findMemory(id, prefer) {
  const names = (await listCollections2().catch(() => [])).map((c) => c.name);
  const order = prefer ? [prefer, ...names.filter((n) => n !== prefer)] : names;
  for (const name of order) {
    const [d] = await getDocumentsByIds2(name, [id]).catch(() => []);
    if (d) return { collection: name, metadata: d.metadata };
    const [chunk2] = await getDocumentsByIds2(name, [`${id}-0`]).catch(() => []);
    if (chunk2) return { collection: name, metadata: chunk2.metadata };
  }
  return null;
}
async function openWaits(metadata, collection) {
  const out = [];
  for (const start of list4(metadata.waits_on)) {
    let id = start;
    let found = await findMemory(id, collection);
    for (let hops = 0; found?.metadata.archived === true && found.metadata.superseded_by && hops < 5; hops++) {
      id = String(found.metadata.superseded_by);
      found = await findMemory(id, found.collection);
    }
    if (found && isOpenTyped(found.metadata)) {
      out.push({ id, kind: found.metadata.kind, status: found.metadata.status, ...found.metadata.owner ? { owner: String(found.metadata.owner) } : {} });
    }
  }
  return out;
}
function captureNudge(taskId, metadata, recorded) {
  if (recorded?.memories.length || list4(metadata.memory_ids).length) return void 0;
  return `Nothing was recorded for ${taskId}: if it produced a finding, a decision or a follow-up, record it (memory_store with task_ids: ["${taskId}"], or task_create).`;
}
var list4, describeWaits;
var init_close = __esm({
  "packages/core/src/tasks/close.ts"() {
    "use strict";
    init_store();
    init_kinds();
    init_store2();
    init_create();
    init_update();
    list4 = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map(String).filter(Boolean);
    describeWaits = (w) => `waiting on ${w.map((x) => `${x.kind} ${x.id} (${x.status}${x.owner ? `, for ${x.owner}` : ""})`).join(", ")}`;
  }
});

// packages/core/src/sync/push.ts
import { createHash as createHash2 } from "node:crypto";
function emptyPushStats() {
  return { pushed: 0, linked: 0, deleted: 0, purged: 0, retracted: 0, rejected: 0, renamed: 0, errors: 0 };
}
function syncFingerprint(doc) {
  const skip = /* @__PURE__ */ new Set([...LOCAL_ONLY_KEYS, "is_synced", "origin_device", "remote_checked_at"]);
  const meta = Object.fromEntries(Object.entries(doc.metadata).filter(([k]) => !skip.has(k)).sort(([a], [b]) => a.localeCompare(b)));
  return createHash2("sha256").update(doc.content).update("\n").update(JSON.stringify(meta)).digest("hex").slice(0, 32);
}
async function writeIfUnchanged(collection, doc, metadata) {
  return withDocLock(collection, doc.id, async () => {
    const [cur] = await getDocumentsByIds2(collection, [doc.id]);
    if (!cur || syncFingerprint(cur) !== syncFingerprint(doc)) return false;
    await updateDocument2(collection, doc.id, metadata(cur.metadata));
    return true;
  });
}
function isRejectedUnchanged(doc) {
  return !!doc.metadata.sync_rejected && doc.metadata.sync_rejected_fp === syncFingerprint(doc);
}
function isPushable(doc) {
  return doc.metadata.is_synced === false && !doc.id.startsWith("__") && doc.metadata.type !== "journal_draft" && !isReadOnlyDoc(doc.metadata) && !isDeletedUpstream(doc.metadata) && !isRejectedUnchanged(doc);
}
function stripLocalOnly(metadata) {
  const out = { ...metadata };
  for (const k of LOCAL_ONLY_KEYS) delete out[k];
  return out;
}
function pushToRemote() {
  return serialized(pushAll);
}
function serialized(fn) {
  const run2 = pushChain.then(fn, fn);
  pushChain = run2.catch(() => void 0);
  return run2;
}
function pushDocsNow(collection, ids) {
  return serialized(async () => {
    const out = { pushed: [], renamed: {}, errors: 0 };
    if (!ids.length || !isSyncableCollection(collection)) return out;
    const backend = await getSyncBackend();
    if (!backend) return out;
    await resolveSyncUsername();
    const docs = (await getDocumentsByIds2(collection, ids)).filter(isPushable);
    const stats = emptyPushStats();
    const batch = [];
    for (const unsynced of docs) {
      const doc = { ...unsynced, metadata: { ...unsynced.metadata, origin_device: getDeviceId() } };
      batch.push({ doc, upsert: await toUpsert(collection, doc) });
    }
    try {
      await pushBatch(backend, collection, batch, stats, true);
    } catch (e) {
      noteSyncError(e);
      out.errors++;
      return out;
    }
    out.errors += stats.errors;
    for (const id of ids) {
      const [now] = await getDocumentsByIds2(collection, [id]).catch(() => []);
      if (now) {
        if (now.metadata.is_synced !== false) out.pushed.push(id);
        continue;
      }
      const [moved] = await getDocumentsByFilter2(collection, { rekeyed_from: id }, 1).catch(() => []);
      if (moved) {
        out.renamed[id] = moved.id;
        if (moved.metadata.is_synced !== false) out.pushed.push(moved.id);
      }
    }
    return out;
  });
}
async function pushAll() {
  const stats = emptyPushStats();
  const backend = await getSyncBackend();
  if (!backend) return stats;
  await resolveSyncUsername();
  try {
    const purges = await getPendingPurges();
    if (purges.length > 0) {
      let done = purges;
      if (backend.purge) {
        try {
          const results = await backend.purge(purges);
          const retry = new Set(results.filter((r) => r.status === "error" && !r.permanent).map((r) => r.id));
          done = purges.filter((id) => !retry.has(id));
          if (retry.size) {
            stats.errors += retry.size;
            process.stderr.write(`[yapa-sync] Purge of ${[...retry].join(", ")} failed for now; kept queued for the next push
`);
          }
          for (const r of results) {
            if (r.status === "error" && r.permanent) process.stderr.write(`[yapa-sync] Purge of ${r.id} refused: ${r.code}: ${r.message}
`);
            if (r.status === "purged_copies") process.stderr.write(`[yapa-sync] Purged your deleted copies of ${r.id}; the id now belongs to another user's document, which stays
`);
          }
          stats.purged = results.filter((r) => r.status === "purged" || r.status === "purged_copies").length;
        } catch (e) {
          if (!(e instanceof UnsupportedByRemoteError)) throw e;
          process.stderr.write(`[yapa-sync] The sync service can't purge yet: deleting ${purges.length} doc(s) instead
`);
          stats.deleted += await backend.delete(purges, "delete");
        }
      } else {
        stats.deleted += await backend.delete(purges, "delete");
      }
      await clearPendingPurges(done);
    }
  } catch (e) {
    process.stderr.write(`[yapa-sync] Purge error: ${e}
`);
    noteSyncError(e);
    stats.errors++;
    if (isCycleFatal(e)) return stats;
  }
  try {
    const pendingDeletes = await getPendingDeletes();
    if (pendingDeletes.length > 0) {
      const docIds = pendingDeletes.map((entry) => entry.split(":")[1]).filter(Boolean);
      stats.deleted += await backend.delete(docIds, "delete");
      await clearPendingDeletes(pendingDeletes);
    }
  } catch (e) {
    process.stderr.write(`[yapa-sync] Delete propagation error: ${e}
`);
    noteSyncError(e);
    stats.errors++;
    if (isCycleFatal(e)) return stats;
  }
  const collections = await listCollections2();
  for (const collection of collections) {
    if (isSyncableCollection(collection.name)) continue;
    try {
      stats.retracted += await retractSharedCopies(backend, collection.name);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Private-copy check failed for ${collection.name}: ${e}
`);
      noteSyncError(e);
      stats.errors++;
      if (isCycleFatal(e)) return stats;
    }
  }
  const pushedCollections = [];
  for (const collection of collections) {
    if (!isSyncableCollection(collection.name)) continue;
    try {
      const unsyncedDocs = await getDocumentsByFilter2(collection.name, { is_synced: false }, 500);
      const before = stats.pushed + stats.linked;
      const batch = [];
      for (const unsynced of unsyncedDocs) {
        if (!isPushable(unsynced)) continue;
        const doc = { ...unsynced, metadata: { ...unsynced.metadata, origin_device: getDeviceId() } };
        try {
          batch.push({ doc, upsert: await toUpsert(collection.name, doc) });
        } catch (e) {
          process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${e}
`);
          stats.errors++;
        }
      }
      await pushBatch(backend, collection.name, batch, stats, true);
      if (stats.pushed + stats.linked > before) pushedCollections.push(collection.name);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push error for collection ${collection.name}: ${e}
`);
      noteSyncError(e);
      stats.errors++;
      if (isCycleFatal(e)) break;
    }
  }
  if (pushedCollections.length > 0) {
    try {
      const existing = await getSyncSubscriptions();
      const existingSet = new Set(existing);
      const unfollowed = await getUnfollowedCollections();
      const newSubs = pushedCollections.filter((c) => !existingSet.has(c) && !unfollowed.has(c));
      if (newSubs.length > 0) {
        await updateSyncSubscriptions([...existing, ...newSubs]);
      }
    } catch (e) {
      process.stderr.write(`[yapa-sync] Auto-subscribe error: ${e}
`);
    }
  }
  return stats;
}
async function toUpsert(collection, doc) {
  const now = Math.floor(Date.now() / 1e3);
  const embedding = await generateEmbedding(doc.content) ?? [];
  return {
    id: doc.id,
    collection,
    content: doc.content,
    embedding,
    metadata: stripLocalOnly(doc.metadata),
    origin_user: getConfig().USERNAME,
    created_at: doc.metadata.created_at ?? now,
    updated_at: doc.metadata.updated_at ?? doc.metadata.created_at ?? now
  };
}
async function pushBatch(backend, collection, batch, stats, allowRekey) {
  if (batch.length === 0) return;
  let outcomes;
  try {
    outcomes = await backend.upsertMany(batch.map((b) => b.upsert));
  } catch (e) {
    stats.errors += batch.length - 1;
    throw e;
  }
  const retry = [];
  for (let i = 0; i < batch.length; i++) {
    const { doc, upsert } = batch[i];
    const outcome = outcomes[i];
    try {
      if (outcome.ok) {
        await applyPushed(backend, collection, doc, outcome.similar, stats);
      } else if (outcome.code === "id_taken" && allowRekey && doc.metadata.type === "task") {
        const renamed = await rekeyTask(collection, doc, outcome.suggestedId);
        stats.renamed++;
        retry.push({ doc: renamed, upsert: { ...upsert, id: renamed.id, metadata: stripLocalOnly(renamed.metadata) } });
      } else if (outcome.permanent) {
        await markRejected(collection, doc, outcome.code, outcome.message);
        stats.rejected++;
      } else {
        process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${outcome.code}: ${outcome.message}
`);
        noteSyncError(`${doc.id}: ${outcome.code}: ${outcome.message}`);
        stats.errors++;
      }
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push error for ${doc.id}: ${e}
`);
      stats.errors++;
    }
  }
  await pushBatch(backend, collection, retry, stats, false);
}
async function applyPushed(backend, collection, doc, similar, stats) {
  const match = similar.find((s) => s.id !== doc.id);
  if (!match) {
    if (await writeIfUnchanged(collection, doc, (cur) => ({ ...stripLocalOnly(cur), is_synced: true }))) stats.pushed++;
    return;
  }
  try {
    await backend.addRelatedIds(match.id, [doc.id]);
    await backend.addRelatedIds(doc.id, [match.id]);
  } catch (e) {
    process.stderr.write(`[yapa-sync] Link error for ${doc.id} -> ${match.id}: ${e}
`);
  }
  await writeIfUnchanged(collection, doc, (cur) => {
    const related = Array.isArray(cur.related_ids) ? [...cur.related_ids] : [];
    if (!related.includes(match.id)) related.push(match.id);
    return { ...stripLocalOnly(cur), related_ids: related, is_synced: true };
  });
  stats.linked++;
}
async function markRejected(collection, doc, code, message2) {
  await writeIfUnchanged(collection, doc, (cur) => ({
    ...cur,
    is_synced: false,
    sync_rejected: code,
    sync_rejected_message: message2.slice(0, 300),
    sync_rejected_fp: syncFingerprint(doc)
  }));
  process.stderr.write(`[yapa-sync] Not syncing ${doc.id} (${collection}): ${code}: ${message2}. It stays local and is retried after it changes.
`);
}
async function countUnpushed() {
  let n = 0;
  for (const col of await listCollections2()) {
    if (!isSyncableCollection(col.name)) continue;
    const docs = await getDocumentsByFilter2(col.name, { is_synced: false }, 1e5).catch(() => []);
    for (const d of docs) if (isPushable(d)) n++;
  }
  return n;
}
async function listRejectedDocs() {
  const out = [];
  for (const col of await listCollections2()) {
    if (!isSyncableCollection(col.name)) continue;
    const docs = await getDocumentsByFilter2(col.name, { is_synced: false }, 1e5).catch(() => []);
    for (const d of docs) {
      if (isRejectedUnchanged(d)) {
        out.push({ collection: col.name, id: d.id, code: String(d.metadata.sync_rejected) });
      }
    }
  }
  return out;
}
async function rekeyTask(collection, doc, suggestedId) {
  const { getNextTaskId: getNextTaskId2 } = await Promise.resolve().then(() => (init_create(), create_exports));
  const me = getConfig().USERNAME;
  const localNext = Number((await getNextTaskId2()).split("-").pop());
  const suggested = Number(suggestedId?.split("-").pop());
  const n = Math.max(localNext, Number.isFinite(suggested) ? suggested : 0);
  const newId = `${me}-${n}`;
  const metadata = await withDocLock(collection, doc.id, async () => {
    const [cur] = await getDocumentsByIds2(collection, [doc.id]);
    const src = cur ?? doc;
    const m = { ...src.metadata, id: newId, rekeyed_from: doc.id };
    await addDocument2(collection, newId, src.content, m);
    await deleteDocument2(collection, doc.id);
    return m;
  });
  process.stderr.write(`[yapa-sync] Task id ${doc.id} already belongs to a different task on the shared remote; renamed this task to ${newId}
`);
  return { ...doc, id: newId, metadata };
}
async function retractSharedCopies(backend, collection) {
  const versionOf = (d) => Number(d.metadata.updated_at ?? d.metadata.created_at ?? 0);
  const unchecked = (await getDocumentsByFilter2(collection, {}, 1e5)).filter((d) => !d.id.startsWith("__") && d.metadata.type !== "journal_draft" && !isReadOnlyDoc(d.metadata) && d.metadata.remote_checked_at !== versionOf(d));
  if (unchecked.length === 0) return 0;
  const me = getConfig().USERNAME;
  const remote = await backend.ownersByIds(unchecked.map((d) => d.id));
  const mine = unchecked.filter((d) => {
    const row = remote.get(d.id);
    const localCreated = Number(d.metadata.created_at);
    return row?.owner === me && (!d.metadata.origin_user || d.metadata.origin_user === me) && Number.isFinite(localCreated) && localCreated > 0 && Math.abs(row.createdAt - localCreated) <= 1;
  });
  const removed = mine.length > 0 ? await backend.delete(mine.map((d) => d.id), "retract") : 0;
  if (removed > 0) process.stderr.write(`[yapa-sync] Removed ${removed} shared cop${removed === 1 ? "y" : "ies"} of docs now in ${collection}
`);
  for (const d of unchecked) await writeIfUnchanged(collection, d, (cur) => ({ ...cur, remote_checked_at: versionOf(d) }));
  return removed;
}
var LOCAL_ONLY_KEYS, pushChain;
var init_push = __esm({
  "packages/core/src/sync/push.ts"() {
    "use strict";
    init_config();
    init_doc_lock();
    init_store();
    init_embeddings();
    init_backend();
    init_deletes();
    init_sentinel();
    init_device();
    init_syncable();
    LOCAL_ONLY_KEYS = ["sync_rejected", "sync_rejected_fp", "sync_rejected_message", "claim_unshared"];
    pushChain = Promise.resolve();
  }
});

// packages/core/src/tasks/claim.ts
var claim_exports = {};
__export(claim_exports, {
  ClaimBusyError: () => ClaimBusyError,
  TaskClaimedError: () => TaskClaimedError,
  claimKey: () => claimKey,
  claimNote: () => claimNote,
  claimSession: () => claimSession,
  claimTask: () => claimTask,
  claimsApply: () => claimsApply,
  claimsFor: () => claimsFor,
  describeClaim: () => describeClaim,
  describeHolder: () => describeHolder,
  describeRefusal: () => describeRefusal,
  releaseTaskClaim: () => releaseTaskClaim,
  retryUnsharedClaims: () => retryUnsharedClaims
});
function claimSession(explicit) {
  return currentSession(explicit) ?? `${getDeviceId()}:${process.pid}`.replace(SESSION_SAFE, "-").slice(0, 128);
}
function claimsApply(_collection) {
  return true;
}
function utc(t, now = Math.floor(Date.now() / 1e3)) {
  const iso = new Date(t * 1e3).toISOString();
  const day = iso.slice(0, 10);
  const hm = iso.slice(11, 16);
  return day === new Date(now * 1e3).toISOString().slice(0, 10) ? `${hm} UTC` : `${day} ${hm} UTC`;
}
function describeHolder(l, me = getConfig().USERNAME, mySession, now = Math.floor(Date.now() / 1e3)) {
  const who2 = l.holder.user === me ? mySession && l.holder.session === mySession ? "you (this session)" : `you (another session, ${l.holder.session})` : `${l.holder.user} (session ${l.holder.session.slice(0, 8)})`;
  return `${who2} since ${utc(l.acquired_at, now)}`;
}
function describeRefusal(r) {
  const holders = r.conflicts.map((c) => {
    const why = c.lease.key === r.id ? "" : ` (overlapping ${c.overlap.join(", ")} via ${c.lease.key})`;
    return `${describeHolder(c.lease, void 0, r.session)}${why}`;
  });
  const ownOther = r.conflicts.every((c) => c.lease.holder.user === getConfig().USERNAME);
  return `${r.id} is being worked on by ${holders.join("; ")}; not changed.` + (ownOther ? " If that other session is yours and finished or gone, retry with reclaim: true after the user confirms." : "");
}
async function claimTask(id, collection, metadata, opts = {}) {
  if (!claimsApply(collection)) return { kind: "local", id };
  const session = claimSession(opts.session);
  const localHolder = metadata.status === "in_progress" && typeof metadata.claim_unshared === "string" ? metadata.claim_unshared : "";
  if (localHolder && localHolder !== session && !opts.reclaim) {
    const at = Number(metadata.updated_at ?? Math.floor(Date.now() / 1e3));
    const lease = {
      collection,
      key: id,
      holder: { user: getConfig().USERNAME, session: localHolder, device: getDeviceId() },
      title: null,
      scope: [`key:${id}`],
      ttl_seconds: 0,
      acquired_at: at,
      heartbeat_at: at,
      expires_at: at,
      expired: false,
      took_over_from: null
    };
    return { kind: "refused", id, collection, session, conflicts: [{ lease, overlap: [`key:${id}`] }] };
  }
  let key = id;
  if (metadata.is_synced === false && !coordinatedLocally(collection)) {
    try {
      const r = await pushDocsNow(collection, [id]);
      key = r.renamed[id] ?? id;
    } catch {
    }
  }
  try {
    const c = await requireCoordination();
    const r = await c.leaseAcquire({
      collection,
      key,
      session,
      ...opts.scope ? { scope: opts.scope } : {},
      ...opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {},
      ...opts.title ? { title: opts.title } : {},
      ...opts.reclaim ? { reclaim: true } : {}
    });
    if (!r.granted) return { kind: "refused", id: key, collection, session, conflicts: r.conflicts };
    noteLeaseHeld(session, r.lease.ttl_seconds, void 0, { collection, key });
    return { kind: "granted", id: key, collection, session, lease: r.lease, renewed: r.renewed, ...r.took_over_from ? { tookOverFrom: r.took_over_from } : {} };
  } catch (e) {
    if (isCoordinationUnavailable(e)) return unavailable(e, key, collection, session);
    throw e;
  }
}
function unavailable(e, key, collection, session) {
  if (coordinatedLocally(collection)) throw new ClaimBusyError(key, collection, e.message);
  return { kind: "unshared", id: key, collection, session, reason: e.message };
}
async function claimKey(collection, key, opts = {}) {
  if (!claimsApply(collection)) return { kind: "local", id: key };
  const session = claimSession(opts.session);
  try {
    const c = await requireCoordination();
    const r = await c.leaseAcquire({
      collection,
      key,
      session,
      ...opts.scope ? { scope: opts.scope } : {},
      ...opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {},
      ...opts.title ? { title: opts.title } : {},
      ...opts.reclaim ? { reclaim: true } : {}
    });
    if (!r.granted) return { kind: "refused", id: key, collection, session, conflicts: r.conflicts };
    noteLeaseHeld(session, r.lease.ttl_seconds, void 0, { collection, key });
    return { kind: "granted", id: key, collection, session, lease: r.lease, renewed: r.renewed, ...r.took_over_from ? { tookOverFrom: r.took_over_from } : {} };
  } catch (e) {
    if (isCoordinationUnavailable(e)) return unavailable(e, key, collection, session);
    throw e;
  }
}
async function releaseTaskClaim(id, collection, outcome, session) {
  if (!claimsApply(collection)) return { kind: "local" };
  const s = claimSession(session);
  try {
    const r = await (await requireCoordination()).leaseRelease(collection, id, s, outcome);
    noteLeaseReleased(s, collection, id);
    if (r.released) return { kind: "released" };
    if (r.reason === "held_by_other") return { kind: "held_by_other", lease: r.lease };
    return { kind: "not_held" };
  } catch (e) {
    if (isCoordinationUnavailable(e)) return { kind: "unshared", reason: e.message };
    throw e;
  }
}
function describeClaim(r) {
  switch (r.kind) {
    case "local":
      return "";
    case "granted": {
      if (r.tookOverFrom) {
        const prev = r.tookOverFrom;
        const whose = prev.user === getConfig().USERNAME ? `your other session ${String(prev.session ?? "")}` : `${prev.user}'s expired claim`;
        return `Claimed ${r.id} (took over from ${whose}).`;
      }
      return r.renewed ? `Claim on ${r.id} renewed.` : coordinatedLocally(r.collection) ? `Claimed ${r.id} (this machine: your other sessions see it as yours).` : `Claimed ${r.id}: teammates see it as yours.`;
    }
    case "refused":
      return describeRefusal(r);
    case "unshared":
      return `Claim on ${r.id} is NOT shared (${r.reason}): others may start it too. It will be retried when sync is back; tell the user.`;
  }
}
async function retryUnsharedClaims() {
  const out = { granted: 0, refused: 0 };
  if (!isSyncConfigured()) return out;
  for (const col of await listCollections2().catch(() => [])) {
    if (!isSyncableCollection(col.name)) continue;
    const pending = (await getDocumentsByFilter2(col.name, { status: "in_progress" }, 1e3).catch(() => [])).filter((d) => typeof d.metadata.claim_unshared === "string" && d.metadata.claim_unshared);
    for (const d of pending) {
      let r;
      try {
        r = await claimTask(d.id, col.name, d.metadata, { session: d.metadata.claim_unshared });
      } catch {
        continue;
      }
      if (r.kind === "unshared" || r.kind === "local") return out;
      await patchDocument(col.name, r.id, { claim_unshared: "" }).catch(() => void 0);
      if (r.kind === "granted") {
        out.granted++;
      } else {
        out.refused++;
        addClaimNotice(`While you were offline, ${r.conflicts.map((c) => describeHolder(c.lease, void 0, r.session)).join("; ")} claimed ${r.id} (${col.name}). Your claim was not shared: coordinate before continuing that work.`);
      }
    }
  }
  return out;
}
async function claimsFor(collection, budgetMs = 1500) {
  if (!claimsApply(collection)) return void 0;
  try {
    const work = (async () => (await requireCoordination()).leaseList(collection))();
    const r = await Promise.race([work, new Promise((res) => setTimeout(() => res(void 0), budgetMs).unref())]);
    if (!r) return void 0;
    return new Map(r.leases.filter((l) => !l.expired).map((l) => [l.key, l]));
  } catch {
    return void 0;
  }
}
function claimNote(task, claims, mySessions = [currentSession()]) {
  if (!claims) return task.metadata.claim_unshared ? "claim not shared yet" : "";
  const l = claims.get(task.id);
  if (l) {
    const mine = mySessions.find((s) => s && s === l.holder.session);
    return `claimed by ${describeHolder(l, void 0, mine)}`;
  }
  if (task.metadata.status === "in_progress") return task.metadata.claim_unshared ? "claim not shared yet" : "no live claim";
  return "";
}
var TaskClaimedError, SESSION_SAFE, ClaimBusyError;
var init_claim = __esm({
  "packages/core/src/tasks/claim.ts"() {
    "use strict";
    init_config();
    init_store();
    init_device();
    init_backend();
    init_coordination();
    init_push();
    init_syncable();
    TaskClaimedError = class extends Error {
      constructor(result) {
        super(describeRefusal(result));
        this.result = result;
        this.name = "TaskClaimedError";
      }
      result;
      code = "task_claimed";
    };
    SESSION_SAFE = /[^A-Za-z0-9._:-]/g;
    ClaimBusyError = class extends Error {
      constructor(id, collection, cause) {
        super(`${id} was not claimed: ${cause}. Nothing changed; try again in a moment.`);
        this.id = id;
        this.collection = collection;
        this.name = "ClaimBusyError";
      }
      id;
      collection;
      code = "claim_busy";
    };
  }
});

// packages/core/src/tasks/update.ts
async function getTask(id) {
  const collections = await listCollections2();
  for (const collection of collections) {
    try {
      const results = await getDocumentsByIds2(collection.name, [id]);
      if (results.length > 0) {
        return {
          id: results[0].id,
          title: results[0].content,
          metadata: results[0].metadata,
          collection: collection.name
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}
async function updateTask(id, updates, ctx = {}) {
  let task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  assertWritable(id, task.metadata);
  const prevStatus = task.metadata.status;
  const result = { id };
  if (updates.status === "in_progress") {
    const claim = await claimTask(task.id, task.collection, task.metadata, ctx);
    if (claim.kind === "refused") throw new TaskClaimedError(claim);
    result.claim = claim;
    if (claim.id !== task.id) {
      task = await getTask(claim.id);
      if (!task) throw new Error(`Task ${claim.id} not found after re-key`);
      result.id = task.id;
    }
  }
  const structuralKeys = ["status", "priority", "title", "notes", "tags", "due_date", "customer", "project", "depends_on", "blocks", "is_recurring", "recurrence_pattern", "completed_at", "duration_minutes", "claim_scope", "blockedReason", "waits_on", "memory_ids"];
  const hasStructuralChange = getConfig().SYNC_ENABLED && Object.keys(updates).some((k) => structuralKeys.includes(k));
  const t = task;
  const prev = await withDocLock(t.collection, t.id, async () => {
    const cur = (await getDocumentsByIds2(t.collection, [t.id]))[0];
    if (!cur) throw new Error(`Task ${t.id} not found`);
    const updatedMetadata = {
      ...cur.metadata,
      ...updates,
      updated_at: Math.floor(Date.now() / 1e3)
    };
    if (updates.completed_at != null && cur.metadata.completed_at != null) updatedMetadata.completed_at = cur.metadata.completed_at;
    if (hasStructuralChange) updatedMetadata.is_synced = false;
    if (updates.status !== void 0 && updates.status !== "blocked" && updates.blockedReason === void 0 && cur.metadata.blockedReason) {
      updatedMetadata.blockedReason = "";
    }
    if (result.claim?.kind === "unshared") updatedMetadata.claim_unshared = result.claim.session;
    else if (updates.status !== void 0 && updatedMetadata.claim_unshared) updatedMetadata.claim_unshared = "";
    if (updates.title !== void 0 && updates.title !== cur.content) {
      await addDocument2(t.collection, t.id, updates.title, updatedMetadata);
    } else {
      await patchDocument(t.collection, t.id, metadataDelta(cur.metadata, updatedMetadata));
    }
    return cur.metadata.status;
  });
  result.previousStatus = prev;
  if (result.claim?.kind === "granted") {
    await pushDocsNow(task.collection, [task.id]).catch(() => void 0);
  }
  const outcome = updates.status !== void 0 ? RELEASE_OUTCOME[updates.status] : void 0;
  if (outcome && prevStatus === "in_progress") {
    result.release = await releaseTaskClaim(task.id, task.collection, outcome, ctx.session).catch(() => void 0);
  }
  return result;
}
async function completeTask(id, durationMinutes, ctx = {}, record = {}) {
  const task = await getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  validateLearned(record.learned);
  const completionUpdates = {
    status: "complete",
    salience: (task.metadata.salience ?? 2) * 0.5
  };
  if (task.metadata.completed_at == null) {
    completionUpdates.completed_at = Math.floor(Date.now() / 1e3);
  }
  if (durationMinutes != null) {
    completionUpdates.duration_minutes = durationMinutes;
  }
  const { release, previousStatus } = await updateTask(id, completionUpdates, ctx);
  const recorded = record.learned?.length || record.follow_ups?.length ? await recordForTask({ id: task.id, collection: task.collection }, record) : void 0;
  const nudge = captureNudge(task.id, task.metadata, recorded);
  const extras = { ...release ? { release } : {}, ...recorded ? { recorded } : {}, ...nudge ? { nudge } : {} };
  if (task.metadata.is_recurring && task.metadata.recurrence_pattern && previousStatus !== "complete") {
    const nextDue = computeNextDue(
      task.metadata.due_date ?? Math.floor(Date.now() / 1e3),
      task.metadata.recurrence_pattern
    );
    const newId = await createTask(task.title, {
      priority: task.metadata.priority,
      tags: Array.isArray(task.metadata.tags) ? task.metadata.tags : (task.metadata.tags ?? "").split(",").filter(Boolean),
      notes: task.metadata.notes,
      customer: task.metadata.customer,
      project: task.metadata.project,
      due_date: nextDue,
      is_recurring: true,
      recurrence_pattern: task.metadata.recurrence_pattern
    }, task.collection);
    return { regeneratedId: newId, ...extras };
  }
  return extras;
}
function computeNextDue(currentDue, pattern) {
  const d = new Date(currentDue * 1e3);
  switch (pattern) {
    case "daily":
      d.setDate(d.getDate() + 1);
      break;
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
  }
  return Math.floor(d.getTime() / 1e3);
}
var RELEASE_OUTCOME;
var init_update = __esm({
  "packages/core/src/tasks/update.ts"() {
    "use strict";
    init_config();
    init_close();
    init_store();
    init_doc_lock();
    init_syncable();
    init_create();
    init_claim();
    init_push();
    RELEASE_OUTCOME = { complete: "done", blocked: "blocked", pending: "pending" };
  }
});

// packages/core/src/tasks/waiting.ts
function taskNeedsPeople(tags) {
  const named = tags.filter((t) => t.startsWith("needs:")).map((t) => t.slice("needs:".length)).filter(Boolean);
  if (named.length) return named;
  return tags.includes("needs-human") ? [] : void 0;
}
async function waitingOn(opts = {}) {
  const names = opts.collection ? [opts.collection] : (await listCollections2().catch(() => [])).map((c) => c.name);
  const out = { decisions: [], questions: [], actions: [], blocked: [] };
  await Promise.all(names.map(async (collection) => {
    const [decisions, questions, tasks] = await Promise.all([
      getDocumentsByFilter2(collection, { type: "memory", kind: "decision" }, 2e3).catch(() => []),
      getDocumentsByFilter2(collection, { type: "memory", kind: "question" }, 2e3).catch(() => []),
      getDocumentsByFilter2(collection, { type: "task" }, 5e3).catch(() => [])
    ]);
    const open2 = tasks.filter((t) => t.metadata.status !== "complete" && t.metadata.archived !== true);
    const waitingOnIt = /* @__PURE__ */ new Map();
    for (const t of open2) for (const m of list5(t.metadata.waits_on)) waitingOnIt.set(m, [...waitingOnIt.get(m) ?? [], t.id]);
    const seen = /* @__PURE__ */ new Set();
    for (const d of [...decisions, ...questions]) {
      const m = d.metadata;
      if (m.archived === true || !isOpenTyped(m)) continue;
      const id = m.parent_id ?? d.id;
      if (seen.has(id) || m.parent_id && (m.chunk_index ?? 0) !== 0) continue;
      seen.add(id);
      const item = {
        id,
        collection,
        what: m.kind,
        title: firstLine(d.content),
        for: m.owner ? [String(m.owner)] : [],
        by: m.origin_user ?? m.username ?? "",
        since: Number(m.updated_at ?? m.created_at ?? 0),
        status: m.status ?? DEFAULT_STATUS[m.kind],
        ...list5(m.options).length ? { options: list5(m.options) } : {},
        ...m.recommendation ? { recommendation: String(m.recommendation) } : {},
        ...waitingOnIt.get(id)?.length ? { waiting_tasks: waitingOnIt.get(id) } : {}
      };
      (m.kind === "decision" ? out.decisions : out.questions).push(item);
    }
    for (const t of open2) {
      const m = t.metadata;
      const owner = m.origin_user ?? m.username ?? "";
      const people = taskNeedsPeople(list5(m.tags));
      if (people) {
        out.actions.push({
          id: t.id,
          collection,
          what: "action",
          title: t.content,
          for: people,
          by: owner,
          since: Number(m.updated_at ?? m.created_at ?? 0),
          status: m.status,
          ...m.notes ? { reason: String(m.notes).slice(0, 300) } : {}
        });
      } else if (m.status === "blocked") {
        out.blocked.push({
          id: t.id,
          collection,
          what: "blocked",
          title: t.content,
          for: owner ? [owner] : [],
          by: owner,
          since: Number(m.updated_at ?? m.created_at ?? 0),
          status: "blocked",
          ...m.blockedReason || m.blocked_reason ? { reason: String(m.blockedReason ?? m.blocked_reason) } : {}
        });
      }
    }
  }));
  const forUser = (i) => !opts.user || i.for.length === 0 || i.for.includes(opts.user);
  const oldest = (a, b) => a.since - b.since;
  return {
    decisions: out.decisions.filter(forUser).sort(oldest),
    questions: out.questions.filter(forUser).sort(oldest),
    actions: out.actions.filter(forUser).sort(oldest),
    // Blocked tasks belong to whoever owns them.
    blocked: out.blocked.filter((i) => !opts.user || i.for.includes(opts.user)).sort(oldest)
  };
}
function fenceWaiting(w, activeCollection) {
  if (!isSyncableCollection(activeCollection)) return { waiting: w, hidden: 0 };
  const open2 = (i) => i.collection === "global" || isSyncableCollection(i.collection);
  const waiting = {
    decisions: w.decisions.filter(open2),
    questions: w.questions.filter(open2),
    actions: w.actions.filter(open2),
    blocked: w.blocked.filter(open2)
  };
  return { waiting, hidden: waitingCount(w) - waitingCount(waiting) };
}
function age(since, now = Math.floor(Date.now() / 1e3)) {
  if (!since) return "";
  const d = Math.floor((now - since) / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor((now - since) / 3600);
  return h >= 1 ? `${h}h` : "new";
}
function waitingLine(i, opts = {}) {
  const where = opts.collection ? ` (${i.collection})` : "";
  const tag = i.what === "decision" ? `decision ${i.status}` : i.what === "question" ? "question" : i.what === "action" ? "needs a person" : "blocked";
  const head = `- **${i.id}**${where} [${tag}, for ${who(i)}, ${age(i.since)}] ${i.title}`;
  const extra = [];
  if (i.options?.length) extra.push(`options: ${i.options.join(" | ")}`);
  if (i.recommendation) extra.push(`recommended: ${i.recommendation}`);
  if (i.waiting_tasks?.length) extra.push(`waiting: ${i.waiting_tasks.join(", ")}`);
  if (i.reason && i.what === "blocked") extra.push(`reason: ${i.reason}`);
  return extra.length ? `${head}
  ${extra.join("; ")}` : head;
}
function formatWaiting(w, opts = {}) {
  const sections = [
    ["Decisions", w.decisions],
    ["Questions", w.questions],
    ["Steps only a person can take", w.actions],
    ["Blocked", w.blocked]
  ];
  const parts = sections.filter(([, items]) => items.length).map(([title, items]) => `## ${title} (${items.length})
${items.map((i) => waitingLine(i, opts)).join("\n")}`);
  return parts.length ? parts.join("\n\n") : "Nothing is waiting on anyone.";
}
var list5, firstLine, waitingCount, who;
var init_waiting = __esm({
  "packages/core/src/tasks/waiting.ts"() {
    "use strict";
    init_store();
    init_kinds();
    init_syncable();
    list5 = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map(String).map((s) => s.trim()).filter(Boolean);
    firstLine = (s) => {
      const line = s.split("\n").find((l) => l.trim()) ?? "";
      const t = line.replace(/^#+\s*/, "").trim();
      return t.length > 160 ? `${t.slice(0, 159)}\u2026` : t;
    };
    waitingCount = (w) => w.decisions.length + w.questions.length + w.actions.length + w.blocked.length;
    who = (i) => i.for.length ? i.for.join(", ") : "anyone";
  }
});

// packages/core/src/tasks/next.ts
async function expiredLeaseKeys(collection) {
  try {
    const r = await (await requireCoordination()).leaseList(collection, true);
    return new Set(r.leases.filter((l) => l.expired).map((l) => l.key));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function nextTasks(opts) {
  const docs = (await getDocumentsByFilter2(opts.collection, { type: "task" }, 5e3).catch(() => [])).filter((d) => d.metadata.archived !== true);
  const open2 = docs.filter((d) => d.metadata.status !== "complete");
  const byId = new Map(docs.map((d) => [d.id, d]));
  const claims = await claimsFor(opts.collection);
  const live = claims ? [...claims.values()] : [];
  const local2 = coordinatedLocally(opts.collection);
  const expired = local2 ? await expiredLeaseKeys(opts.collection) : void 0;
  const nowS = Math.floor(Date.now() / 1e3);
  const liveScope = /* @__PURE__ */ new Map();
  for (const l of live) {
    for (const s of l.scope) if (s !== `key:${l.key}`) liveScope.set(s, l.key);
    for (const s of norm(byId.get(l.key)?.metadata.claim_scope)) liveScope.set(s, l.key);
  }
  const openIds = new Set(open2.map((d) => d.id));
  const skipped = [];
  const ready = [];
  const depCache = /* @__PURE__ */ new Map();
  const depStatus = async (id) => {
    if (byId.has(id)) return byId.get(id).metadata.status;
    if (!depCache.has(id)) depCache.set(id, (await getTask(id).catch(() => null))?.metadata.status);
    return depCache.get(id);
  };
  for (const d of open2) {
    const tags = norm(d.metadata.tags);
    if (opts.tags?.length && !opts.tags.every((t) => tags.includes(t))) continue;
    if (opts.excludeTags?.some((t) => tags.includes(t))) {
      skipped.push({ id: d.id, reason: `tagged ${opts.excludeTags.filter((t) => tags.includes(t)).join(", ")}` });
      continue;
    }
    const people = taskNeedsPeople(tags);
    if (people) {
      skipped.push({ id: d.id, reason: `needs a person (${people.length ? people.join(", ") : "anyone"})` });
      continue;
    }
    if (opts.autoOnly && !tags.includes("auto")) {
      skipped.push({ id: d.id, reason: "not tagged auto" });
      continue;
    }
    const status = d.metadata.status ?? "pending";
    if (status === "blocked") {
      skipped.push({ id: d.id, reason: `blocked${d.metadata.blockedReason ? `: ${d.metadata.blockedReason}` : ""}` });
      continue;
    }
    const held2 = claims?.get(d.id);
    if (held2) {
      skipped.push({ id: d.id, reason: `claimed by ${describeHolder(held2)}` });
      continue;
    }
    if (status === "in_progress" && !claims) {
      skipped.push({ id: d.id, reason: "in_progress (claims unknown: offline)" });
      continue;
    }
    if (status === "in_progress" && d.metadata.claim_unshared) {
      skipped.push({ id: d.id, reason: "in_progress (claimed on this machine, not shared yet)" });
      continue;
    }
    if (status === "in_progress" && local2 && !expired?.has(d.id)) {
      const quiet = nowS - Number(d.metadata.updated_at ?? d.metadata.created_at ?? 0);
      if (quiet < LEASE_TTL_DEFAULT) {
        const left = Math.ceil((LEASE_TTL_DEFAULT - quiet) / 60);
        skipped.push({ id: d.id, reason: `in_progress with no claim on record (started without one); offered again after ${left} min untouched` });
        continue;
      }
    }
    const waiting = [];
    for (const dep of norm(d.metadata.depends_on)) {
      const s = await depStatus(dep);
      if (s !== void 0 && s !== "complete") waiting.push(dep);
    }
    if (waiting.length) {
      skipped.push({ id: d.id, reason: `waiting on ${waiting.join(", ")}` });
      continue;
    }
    const waits = norm(d.metadata.waits_on).length ? await openWaits(d.metadata, opts.collection) : [];
    if (waits.length) {
      skipped.push({ id: d.id, reason: describeWaits(waits) });
      continue;
    }
    const near = [...new Set(norm(d.metadata.claim_scope).filter((s) => liveScope.has(s)).map((s) => liveScope.get(s)))];
    ready.push({
      id: d.id,
      title: d.content,
      collection: opts.collection,
      priority: d.metadata.priority ?? "medium",
      status,
      ...d.metadata.due_date ? { due_date: Number(d.metadata.due_date) } : {},
      unblocks: norm(d.metadata.blocks).filter((b) => openIds.has(b)).length,
      near,
      lapsed: status === "in_progress"
    });
  }
  const created = (id) => Number(byId.get(id)?.metadata.created_at ?? 0);
  ready.sort((a, b) => (a.near.length ? 1 : 0) - (b.near.length ? 1 : 0) || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || (a.due_date ?? Infinity) - (b.due_date ?? Infinity) || b.unblocks - a.unblocks || created(a.id) - created(b.id));
  const result = { ready, skipped, claimsKnown: claims !== void 0, cleanup: [] };
  if (!ready.length || opts.includeCleanup) result.cleanup = await cleanupItems(opts.collection, open2, claims);
  if (!opts.claim) return result;
  const { collection: _c, tags: _t, excludeTags: _x, claim: _k, autoOnly: _a, includeCleanup: _i, ...claimOpts } = opts;
  for (const r of ready) {
    try {
      const u = await updateTask(r.id, { status: "in_progress" }, claimOpts);
      result.claimed = u.claim ?? { kind: "local", id: u.id };
      return result;
    } catch (e) {
      if (e instanceof TaskClaimedError) {
        result.claimed = e.result;
        skipped.push({ id: r.id, reason: `claim refused: ${e.message}` });
        continue;
      }
      throw e;
    }
  }
  for (const c of result.cleanup.filter((x) => !x.held_by)) {
    const r = await claimKey(opts.collection, c.key, claimOpts);
    result.claimed = r;
    if (r.kind !== "refused") return result;
    c.held_by = r.conflicts.map((x) => describeHolder(x.lease)).join("; ");
  }
  return result;
}
async function cleanupItems(collection, open2, claims) {
  const items = [];
  const triageTag = (tags) => tags.includes("auto") || tags.includes("needs-human") || tags.some((t) => t.startsWith("needs:"));
  if (open2.some((d) => triageTag(norm(d.metadata.tags)))) {
    const untriaged = open2.filter((d) => !triageTag(norm(d.metadata.tags))).length;
    if (untriaged) items.push({ key: "cleanup:triage", title: `Triage ${untriaged} open task(s): tag each auto or needs-human (and needs:<user> when one person must take it)`, count: untriaged });
  }
  const now = Math.floor(Date.now() / 1e3);
  const findings = (await getDocumentsByFilter2(collection, { type: "memory", kind: "finding" }, 2e3).catch(() => [])).filter((f) => f.metadata.archived !== true && (f.metadata.status ?? "open") === "open" && !f.metadata.disposition && Number(f.metadata.created_at ?? now) < now - 2 * DAY3 && (f.metadata.chunk_index ?? 0) === 0);
  if (findings.length) items.push({ key: "cleanup:findings", title: `Give ${findings.length} open finding(s) a disposition (decision, task, limitation or no-action)`, count: findings.length });
  const size = await collectionSize(collection).catch(() => 0);
  if (size >= getConfig().COMPACTION_THRESHOLD) items.push({ key: "cleanup:compaction", title: `Compact the collection (${size} memories): compaction_suggest, then compaction_apply`, count: size });
  for (const it of items) {
    const l = claims?.get(it.key);
    if (l) it.held_by = describeHolder(l);
  }
  return items;
}
var PRIORITY_RANK, norm, DAY3;
var init_next = __esm({
  "packages/core/src/tasks/next.ts"() {
    "use strict";
    init_store();
    init_config();
    init_compact();
    init_coordination();
    init_local_coordination();
    init_claim();
    init_update();
    init_close();
    init_waiting();
    PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
    norm = (x) => (Array.isArray(x) ? x : (x ?? "").toString().split(",")).map(String).map((s) => s.trim()).filter(Boolean);
    DAY3 = 86400;
  }
});

// packages/core/src/tasks/search.ts
async function searchTasks(query, filters = {}) {
  const collectionNames = filters.collection ? [filters.collection] : (await listCollections2()).map((c) => c.name);
  const results = [];
  for (const name of collectionNames) {
    try {
      const queryFilter = { type: "task" };
      if (filters.customer) queryFilter.customer = filters.customer;
      if (filters.project) queryFilter.project = filters.project;
      const docs = await queryDocuments2(name, query, 10, queryFilter);
      for (const doc of docs) {
        if (doc.metadata.type === "task") {
          results.push({
            id: doc.id,
            title: doc.content,
            metadata: doc.metadata,
            similarity: 1 - doc.distance,
            collection: name
          });
        }
      }
    } catch {
      continue;
    }
  }
  return results.sort((a, b) => b.similarity - a.similarity);
}
var init_search = __esm({
  "packages/core/src/tasks/search.ts"() {
    "use strict";
    init_store();
  }
});

// packages/core/src/tasks/delete.ts
async function deleteTask(id, session) {
  const task = await getTask(id).catch(() => null);
  const collection = await deleteDocumentEverywhere(id);
  if (task?.metadata.status === "in_progress") {
    await releaseTaskClaim(id, task.collection, "deleted", session).catch(() => void 0);
  }
  return collection;
}
var init_delete = __esm({
  "packages/core/src/tasks/delete.ts"() {
    "use strict";
    init_forget();
    init_claim();
    init_update();
  }
});

// packages/core/src/tasks/dependencies.ts
async function editEdges(id, field, edit) {
  const t = await getTask(id);
  if (!t) return;
  await withDocLock(t.collection, t.id, async () => {
    const now = await getTask(id);
    if (!now) return;
    const next = edit(toList(now.metadata[field]));
    if (next) await updateTask(id, { [field]: next });
  });
}
async function addDependency(taskId, dependsOnId) {
  const task = await getTask(taskId);
  const dep = await getTask(dependsOnId);
  if (!task || !dep) {
    throw new Error("One or both tasks not found");
  }
  assertWritable(taskId, task.metadata);
  await editEdges(taskId, "depends_on", (cur) => cur.includes(dependsOnId) ? void 0 : [...cur, dependsOnId]);
  if (isReadOnlyDoc(dep.metadata)) return;
  await editEdges(dependsOnId, "blocks", (cur) => cur.includes(taskId) ? void 0 : [...cur, taskId]);
}
async function removeDependency(taskId, dependsOnId) {
  const task = await getTask(taskId);
  const dep = await getTask(dependsOnId);
  if (!task && !dep) {
    throw new Error("Neither task found");
  }
  if (task) {
    await editEdges(taskId, "depends_on", (cur) => cur.includes(dependsOnId) ? cur.filter((id) => id !== dependsOnId) : void 0);
  }
  if (dep && !isReadOnlyDoc(dep.metadata)) {
    await editEdges(dependsOnId, "blocks", (cur) => cur.includes(taskId) ? cur.filter((id) => id !== taskId) : void 0);
  }
}
var toList;
var init_dependencies = __esm({
  "packages/core/src/tasks/dependencies.ts"() {
    "use strict";
    init_update();
    init_doc_lock();
    init_syncable();
    toList = (x) => Array.isArray(x) ? x : String(x ?? "").split(",").filter(Boolean);
  }
});

// packages/core/src/tasks/dates.ts
function parseRelativeDate(phrase) {
  const now = /* @__PURE__ */ new Date();
  const lower = phrase.toLowerCase().trim();
  if (lower === "today") {
    return endOfDay(now);
  }
  if (lower === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return endOfDay(d);
  }
  const dayMatch = lower.match(/next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
  if (dayMatch) {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const targetDay = days.indexOf(dayMatch[1]);
    const currentDay = now.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    const d = new Date(now);
    d.setDate(d.getDate() + daysUntil);
    return endOfDay(d);
  }
  const inDaysMatch = lower.match(/in\s+(\d+)\s+day/);
  if (inDaysMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1]));
    return endOfDay(d);
  }
  const inWeeksMatch = lower.match(/in\s+(\d+)\s+week/);
  if (inWeeksMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inWeeksMatch[1]) * 7);
    return endOfDay(d);
  }
  if (lower === "end of week") {
    const d = new Date(now);
    const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    d.setHours(17, 0, 0, 0);
    return Math.floor(d.getTime() / 1e3);
  }
  const dateMatch = phrase.match(/([A-Za-z]+)\s+(\d{1,2})(?:,\s+(\d{4}))?/);
  if (dateMatch) {
    const monthNames = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december"
    ];
    const month = monthNames.indexOf(dateMatch[1].toLowerCase());
    const day = parseInt(dateMatch[2]);
    const year = dateMatch[3] ? parseInt(dateMatch[3]) : now.getFullYear();
    if (month !== -1) {
      const d = new Date(year, month, day, 23, 59, 59, 999);
      return Math.floor(d.getTime() / 1e3);
    }
  }
  return null;
}
function formatTaskDate(timestamp) {
  const date = new Date(timestamp * 1e3);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...date.getHours() !== 23 || date.getMinutes() !== 59 ? { hour: "numeric" } : {}
  });
}
function endOfDay(d) {
  d.setHours(23, 59, 59, 999);
  return Math.floor(d.getTime() / 1e3);
}
function parseDuration(input2) {
  const s = input2.toLowerCase().trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (isNaN(value)) return null;
  const unit = m[2] ?? "m";
  let minutes;
  if (unit.startsWith("h")) minutes = value * 60;
  else if (unit.startsWith("d")) minutes = value * 60 * 8;
  else minutes = value;
  return Math.round(minutes);
}
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
var init_dates = __esm({
  "packages/core/src/tasks/dates.ts"() {
    "use strict";
  }
});

// packages/core/src/collections/manage.ts
async function listCollectionsWithCounts() {
  const collections = await listCollections2();
  const results = await Promise.all(
    collections.map(async (c) => {
      try {
        const count = await getCollectionCount2(c.name);
        return { name: c.name, id: c.id, documentCount: count };
      } catch {
        return { name: c.name, id: c.id, documentCount: 0 };
      }
    })
  );
  return results.sort((a, b) => a.name.localeCompare(b.name));
}
async function createNewCollection(name) {
  await createCollection2(name);
  await clearCollectionRedirect(name);
  if (isSyncable2(name)) await rejoinCollection(name);
  else await clearLeftCollection(name);
}
async function removeCollection(name, opts = {}) {
  const scope = opts.scope ?? "local";
  const shared = isSyncable2(name);
  const syncOn = getConfig().SYNC_ENABLED;
  const docs = (await getDocumentsByFilter2(name, {}, 1e5).catch(() => [])).filter((d) => !d.id.startsWith("__"));
  const result = { name, scope, removed: docs.length, pushed: 0, deletedRemotely: 0, shared };
  const confirmed = !!opts.force || opts.confirm === name;
  const refuse = (why) => {
    throw new CollectionDeleteRefusedError(
      `Refused: ${why} This is not a merge: to combine it with another collection, use collection_merge (it keeps every document). To delete it anyway, confirm with the user, then pass confirm: "${name}".`,
      docs.length
    );
  };
  const n = `${docs.length} document${docs.length === 1 ? "" : "s"}`;
  if (docs.length > 0 && !confirmed) {
    if (!shared) refuse(`"${name}" is local only, with ${n} and no copy anywhere else: deleting it is permanent.`);
    if (!syncOn) refuse(`"${name}" has ${n} and sync is off, so this machine holds the only copy: deleting it is permanent.`);
    if (scope === "everyone") {
      refuse(`deleting "${name}" for everyone removes your documents in it from the sync service and from every teammate's machine (${n} here).`);
    }
  }
  const me = getConfig().USERNAME;
  const mine = (d) => !d.metadata.origin_user || d.metadata.origin_user === me;
  if (shared && syncOn && scope === "local") {
    const stuck = docs.filter((d) => d.metadata.is_synced === false && isRejectedUnchanged(d));
    if (stuck.length && !confirmed) {
      refuse(`${stuck.length} document${stuck.length === 1 ? "" : "s"} in "${name}" (${stuck.slice(0, 3).map((d) => d.id).join(", ")}${stuck.length > 3 ? ", ..." : ""}) ${stuck.length === 1 ? "was refused by the sync service and exists" : "were refused by the sync service and exist"} only on this machine: deleting it here loses ${stuck.length === 1 ? "it" : "them"}.`);
    }
    const unpushed = docs.filter(isPushable).map((d) => d.id);
    if (unpushed.length) {
      const r = await pushDocsNow(name, unpushed).catch(() => ({ pushed: [], errors: unpushed.length }));
      result.pushed = r.pushed.length;
      const missing = unpushed.length - r.pushed.length;
      if (missing > 0 && !confirmed) {
        refuse(`${missing} of your documents in "${name}" could not be pushed to the sync service, so deleting it here would lose them.`);
      }
    }
  }
  if (shared && syncOn && scope === "everyone") {
    const real = docs.filter((d) => d.metadata.type !== "journal_draft");
    const own = real.filter(mine).map((d) => d.id);
    await queueSyncDeletes(own, name);
    await addLocalTombstones(real.filter((d) => !mine(d)).map((d) => d.id));
    result.deletedRemotely = own.length;
  }
  if (shared) {
    const subs = await getSyncSubscriptions();
    if (subs.includes(name)) await updateSyncSubscriptions(subs.filter((s) => s !== name));
    if (scope === "local" && (opts.markLeft ?? true)) await addLeftCollection(name);
  }
  await deleteCollection2(name);
  return result;
}
function removeReport(r) {
  const docs = `${r.removed} document${r.removed === 1 ? "" : "s"}`;
  if (!r.shared) return `Deleted "${r.name}" (${docs}) from this machine. It was local only, so it is gone.`;
  if (r.scope === "everyone") {
    return `Deleted "${r.name}" (${docs}) here and, for everyone, your ${r.deletedRemotely} document${r.deletedRemotely === 1 ? "" : "s"} in it on the sync service. Teammates' own documents in it stay shared.`;
  }
  return `Removed "${r.name}" (${docs}) from this machine only${r.pushed ? ` after pushing ${r.pushed} unpushed document${r.pushed === 1 ? "" : "s"} of yours` : ""}. Teammates and the sync service keep it; this machine no longer follows it (sync subscribe ${r.name} to follow it again).`;
}
async function mergeCollections(from, into, opts = {}) {
  if (from === into) throw new Error("Source and target are the same collection");
  if (from === "global") {
    throw new Error(`Refused: "global" cannot be merged into another collection. It holds this machine's sync state (subscriptions, pull point, merge redirects). Move specific memories with memory_store instead.`);
  }
  const names = new Set((await listCollections2()).map((c) => c.name));
  if (!names.has(from)) throw new Error(`Collection "${from}" not found`);
  if (!names.has(into)) {
    throw new Error(`Target collection "${into}" does not exist. Confirm the name with the user and create it first (collection_create), then merge.`);
  }
  if (!isSyncable2(from) && isSyncable2(into)) {
    throw new Error(
      `Refused: "${from}" is private (never synced) and "${into}" is shared. Merging would publish every document in "${from}" to all teammates on the sync service. Merge into another private collection, or store the specific documents that should be shared.`
    );
  }
  const docs = await getDocumentsByFilter2(from, {}, 1e5);
  const total = await getCollectionCount2(from);
  if (docs.length < total) throw new Error(`Could only read ${docs.length} of ${total} documents in "${from}"; nothing was moved`);
  const ids = docs.map((d) => d.id);
  const clash = ids.length > 0 ? (await getDocumentsByIds2(into, ids).catch(() => [])).map((d) => d.id) : [];
  if (clash.length > 0) {
    throw new Error(`"${into}" already holds ${clash.length} id(s) from "${from}" (${clash.slice(0, 5).join(", ")}${clash.length > 5 ? ", ..." : ""}); nothing was moved`);
  }
  const byType = {};
  for (const d of docs) {
    const t = String(d.metadata.type ?? "unknown");
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const me = getConfig().USERNAME;
  const sharedToPrivate = isSyncable2(from) && !isSyncable2(into);
  const teammateRowsKept = sharedToPrivate ? docs.filter((d) => d.metadata.origin_user && d.metadata.origin_user !== me).length : 0;
  const ownRowsRetracted = sharedToPrivate ? docs.filter((d) => !d.id.startsWith("__") && d.metadata.type !== "journal_draft" && !isReadOnlyDoc(d.metadata) && (!d.metadata.origin_user || d.metadata.origin_user === me) && Number(d.metadata.created_at) > 0).length : 0;
  const result = {
    from,
    into,
    moved: docs.length,
    byType,
    dryRun: !!opts.dryRun,
    sourceRemoved: false,
    teammateRowsKept,
    ownRowsRetracted
  };
  if (ownRowsRetracted > 0 && isSyncConfigured()) {
    const rules = await remoteDataRules({ cachedOnly: true });
    if (!rules) result.remoteRulesUnknown = true;
    else if (rules.erasure === "none") result.remoteKeepsContent = true;
  }
  if (opts.dryRun) return result;
  if (docs.length > 0) {
    const before = await getCollectionCount2(into);
    for (let i = 0; i < docs.length; i += MERGE_BATCH) {
      await addDocumentsBatch2(into, docs.slice(i, i + MERGE_BATCH).map((d) => {
        const metadata = { ...d.metadata, is_synced: false };
        delete metadata.remote_checked_at;
        return { id: d.id, content: d.content, metadata };
      }));
    }
    const landed = await getDocumentsByIds2(into, ids);
    const after = await getCollectionCount2(into);
    if (landed.length !== ids.length || after !== before + ids.length) {
      throw new Error(`Merge verification failed: "${into}" holds ${landed.length} of ${ids.length} moved docs (count ${before} -> ${after}); "${from}" was left intact`);
    }
    const copied = new Map(docs.map((d) => [d.id, JSON.stringify([d.content, d.metadata])]));
    for (const id of ids) {
      await withDocLock(from, id, async () => {
        const [cur] = await getDocumentsByIds2(from, [id]);
        if (cur && JSON.stringify([cur.content, cur.metadata]) !== copied.get(id)) {
          const metadata = { ...cur.metadata, is_synced: false };
          delete metadata.remote_checked_at;
          await addDocument2(into, id, cur.content, metadata);
        }
        await deleteDocument2(from, id);
      });
    }
    const left = await getCollectionCount2(from);
    if (left !== 0) throw new Error(`"${from}" still holds ${left} document(s) after the move; it was not deleted`);
  }
  await removeCollection(from, { force: true, markLeft: false });
  result.sourceRemoved = true;
  await addCollectionRedirect(from, into);
  return result;
}
function erasureLines(r) {
  if (r.remoteKeepsContent) return ["This sync service cannot erase: it keeps their content, hidden from everyone. Ask its administrators to remove it for good."];
  if (r.remoteRulesUnknown) return ["This sync service's data rules aren't known yet (see `sync status`): if it cannot erase, it keeps their content."];
  return [];
}
function mergeReportLines(r) {
  const types = Object.entries(r.byType).sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${n} ${t}`).join(", ") || "none";
  const sharedToPrivate = isSyncable2(r.from) && !isSyncable2(r.into);
  const docs = (n) => `${n} doc${n === 1 ? "" : "s"}`;
  if (r.dryRun) {
    const lines2 = [`Dry run: would move ${r.moved} document(s) from "${r.from}" into "${r.into}" (${types}), then remove "${r.from}". Nothing changed.`];
    if (sharedToPrivate && r.ownRowsRetracted > 0) {
      lines2.push(`Up to ${docs(r.ownRowsRetracted)} of yours would be removed from the shared copy (retracted) at the next push (those that reached the sync service).`);
      lines2.push(...erasureLines(r));
    }
    if (sharedToPrivate && r.teammateRowsKept > 0) {
      lines2.push(`${docs(r.teammateRowsKept)} by teammates would stay shared in "${r.from}" (you would keep a private copy).`);
    }
    return lines2;
  }
  const lines = [`Moved ${r.moved} document(s) from "${r.from}" into "${r.into}" (${types}) and removed the empty "${r.from}".`];
  if (sharedToPrivate) {
    if (r.ownRowsRetracted > 0) {
      lines.push(`Up to ${docs(r.ownRowsRetracted)} of yours will be removed from the shared copy (retracted) at the next push (those that reached the sync service).`);
      lines.push(...erasureLines(r));
    }
    if (r.teammateRowsKept > 0) {
      lines.push(`${r.teammateRowsKept} teammates' docs stay shared in "${r.from}" (you now have a private copy; only their owners can remove the shared rows).`);
    }
  }
  if (isSyncable2(r.from)) {
    lines.push(`"${r.from}" won't come back here (sync subscribe ${r.from} to follow it again).`);
    lines.push(
      `This redirect is for this machine only. Another device of yours still follows "${r.from}": run the same merge there` + (sharedToPrivate ? ` too. Until then it drops its unedited copies of your retracted docs when the retraction reaches it, and a copy it edited can be pushed back into "${r.from}".` : " too.")
    );
  }
  return lines;
}
var isSyncable2, CollectionDeleteRefusedError, MERGE_BATCH;
var init_manage = __esm({
  "packages/core/src/collections/manage.ts"() {
    "use strict";
    init_config();
    init_deletes();
    init_sentinel();
    init_doc_lock();
    init_push();
    init_store();
    init_syncable();
    init_backend();
    isSyncable2 = isSyncableCollection;
    CollectionDeleteRefusedError = class extends Error {
      constructor(message2, documentCount) {
        super(message2);
        this.documentCount = documentCount;
        this.name = "CollectionDeleteRefusedError";
      }
      documentCount;
      code = "collection_delete_refused";
    };
    MERGE_BATCH = 100;
  }
});

// packages/core/src/curation/provider.ts
import { spawn } from "node:child_process";
function setHostLLMCaller(caller) {
  hostCaller = caller;
}
async function callCurationLLM(options) {
  if (hostCaller) return hostCaller(options);
  const model = getCurationModel();
  switch (getConfig().CURATION_LLM_PROVIDER) {
    case "fireworks":
      return fetchOpenAICompatible2(
        "https://api.fireworks.ai/inference/v1/chat/completions",
        getConfig().FIREWORKS_API_KEY,
        model,
        options
      );
    case "openai":
      return fetchOpenAICompatible2(
        "https://api.openai.com/v1/chat/completions",
        getConfig().OPENAI_API_KEY,
        model,
        options
      );
    case "anthropic":
      return fetchAnthropic(getConfig().ANTHROPIC_API_KEY, model, options);
    case "ollama":
      return fetchOllama2(getConfig().OLLAMA_URL, model, options);
    case "claude-cli":
      return callClaudeCli(model, options);
    default:
      throw new Error(`Unknown curation LLM provider: ${getConfig().CURATION_LLM_PROVIDER}`);
  }
}
async function fetchOpenAICompatible2(url, apiKey, model, options) {
  if (!apiKey) throw new Error(`Missing API key for ${getConfig().CURATION_LLM_PROVIDER}`);
  const body = {
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0,
    max_tokens: options.max_tokens ?? 4096
  };
  if (options.json_mode) body.response_format = { type: "json_object" };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Unexpected LLM response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return content;
}
async function fetchAnthropic(apiKey, model, options) {
  if (!apiKey) throw new Error("Missing getConfig().ANTHROPIC_API_KEY for curation");
  const systemMsgs = options.messages.filter((m) => m.role === "system").map((m) => m.content);
  const chatMsgs = options.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: options.max_tokens ?? 4096,
      temperature: options.temperature ?? 0,
      system: systemMsgs.join("\n\n") || void 0,
      messages: chatMsgs
    })
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const block = data.content?.[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error(`Unexpected Anthropic response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return block.text;
}
async function fetchOllama2(ollamaUrl, model, options) {
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: options.messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0,
        num_predict: options.max_tokens ?? 4096
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  if (typeof data.message?.content !== "string") {
    throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.message.content;
}
function buildClaudeCliArgs(model, system) {
  const args = ["-p", "--safe-mode", "--model", model, "--tools", "", "--no-session-persistence", "--output-format", "text"];
  if (system) args.push("--system-prompt", system);
  return args;
}
async function callClaudeCli(model, options) {
  const system = options.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const prompt = options.messages.filter((m) => m.role !== "system").map((m) => m.role === "assistant" ? `Assistant: ${m.content}` : m.content).join("\n\n");
  return new Promise((resolve3, reject) => {
    const child = spawn("claude", buildClaudeCliArgs(model, system), {
      env: { ...process.env, [HOOK_CHILD_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    const timer3 = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${CLAUDE_CLI_TIMEOUT_MS}ms`));
    }, CLAUDE_CLI_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer3);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer3);
      if (code === 0) resolve3(out.trim());
      else reject(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}
var hostCaller, HOOK_CHILD_ENV, CLAUDE_CLI_TIMEOUT_MS;
var init_provider = __esm({
  "packages/core/src/curation/provider.ts"() {
    "use strict";
    init_config();
    HOOK_CHILD_ENV = "YAPA_HOOK_CHILD";
    CLAUDE_CLI_TIMEOUT_MS = 12e4;
  }
});

// packages/core/src/curation/prompts.ts
function buildClassifierUserPrompt(memories) {
  const lines = [`Classify these ${memories.length} memories:`, ""];
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    lines.push(`[MEMORY ${i + 1}]`);
    lines.push(`ID: ${m.id}`);
    lines.push("CONTENT:");
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n");
}
var CLASSIFIER_PROMPT_VERSION, CLASSIFIER_SYSTEM_PROMPT;
var init_prompts = __esm({
  "packages/core/src/curation/prompts.ts"() {
    "use strict";
    CLASSIFIER_PROMPT_VERSION = "v1";
    CLASSIFIER_SYSTEM_PROMPT = `You are a memory classifier. Given one or more memory entries, score each on three independent dimensions (each 0.0 to 1.0) that determine how the memory should be routed downstream.

DIMENSIONS

trainable (0.0-1.0): Would this memory make good training data for fine-tuning a language model to behave more like the user? Score HIGH for reasoning patterns, writing style, preferences, judgment calls, or reusable technical approaches. Score LOW for one-off facts, current state that will change, specific numbers or counts, or simple configuration data that belongs in a retrieval system instead.

durability (0.0-1.0): How likely is this memory to remain true/relevant over months or years? Score HIGH for timeless conventions, user preferences, patterns, architectural principles, or "how things work" knowledge. Score LOW for current state ("X is on version Y"), in-progress work, project statuses, calendar dates, or counts/numbers that will change.

generalizability (0.0-1.0): Does this memory describe a pattern or principle that applies beyond its specific context, or is it a one-off detail? Score HIGH for principles, rules, and patterns that transfer across situations. Score LOW for specific instances, named entities, or one-off details.

SCORING TIPS

- These three dimensions are INDEPENDENT. A memory can be high on one and low on another.
- Do not score based on how interesting or important the memory seems. Score based on the dimensions above.
- If a memory is extremely specific to a named entity (a company, a project, a person), generalizability should be LOW even if the underlying principle is broad.
- "How to do X" patterns generally score HIGH on all three. "X happened on date Y" generally scores LOW on all three.

OUTPUT FORMAT

Return valid JSON only. No commentary. No markdown fences. The output must be a JSON array with exactly one object per input memory, in the same order the inputs were given:

[
  {
    "id": "<the exact id from the input>",
    "trainable": <number between 0.0 and 1.0>,
    "durability": <number between 0.0 and 1.0>,
    "generalizability": <number between 0.0 and 1.0>,
    "rationale": "<one short sentence explaining the scores>"
  }
]

Do not include any fields other than these five. Do not wrap the JSON in \`\`\`. Do not prepend explanations.`;
  }
});

// packages/core/src/curation/classifier.ts
async function classifyMemories(memories, options = {}) {
  if (memories.length === 0) return [];
  const caller = options.call ?? callCurationLLM;
  const userPrompt = buildClassifierUserPrompt(memories);
  const raw = await caller({
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 2048,
    json_mode: true
  });
  return parseClassifierResponse(raw, memories);
}
function parseClassifierResponse(raw, memories) {
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Classifier response was not a JSON array: ${raw.slice(0, 200)}`);
  }
  const byId = new Map(memories.map((m) => [m.id, m]));
  const seen = /* @__PURE__ */ new Set();
  const results = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "");
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      trainable: clamp01(entry.trainable),
      durability: clamp01(entry.durability),
      generalizability: clamp01(entry.generalizability),
      rationale: typeof entry.rationale === "string" ? entry.rationale : ""
    });
  }
  return results;
}
function clamp01(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function extractJsonArray(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
    }
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }
  throw new Error(`Could not extract JSON array from classifier response: ${raw.slice(0, 200)}`);
}
var init_classifier = __esm({
  "packages/core/src/curation/classifier.ts"() {
    "use strict";
    init_provider();
    init_prompts();
  }
});

// packages/core/src/curation/index.ts
function getCurationState() {
  return { lastRunAt, lastError: lastError2, cycleCount, timerActive, totalScored };
}
async function collectUnclassified(collection) {
  const docs = await getDocumentsByFilter2(collection, { type: "memory" }, MAX_PER_COLLECTION);
  return docs.filter((d) => d.metadata.classified_at == null);
}
async function curationCycle() {
  if (running) {
    process.stderr.write("[yapa-curation] Skipping cycle \u2014 previous still running\n");
    return null;
  }
  running = true;
  try {
    const stats = { scored: 0, pending: 0, batches: 0, errors: 0 };
    const collections = await listCollections2();
    for (const c of collections) {
      let unclassified;
      try {
        unclassified = await collectUnclassified(c.name);
      } catch (e) {
        process.stderr.write(`[yapa-curation] Collection error ${c.name}: ${e}
`);
        stats.errors++;
        continue;
      }
      stats.pending += unclassified.length;
      for (let i = 0; i < unclassified.length; i += getConfig().CURATION_BATCH_SIZE) {
        const batch = unclassified.slice(i, i + getConfig().CURATION_BATCH_SIZE);
        try {
          const scored = await classifyMemories(
            batch.map((b) => ({ id: b.id, content: b.content }))
          );
          const now = Math.floor(Date.now() / 1e3);
          for (const result of scored) {
            const doc = batch.find((b) => b.id === result.id);
            if (!doc) continue;
            const updated = {
              ...doc.metadata,
              trainable: result.trainable,
              durability: result.durability,
              generalizability: result.generalizability,
              classified_at: now,
              classifier_prompt_version: CLASSIFIER_PROMPT_VERSION
            };
            if (result.rationale) updated.classification_rationale = result.rationale;
            try {
              await patchDocument(c.name, doc.id, metadataDelta(doc.metadata, updated));
              stats.scored++;
            } catch (e) {
              process.stderr.write(`[yapa-curation] Update error for ${doc.id}: ${e}
`);
              stats.errors++;
            }
          }
          stats.batches++;
        } catch (e) {
          process.stderr.write(`[yapa-curation] Batch error in ${c.name}: ${e}
`);
          stats.errors++;
        }
      }
    }
    lastRunAt = Date.now();
    lastError2 = null;
    cycleCount++;
    totalScored += stats.scored;
    if (stats.scored > 0 || stats.errors > 0) {
      process.stderr.write(
        `[yapa-curation] Classified ${stats.scored}/${stats.pending} memories in ${stats.batches} batch(es), ${stats.errors} error(s)
`
      );
    }
    return stats;
  } catch (e) {
    const msg = `${e}`;
    process.stderr.write(`[yapa-curation] Cycle error: ${msg}
`);
    lastRunAt = Date.now();
    lastError2 = msg;
    cycleCount++;
    return null;
  } finally {
    running = false;
  }
}
async function startCuration() {
  if (!getConfig().CURATION_ENABLED) return;
  curationCycle().catch(
    (e) => process.stderr.write(`[yapa-curation] Initial cycle error: ${e}
`)
  );
  timer = setInterval(() => {
    curationCycle().catch((e) => process.stderr.write(`[yapa-curation] Cycle error: ${e}
`));
  }, getConfig().CURATION_INTERVAL_MS);
  timerActive = true;
  process.stderr.write(
    `[yapa-curation] Background curation started (interval: ${getConfig().CURATION_INTERVAL_MS / 1e3}s)
`
  );
}
function stopCuration() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    timerActive = false;
  }
}
var timer, running, lastRunAt, lastError2, cycleCount, timerActive, totalScored, MAX_PER_COLLECTION;
var init_curation = __esm({
  "packages/core/src/curation/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_classifier();
    timer = null;
    running = false;
    lastRunAt = null;
    lastError2 = null;
    cycleCount = 0;
    timerActive = false;
    totalScored = 0;
    MAX_PER_COLLECTION = 500;
  }
});

// packages/core/src/curation/extractor.ts
function buildExtractorUserPrompt(input2) {
  const lines = [
    `Scope/collection: ${input2.collection}`,
    "",
    "[USER MESSAGE]",
    input2.userText.trim() || "(none \u2014 injected or continuation turn)",
    "",
    "[ASSISTANT RESPONSE]",
    input2.assistantText.trim()
  ];
  return lines.join("\n");
}
async function extractMemories(input2, options = {}) {
  if (!input2.assistantText.trim()) return [];
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
      { role: "user", content: buildExtractorUserPrompt(input2) }
    ],
    temperature: 0,
    max_tokens: 1536,
    json_mode: true
  });
  const parsed = parseExtractorResponse(raw);
  const max = options.maxMemories ?? 3;
  return parsed.slice(0, Math.max(0, max));
}
function parseExtractorResponse(raw) {
  const parsed = extractJsonArray2(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Extractor response was not a JSON array: ${raw.slice(0, 200)}`);
  }
  const results = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const content = entry.content;
    if (typeof content !== "string" || !content.trim()) continue;
    const tagsRaw = entry.tags;
    const tags = Array.isArray(tagsRaw) ? tagsRaw.filter((t) => typeof t === "string" && !!t.trim()).map((t) => t.trim().toLowerCase()).slice(0, 4) : [];
    const kind = EXTRACTED_KINDS.includes(entry.kind) ? entry.kind : void 0;
    const owner = kind === "question" && typeof entry.owner === "string" && entry.owner.trim() ? entry.owner.trim() : void 0;
    results.push({
      content: content.trim(),
      tags,
      sector: entry.sector === "episodic" ? "episodic" : "semantic",
      salience: clampSalience(entry.salience),
      rationale: typeof entry.rationale === "string" ? entry.rationale : "",
      ...kind ? { kind } : {},
      ...owner ? { owner } : {}
    });
  }
  return results;
}
function clampSalience(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, n));
}
function extractJsonArray2(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
    }
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }
  throw new Error(`Could not extract JSON array from extractor response: ${raw.slice(0, 200)}`);
}
var EXTRACTOR_PROMPT_VERSION, EXTRACTOR_SYSTEM_PROMPT, EXTRACTED_KINDS;
var init_extractor = __esm({
  "packages/core/src/curation/extractor.ts"() {
    "use strict";
    init_provider();
    EXTRACTOR_PROMPT_VERSION = "v2";
    EXTRACTOR_SYSTEM_PROMPT = `You are a memory extractor for a long-term memory system. Given ONE conversation turn \u2014 the user's message and the assistant's response \u2014 decide whether anything said is worth storing in long-term memory, and extract it.

STORE a candidate when the turn contains:
- A bug's root cause or a non-obvious diagnosis
- A configuration value, env var, endpoint, file path, or credential location worth remembering
- A user preference, decision, or correction ("never do X", "we decided Y", "actually, it's Z")
- A non-obvious technical fact about the codebase, a system, or a customer's environment
- A solution that took real effort to find and is likely to recur
- A commitment, follow-up, or action item

DO NOT STORE:
- Ephemeral conversation state (plans for this turn, progress narration, acknowledgments)
- Obvious code patterns or anything readable from the code/git history itself
- Restatements of the user's message with no new information
- Generic advice, boilerplate, or filler
- Anything already true by definition of the task at hand

RULES
- Return 0 to 3 candidates. Zero is a common and correct answer \u2014 most turns contain nothing durable.
- Each candidate must be SELF-CONTAINED: understandable months later without the conversation. Include the specific names, values, and paths that make it useful.
- Write candidates as statements of fact, not narration ("The FD codec requires X", not "I found that the FD codec requires X").
- Prefer ONE merged candidate over several overlapping ones.
- Assign salience 1.0-3.0: 1.0 minor/contextual, 2.0 clearly useful, 3.0 critical hard-won knowledge. The caller may clamp this.
- sector is "semantic" for durable facts/patterns, "episodic" for events, decisions, and things tied to a moment in time.
- tags: 1-4 short lowercase tags for categorization.
- kind (optional; omit for an ordinary fact or preference):
  - "finding": a result, a root cause, a retraction of something believed before, or a methodology trap
  - "decision": a choice that WAS MADE in this turn (by the user, or agreed with them)
  - "limitation": something the system cannot do yet, and what would change that
  - "question": an open question that someone outside this conversation (a person or another team) has to answer
  - "idea": a proposed capability or change nobody has committed to
  Never mark a choice that is still open as a decision: an open choice is not stored by you.
- owner (only for a question): the person or team who has to answer, if named.

OUTPUT FORMAT
Return valid JSON only. No commentary. No markdown fences. A JSON array of candidates:
[
  {
    "content": "<the self-contained memory text>",
    "tags": ["<tag>"],
    "sector": "semantic" | "episodic",
    "salience": <number 1.0-3.0>,
    "kind": "finding" | "decision" | "limitation" | "question" | "idea" (optional),
    "owner": "<name>" (optional, questions only),
    "rationale": "<one short sentence: why this is durable>"
  }
]
If nothing qualifies, return exactly: []`;
    EXTRACTED_KINDS = ["finding", "decision", "limitation", "question", "idea"];
  }
});

// packages/core/src/curation/resolver.ts
function buildResolverUserPrompt(candidate, neighbors) {
  const lines = ["[CANDIDATE]", candidate, ""];
  lines.push(`[EXISTING MEMORIES \u2014 ${neighbors.length} similar]`);
  for (const n of neighbors) {
    lines.push("", `ID: ${n.id}`, `salience: ${n.salience ?? "?"}`, "CONTENT:", n.content);
  }
  return lines.join("\n");
}
async function resolveConflict(candidate, neighbors, options = {}) {
  if (neighbors.length === 0) return { action: "add", rationale: "no neighbors" };
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: "system", content: RESOLVER_SYSTEM_PROMPT },
      { role: "user", content: buildResolverUserPrompt(candidate, neighbors) }
    ],
    temperature: 0,
    max_tokens: 1024,
    json_mode: true
  });
  return parseResolverResponse(raw, neighbors);
}
function parseResolverResponse(raw, neighbors) {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Resolver response was not a JSON object: ${raw.slice(0, 200)}`);
  }
  const entry = parsed;
  const rationale = typeof entry.rationale === "string" ? entry.rationale : "";
  const neighborIds = new Set(neighbors.map((n) => n.id));
  if (entry.action === "supersede") {
    const targetId = typeof entry.target_id === "string" ? entry.target_id : "";
    if (!neighborIds.has(targetId)) {
      return { action: "skip", rationale: `invalid supersede target "${targetId}" \u2014 kept both` };
    }
    const mergedContent = typeof entry.merged_content === "string" && entry.merged_content.trim() ? entry.merged_content.trim() : void 0;
    return { action: "supersede", targetId, mergedContent, rationale };
  }
  if (entry.action === "skip") return { action: "skip", rationale };
  return { action: "add", rationale };
}
function extractJsonObject(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }
  throw new Error(`Could not extract JSON object from resolver response: ${raw.slice(0, 200)}`);
}
var RESOLVER_PROMPT_VERSION, RESOLVER_SYSTEM_PROMPT;
var init_resolver = __esm({
  "packages/core/src/curation/resolver.ts"() {
    "use strict";
    init_provider();
    RESOLVER_PROMPT_VERSION = "v1";
    RESOLVER_SYSTEM_PROMPT = `You are a memory-conflict resolver for a long-term memory system. You are given a CANDIDATE memory and one or more EXISTING memories that are semantically similar to it. Decide what should happen to the candidate.

ACTIONS (choose exactly one per candidate):

- "skip" \u2014 the candidate restates a fact the existing memory already covers. Nothing new is stored.
- "add" \u2014 the candidate is RELATED but DISTINCT: a different fact that merely looks similar. Store it alongside the existing memory.
- "supersede" \u2014 the candidate UPDATES or CORRECTS an existing memory (a value changed, a decision was reversed, a diagnosis was revised, newer information makes the old one stale). The existing memory is archived and the candidate (or your merged rewrite) is stored in its place.

RULES
- BE CONSERVATIVE. Supersede ONLY when the candidate clearly updates, corrects, or contradicts the existing memory. When in doubt, choose "add" (distinct facts) or "skip" (same fact) \u2014 never supersede on a hunch.
- A change in a specific value (version, port, path, owner, status, date) between existing and candidate is the classic supersede signal.
- If multiple existing memories are shown, supersede targets exactly ONE of them (the stale one). If none is stale, do not supersede.
- On supersede you may provide "merged_content": a single self-contained statement combining the old context with the new fact (e.g. noting the previous value). Keep it factual and standalone. If the candidate already says everything needed, omit merged_content and the candidate text is used as-is.
- Never merge two memories that are both still true.

OUTPUT FORMAT
Return valid JSON only. No commentary. No markdown fences:
{
  "action": "skip" | "add" | "supersede",
  "target_id": "<id of the existing memory to supersede \u2014 required for supersede, omit otherwise>",
  "merged_content": "<optional rewritten content for supersede>",
  "rationale": "<one short sentence>"
}`;
  }
});

// packages/core/src/curation/janitor.ts
async function findDuplicatePairs(collection, distanceThreshold) {
  const all = (await getDocumentsByFilter2(collection, { type: "memory" }, 1e4)).filter((d) => d.metadata.archived !== true && !isMemoryKind(d.metadata.kind));
  const seen = /* @__PURE__ */ new Set();
  const pairs = [];
  for (const doc of all) {
    const neighbors = await queryDocuments2(collection, doc.content, 4, { type: "memory" }).catch(() => []);
    for (const n of neighbors) {
      if (n.id === doc.id || n.distance >= distanceThreshold) continue;
      if (n.metadata?.archived === true || isMemoryKind(n.metadata?.kind)) continue;
      const key = [doc.id, n.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        collection,
        a: { id: doc.id, content: doc.content, metadata: doc.metadata },
        b: { id: n.id, content: n.content, distance: n.distance, salience: n.metadata?.salience },
        distance: n.distance
      });
    }
  }
  return pairs.sort((x, y) => x.distance - y.distance);
}
async function archiveDuplicate(collection, loserId, winnerId) {
  const existing = await getDocumentsByIds2(collection, [loserId]);
  if (!existing.length) return;
  await patchDocument(collection, loserId, metadataDelta(existing[0].metadata, archivedMetadata(existing[0].metadata, { duplicate_of: winnerId })));
}
async function janitorSweep(options = {}) {
  const stats = {
    collectionsScanned: 0,
    pairsConsidered: 0,
    skippedDuplicates: 0,
    superseded: 0,
    keptDistinct: 0,
    errors: 0
  };
  const maxPairs = options.maxPairs ?? 20;
  const threshold = options.distanceThreshold ?? getConfig().CONTRADICTION_DISTANCE_THRESHOLD;
  const collections = options.collection ? [options.collection] : (await listCollections2().catch(() => [])).map((c) => c.name);
  for (const collection of collections) {
    if (stats.pairsConsidered >= maxPairs) break;
    let pairs;
    try {
      pairs = await findDuplicatePairs(collection, threshold);
      stats.collectionsScanned++;
    } catch (e) {
      process.stderr.write(`[yapa-janitor] scan failed for ${collection}: ${e}
`);
      stats.errors++;
      continue;
    }
    for (const pair of pairs) {
      if (stats.pairsConsidered >= maxPairs) break;
      stats.pairsConsidered++;
      try {
        const [candidate, neighbor] = (pair.a.metadata.salience ?? 1) >= (pair.b.salience ?? 1) ? [{ id: pair.b.id, content: pair.b.content }, { id: pair.a.id, content: pair.a.content, distance: pair.distance, salience: pair.a.metadata.salience }] : [{ id: pair.a.id, content: pair.a.content }, { id: pair.b.id, content: pair.b.content, distance: pair.distance, salience: pair.b.salience }];
        const decision = await resolveConflict(
          candidate.content,
          [neighbor],
          options.call ? { call: options.call } : {}
        );
        if (decision.action === "skip") {
          await archiveDuplicate(collection, candidate.id, neighbor.id);
          stats.skippedDuplicates++;
        } else if (decision.action === "supersede") {
          const target = decision.targetId === candidate.id ? candidate : neighbor;
          const other = decision.targetId === candidate.id ? neighbor : candidate;
          await storeMemory(decision.mergedContent ?? candidate.content, {
            collection,
            salience: Math.max(pair.a.metadata.salience ?? 1, pair.b.salience ?? 1),
            tags: ["janitor-merged"],
            sector: "semantic",
            supersedes: target.id,
            metadata: {
              source: "janitor",
              resolver_prompt_version: RESOLVER_PROMPT_VERSION,
              rationale: decision.rationale,
              related_to: other.id
            }
          });
          stats.superseded++;
        } else {
          stats.keptDistinct++;
        }
      } catch (e) {
        process.stderr.write(`[yapa-janitor] pair resolution failed in ${collection}: ${e}
`);
        stats.errors++;
      }
    }
  }
  if (stats.pairsConsidered > 0) {
    process.stderr.write(
      `[yapa-janitor] sweep: ${stats.pairsConsidered} pairs \u2014 ${stats.skippedDuplicates} duplicates archived, ${stats.superseded} superseded, ${stats.keptDistinct} kept distinct, ${stats.errors} error(s)
`
    );
  }
  return stats;
}
var init_janitor = __esm({
  "packages/core/src/curation/janitor.ts"() {
    "use strict";
    init_kinds();
    init_archive();
    init_config();
    init_store();
    init_store2();
    init_resolver();
  }
});

// packages/core/src/memory/update.ts
async function locate(id, collection) {
  const names = collection ? [(await resolveWriteCollection(collection)).collection] : (await listCollections2().catch(() => [])).map((c) => c.name);
  for (const name of names) {
    const [doc] = await getDocumentsByIds2(name, [id]).catch(() => []);
    if (doc) return { collection: name, doc };
    const chunks = await getDocumentsByFilter2(name, { parent_id: id }, 1).catch(() => []);
    if (chunks.length) return { collection: name, doc: chunks[0] };
  }
  return null;
}
async function updateMemory(id, patch, collection) {
  const found = await locate(id, collection);
  if (!found || found.doc.metadata.type !== "memory") throw new MemoryNotFoundError(id);
  assertWritable(id, found.doc.metadata);
  const { note, tags, content, ...typedPatch } = patch;
  if (content !== void 0 && found.doc.metadata.parent_id) {
    throw new Error(`${id} is stored in several chunks: store the new text as a new memory with supersedes: "${id}"`);
  }
  const typed = normalizeTyped(typedPatch, found.doc.metadata);
  const now = Math.floor(Date.now() / 1e3);
  const baseId = found.doc.metadata.parent_id ?? found.doc.id;
  const metadata = await withDocLock(found.collection, baseId, async () => {
    const docs = found.doc.metadata.parent_id ? (await getDocumentsByFilter2(found.collection, { parent_id: baseId }, 1e3)).sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0)) : await getDocumentsByIds2(found.collection, [found.doc.id]);
    if (!docs.length) throw new MemoryNotFoundError(id);
    let metadata2 = docs[docs.length - 1].metadata;
    for (const [i, d] of docs.entries()) {
      metadata2 = { ...d.metadata, ...typed, ...tags ? { tags } : {}, updated_at: now, is_synced: false };
      const last = i === docs.length - 1;
      if ((note?.trim() || content !== void 0) && last) {
        const day = new Date(now * 1e3).toISOString().slice(0, 10);
        const text = content ?? d.content;
        await addDocument2(found.collection, d.id, note?.trim() ? `${text}

${day} ${getConfig().USERNAME}: ${note.trim()}` : text, metadata2);
      } else {
        await patchDocument(found.collection, d.id, metadataDelta(d.metadata, metadata2));
      }
    }
    return metadata2;
  });
  if (typed.task_ids?.length) await linkMemoryToTasks(baseId, typed.task_ids);
  return { id: baseId, collection: found.collection, metadata };
}
var MemoryNotFoundError;
var init_update2 = __esm({
  "packages/core/src/memory/update.ts"() {
    "use strict";
    init_store();
    init_config();
    init_doc_lock();
    init_syncable();
    init_sentinel();
    init_kinds();
    init_links();
    MemoryNotFoundError = class extends Error {
      constructor(id) {
        super(`memory ${id} not found`);
        this.name = "MemoryNotFoundError";
      }
    };
  }
});

// packages/core/src/curation/follow-through.ts
function toItem(collection, d) {
  const m = d.metadata;
  return {
    id: m.parent_id ?? d.id,
    collection,
    kind: m.kind,
    status: m.status,
    content: d.content.slice(0, 600),
    ...m.owner ? { owner: String(m.owner) } : {},
    ...list6(m.options).length ? { options: list6(m.options) } : {},
    ...m.recommendation ? { recommendation: String(m.recommendation) } : {}
  };
}
async function findOpenItems(collection, text, taskIds = []) {
  const out = /* @__PURE__ */ new Map();
  const names = (await listCollections2().catch(() => [])).map((c) => c.name);
  for (const tid of taskIds) {
    const [t] = await getDocumentsByIds2(collection, [tid]).catch(() => []);
    for (const mid of [...list6(t?.metadata.waits_on), ...list6(t?.metadata.memory_ids)]) {
      for (const name of [collection, ...names.filter((n) => n !== collection)]) {
        const direct = await getDocumentsByIds2(name, [mid]).catch(() => []);
        const [doc] = direct.length ? direct : await getDocumentsByIds2(name, [`${mid}-0`]).catch(() => []);
        if (doc) {
          if (isOpenTyped(doc.metadata) && doc.metadata.archived !== true) out.set(mid, toItem(name, doc));
          break;
        }
      }
    }
  }
  if (text.trim()) {
    const near = await queryDocuments2(collection, text.slice(0, 4e3), 20, { type: "memory" }).catch(() => []);
    for (const n of near) {
      if (out.size >= MAX_ITEMS) break;
      if (n.distance >= FOLLOW_THROUGH_MAX_DISTANCE || n.metadata.archived === true || !isOpenTyped(n.metadata)) continue;
      const item = toItem(collection, n);
      if (!out.has(item.id)) out.set(item.id, item);
    }
  }
  return [...out.values()].slice(0, MAX_ITEMS);
}
function buildFollowThroughPrompt(items, turn) {
  const lines = ["[OPEN ITEMS]"];
  for (const i of items) {
    lines.push(`- id: ${i.id}`, `  kind: ${i.kind} (${i.status})${i.owner ? `, for ${i.owner}` : ""}`, `  text: ${i.content.replace(/\s+/g, " ")}`);
    if (i.options?.length) lines.push(`  options: ${i.options.join(" | ")}`);
    if (i.recommendation) lines.push(`  recommended: ${i.recommendation}`);
  }
  lines.push("", `[PERSON: ${turn.user}]`, turn.userText.trim() || "(none)", "", "[ASSISTANT]", turn.assistantText.trim() || "(none)");
  return lines.join("\n");
}
function parseFollowThrough(raw, items, user) {
  const s = raw.replace(/```(?:json)?/g, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  let parsed;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? s.slice(start, end + 1) : s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const item = byId.get(String(e.id));
    if (!item) continue;
    if (item.kind === "decision" && item.owner && item.owner !== user) continue;
    const change = {
      id: item.id,
      status: String(e.status ?? ""),
      note: String(e.note ?? "").trim(),
      ...item.kind === "finding" && e.disposition ? { disposition: String(e.disposition) } : {},
      ...item.kind === "finding" && Array.isArray(e.disposition_ids) ? { disposition_ids: e.disposition_ids.map(String) } : {},
      ...item.kind === "finding" && e.disposition_reason ? { disposition_reason: String(e.disposition_reason) } : {}
    };
    if (change.status === item.status) continue;
    try {
      const { note: _n, id: _i, ...typed } = change;
      normalizeTyped(typed, { kind: item.kind, status: item.status, ...item.options ? { options: item.options } : {} });
    } catch {
      continue;
    }
    if (isOpenTyped({ kind: item.kind, status: change.status })) continue;
    out.push(change);
  }
  return out;
}
async function followThrough(turn, deps = {}) {
  const d = { findOpenItems, call: callCurationLLM, updateMemory, ...deps };
  const user = turn.user ?? getConfig().USERNAME;
  const items = await d.findOpenItems(turn.collection, `${turn.userText}
${turn.assistantText}`, turn.taskIds ?? []);
  if (!items.length || !(turn.userText.trim() || turn.assistantText.trim())) return { judged: 0, changes: [] };
  const raw = await d.call({
    messages: [
      { role: "system", content: FOLLOW_THROUGH_SYSTEM_PROMPT },
      { role: "user", content: buildFollowThroughPrompt(items, { user, userText: turn.userText.slice(0, 6e3), assistantText: turn.assistantText.slice(0, 6e3) }) }
    ],
    temperature: 0,
    max_tokens: 800,
    json_mode: true
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const changes = [];
  for (const c of parseFollowThrough(raw, items, user)) {
    const item = byId.get(c.id);
    const { id, note, ...typed } = c;
    try {
      await d.updateMemory(id, { ...typed, ...note ? { note } : {} }, item.collection);
      changes.push({ ...c, kind: item.kind, collection: item.collection });
    } catch {
    }
  }
  return { judged: items.length, changes };
}
var FOLLOW_THROUGH_PROMPT_VERSION, FOLLOW_THROUGH_MAX_DISTANCE, MAX_ITEMS, FOLLOW_THROUGH_SYSTEM_PROMPT, list6;
var init_follow_through = __esm({
  "packages/core/src/curation/follow-through.ts"() {
    "use strict";
    init_store();
    init_config();
    init_kinds();
    init_update2();
    init_provider();
    FOLLOW_THROUGH_PROMPT_VERSION = "v1";
    FOLLOW_THROUGH_MAX_DISTANCE = 0.75;
    MAX_ITEMS = 8;
    FOLLOW_THROUGH_SYSTEM_PROMPT = `You keep a team's open items current. You get a list of OPEN items (decisions waiting on a choice, open questions, open findings, open limitations, proposed ideas) and ONE conversation turn between a person and their assistant. Report only the items this turn settles. Most turns settle nothing: [] is the common, correct answer.

Settle an item only on clear evidence in the turn:
- decision -> "accepted" when the PERSON states the choice or explicitly approves one option (or the recommendation); "rejected" when the person rules the decision out entirely. Never settle a decision on the assistant's word alone. note: the choice, in a short sentence.
- question -> "answered" when the turn contains the answer (the person gives it, or the assistant reports an answer it found or was given). note: the answer.
- finding -> "resolved" when the turn decides what becomes of it. Give "disposition": "no-action" with "disposition_reason", or "task" / "decision" / "limitation" with "disposition_ids" naming ids that appear in the turn.
- limitation -> "mitigated" (worked around) or "closed" (no longer true), when the turn shows it. note: how.
- idea -> "adopted" (the person commits to it) or "dropped". note: why.
Do not settle an item the turn merely mentions, discusses or plans to address.

OUTPUT: valid JSON only, no commentary, no fences. An array:
[{"id": "<item id>", "status": "<new status>", "note": "<short sentence>", "disposition": "...", "disposition_ids": ["..."], "disposition_reason": "..."}]
Omit the disposition fields except for a finding. If nothing is settled, return exactly: []`;
    list6 = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : []).map(String).map((s) => s.trim()).filter(Boolean);
  }
});

// packages/core/src/curation/health.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync9 } from "node:fs";
import { dirname as dirname6, join as join8 } from "node:path";
function captureHealthFile() {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join8(dirname6(health), "capture-health.json") : "";
}
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function readCaptureHealth(path3 = captureHealthFile()) {
  if (!path3) return void 0;
  try {
    const h = JSON.parse(readFileSync9(path3, "utf-8"));
    return h && typeof h.at === "number" && h.days && typeof h.days === "object" ? h : void 0;
  } catch {
    return void 0;
  }
}
function applyCaptureEvent(h, e, now) {
  const days = {};
  const key = dayKey(now);
  for (const [k, v] of Object.entries(h?.days ?? {})) days[k] = { ...emptyDay(), ...v };
  const day = days[key] ?? (days[key] = emptyDay());
  const next = { ...h, days, at: now };
  const fail2 = (stage, err) => {
    next.last_error = { at: now, stage, message: message(err) };
  };
  if (e.kind === "turn") {
    day.turns++;
    day.stored += e.stored;
    day.skipped += e.skipped;
    day.settled += e.settled;
    if (e.followThroughError !== void 0) {
      day.follow_through_failed++;
      fail2("follow-through", e.followThroughError);
    }
    if (e.storeError !== void 0) {
      day.store_failed++;
      fail2("store", e.storeError);
    }
    if (e.followThroughError === void 0 && e.storeError === void 0) {
      day.clean++;
      next.last_ok_at = now;
    }
  } else if (e.kind === "turn_failed") {
    day.failed++;
    fail2("extractor", e.error);
  } else {
    day.compactions++;
    if (e.error !== void 0) {
      day.compactions_failed++;
      fail2("compaction", e.error);
    } else {
      next.last_ok_at = now;
    }
  }
  for (const k of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[k];
  return next;
}
function recordCapture(e, now = Date.now(), path3 = captureHealthFile()) {
  if (!path3) return;
  try {
    mkdirSync5(dirname6(path3), { recursive: true });
    withFileLockSync(lockFileFor(path3), () => writeJsonAtomic(path3, applyCaptureEvent(readCaptureHealth(path3), e, now)), { waitMs: 2e3 });
  } catch {
  }
}
function summarizeCapture(h, now = Date.now(), days = 7) {
  const out = {
    days,
    turns: 0,
    stored: 0,
    skipped: 0,
    settled: 0,
    failed: 0,
    follow_through_failed: 0,
    store_failed: 0,
    compactions: 0,
    compactions_failed: 0,
    failing: false
  };
  if (!h) return out;
  const t = new Date(now);
  const keys = new Set(Array.from({ length: days }, (_, i) => dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i, 12).getTime())));
  for (const [k, d] of Object.entries(h.days)) {
    if (!keys.has(k)) continue;
    for (const f of ["turns", "stored", "skipped", "settled", "failed", "follow_through_failed", "store_failed", "compactions", "compactions_failed"]) out[f] += Number(d[f] ?? 0);
  }
  out.last_ok_at = h.last_ok_at;
  out.last_error = h.last_error;
  out.failing = captureFailing(h, now);
  return out;
}
function dayRuns(d) {
  const n = (k) => Number(d[k] ?? 0);
  const clean = d.clean === void 0 ? n("turns") - n("follow_through_failed") : n("clean");
  return { bad: n("failed") + (n("turns") - clean) + n("compactions_failed"), good: clean + n("compactions") - n("compactions_failed") };
}
function captureFailing(h, now = Date.now()) {
  if (!h) return false;
  const err = h.last_error;
  if (err && err.stage !== "follow-through" && err.at >= (h.last_ok_at ?? 0) && now - err.at < 36e5) return true;
  const d = h.days[dayKey(now)];
  if (!d) return false;
  const { bad: bad2, good } = dayRuns(d);
  return bad2 >= 2 && bad2 > good;
}
function captureDownLine(h = readCaptureHealth(), now = Date.now()) {
  const err = h?.last_error;
  if (!h || !err || now - err.at > 864e5 || (h.last_ok_at ?? 0) > err.at) return void 0;
  const { bad: bad2 } = dayRuns(h.days[dayKey(now)] ?? {});
  const why = CONSEQUENCE[err.stage] ?? CONSEQUENCE.extractor;
  return `**YAPA capture is failing** (${err.stage}${bad2 ? `, ${bad2} failed run(s) today` : ""}): ${err.message.slice(0, 160)}. So ${why}; \`yapa capture status\` for details.`;
}
var KEEP_DAYS, emptyDay, message, CONSEQUENCE;
var init_health2 = __esm({
  "packages/core/src/curation/health.ts"() {
    "use strict";
    init_config();
    init_fs_lock();
    init_http_backend();
    KEEP_DAYS = 14;
    emptyDay = () => ({
      turns: 0,
      clean: 0,
      stored: 0,
      skipped: 0,
      settled: 0,
      failed: 0,
      follow_through_failed: 0,
      store_failed: 0,
      compactions: 0,
      compactions_failed: 0
    });
    message = (e) => redactTokens((e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ")).replace(/^(.*?extractor response[^:]*):.*$/i, "$1").slice(0, 300);
    CONSEQUENCE = {
      extractor: "memories from recent turns may be missing",
      store: "some memories from recent turns could not be stored",
      "follow-through": "open decisions, questions and findings may not have been updated",
      compaction: "session summaries may be missing"
    };
  }
});

// packages/core/src/curation/capture.ts
async function captureTurn(input2, options, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  try {
    await d.writable(input2.collection);
  } catch (e) {
    if (e instanceof CollectionLeftError) return { stored: 0, skipped: 0, superseded: 0 };
    throw e;
  }
  const state = {};
  try {
    const r = await runCapture(input2, options, d, state);
    d.record({
      kind: "turn",
      stored: r.stored,
      skipped: r.skipped,
      settled: r.settled?.length ?? 0,
      ...state.followThroughError !== void 0 ? { followThroughError: state.followThroughError } : {},
      ...state.storeError !== void 0 ? { storeError: state.storeError } : {}
    });
    return r;
  } catch (e) {
    d.record({ kind: "turn_failed", error: e });
    throw e;
  }
}
async function runCapture(input2, options, d, state) {
  const { collection, sessionId: sessionId2, turn } = input2;
  let settled = [];
  try {
    const f = await d.followThrough({ collection, userText: input2.userText, assistantText: input2.assistantText, taskIds: options.taskIds });
    settled = f.changes.map((c) => ({ id: c.id, kind: c.kind, status: c.status, note: c.note }));
  } catch (e) {
    state.followThroughError = e;
    d.log(`Follow-through failed in ${collection}: ${e}`);
  }
  const settledNotice = settled.length ? `Recorded from last turn: ${settled.map((c) => `${c.kind} ${c.id} ${c.status}${c.note ? ` (${c.note})` : ""}`).join("; ")}` : void 0;
  const candidates = await d.extractMemories(
    {
      collection,
      userText: input2.userText.slice(0, MAX_EXTRACT_CHARS),
      assistantText: input2.assistantText.slice(0, MAX_EXTRACT_CHARS)
    },
    { maxMemories: options.maxMemories }
  );
  if (!candidates.length) {
    if (settledNotice) d.log(`${settledNotice} [session ${sessionId2}, turn ${turn}]`);
    return { stored: 0, skipped: 0, superseded: 0, ...settled.length ? { settled, notice: settledNotice } : {} };
  }
  let stored = 0;
  let skipped = 0;
  let superseded = 0;
  for (const candidate of candidates) {
    const neighbors = await d.queryDocuments(collection, candidate.content, 3, { type: "memory" }).then((results) => results.filter((r) => r.distance < options.dedupeDistance && r.metadata?.archived !== true)).catch(() => []);
    let content = candidate.content;
    let supersedes;
    let resolverRationale;
    if (neighbors.length > 0) {
      let decision;
      try {
        decision = await d.resolveConflict(
          candidate.content,
          neighbors.map((n) => ({ id: n.id, content: n.content, distance: n.distance, salience: n.metadata?.salience }))
        );
      } catch (e) {
        d.log(`Resolver failed for a candidate in ${collection}: ${e}`);
        const strictThreshold = options.dedupeDistance / 2;
        if (neighbors.some((n) => n.distance < strictThreshold)) {
          skipped++;
          continue;
        }
        decision = { action: "add", rationale: "resolver error, passed strict distance gate" };
      }
      if (decision.action === "skip") {
        skipped++;
        continue;
      }
      if (decision.action === "supersede" && decision.targetId && isMemoryKind(neighbors.find((n) => n.id === decision.targetId)?.metadata?.kind)) {
        skipped++;
        continue;
      }
      if (decision.action === "supersede" && decision.targetId) {
        supersedes = decision.targetId;
        content = decision.mergedContent ?? candidate.content;
        resolverRationale = decision.rationale;
      }
    }
    const typed = candidate.kind ? { kind: candidate.kind, ...candidate.kind === "decision" ? { status: "accepted" } : {}, ...candidate.owner ? { owner: candidate.owner } : {}, ...options.taskIds?.length ? { task_ids: options.taskIds } : {} } : void 0;
    try {
      await d.storeMemory(content, {
        collection,
        ...typed ? { typed } : {},
        tags: [.../* @__PURE__ */ new Set([...candidate.tags, "auto-capture"])],
        salience: Math.min(candidate.salience, options.maxSalience),
        sector: candidate.sector,
        supersedes,
        metadata: {
          source: "auto-capture",
          session_id: sessionId2,
          turn,
          extractor_prompt_version: EXTRACTOR_PROMPT_VERSION,
          rationale: candidate.rationale,
          ...resolverRationale !== void 0 && {
            resolver_prompt_version: RESOLVER_PROMPT_VERSION,
            resolver_rationale: resolverRationale
          }
        }
      });
    } catch (e) {
      state.storeError = e;
      d.log(`Storing a captured memory failed in ${collection}: ${e}`);
      continue;
    }
    stored++;
    if (supersedes) superseded++;
  }
  let notice;
  if (stored > 0 || skipped > 0) {
    notice = `Auto-captured ${stored} ${stored === 1 ? "memory" : "memories"} from last turn` + (superseded ? `, ${superseded} superseding stale ${superseded === 1 ? "memory" : "memories"}` : "") + (skipped ? ` (${skipped} skipped as already known)` : "") + ` \u2192 \`${collection}\``;
    d.log(`${notice} [session ${sessionId2}, turn ${turn}]`);
  }
  if (settledNotice) notice = notice ? `${settledNotice}. ${notice}` : settledNotice;
  return { stored, skipped, superseded, ...settled.length ? { settled } : {}, notice };
}
var MAX_EXTRACT_CHARS, defaultDeps;
var init_capture = __esm({
  "packages/core/src/curation/capture.ts"() {
    "use strict";
    init_store();
    init_store2();
    init_kinds();
    init_follow_through();
    init_health2();
    init_sentinel();
    init_extractor();
    init_resolver();
    MAX_EXTRACT_CHARS = 12e3;
    defaultDeps = {
      followThrough,
      extractMemories,
      queryDocuments: queryDocuments2,
      resolveConflict,
      storeMemory,
      log: (msg) => process.stderr.write(`[yapa] ${msg}
`),
      record: (e) => recordCapture(e),
      writable: resolveWriteCollection
    };
  }
});

// packages/core/src/buckets/artifacts.ts
import { existsSync, mkdirSync as mkdirSync6, readdirSync as readdirSync4, readFileSync as readFileSync10, writeFileSync as writeFileSync4 } from "fs";
import { join as join9 } from "path";
function artifactDir(kind) {
  return join9(getConfig().ARTIFACTS_DIR, kind);
}
function ensureArtifactDir(kind) {
  const dir = artifactDir(kind);
  if (!existsSync(dir)) mkdirSync6(dir, { recursive: true });
  return dir;
}
function nextVersion(kind) {
  const dir = ensureArtifactDir(kind);
  const files = readdirSync4(dir);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^v(\d+)\./);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}
function listVersions(kind) {
  const dir = artifactDir(kind);
  if (!existsSync(dir)) return [];
  const versions = /* @__PURE__ */ new Set();
  for (const f of readdirSync4(dir)) {
    const m = f.match(/^v(\d+)\./);
    if (m) versions.add(parseInt(m[1], 10));
  }
  return [...versions].sort((a, b) => a - b);
}
function writeArtifact(kind, filename, content) {
  const dir = ensureArtifactDir(kind);
  const path3 = join9(dir, filename);
  writeFileSync4(path3, content);
  return path3;
}
function readArtifact(kind, filename) {
  const path3 = join9(artifactDir(kind), filename);
  if (!existsSync(path3)) return null;
  return readFileSync10(path3, "utf-8");
}
function artifactPath(kind, filename) {
  return join9(artifactDir(kind), filename);
}
var init_artifacts = __esm({
  "packages/core/src/buckets/artifacts.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/buckets/router.ts
function systemPromptThresholds() {
  return {
    trainable: getConfig().SYSTEM_PROMPT_TRAINABLE_MIN,
    durability: getConfig().SYSTEM_PROMPT_DURABILITY_MIN,
    generalizability: getConfig().SYSTEM_PROMPT_GENERALIZABILITY_MIN
  };
}
function trainingThresholds() {
  return {
    trainable: getConfig().TRAINING_TRAINABLE_MIN,
    durability: getConfig().TRAINING_DURABILITY_MIN,
    generalizability: getConfig().TRAINING_GENERALIZABILITY_MIN
  };
}
function routeMemory(input2, custom) {
  const { metadata } = input2;
  const sp = custom?.systemPrompt ?? systemPromptThresholds();
  const tr = custom?.training ?? trainingThresholds();
  const buckets = [];
  const reasons = {
    "system-prompt": "",
    training: ""
  };
  if (metadata.classified_at == null) {
    const r = "not classified yet";
    reasons["system-prompt"] = r;
    reasons.training = r;
    return { buckets, reasons };
  }
  const t = Number(metadata.trainable ?? 0);
  const d = Number(metadata.durability ?? 0);
  const g = Number(metadata.generalizability ?? 0);
  const spRecord = metadata.promoted_to?.toString().startsWith("system-prompt") || metadata.selected_for?.toString().startsWith("system-prompt");
  const trRecord = metadata.promoted_to?.toString().startsWith("training") || metadata.selected_for?.toString().startsWith("training");
  if (spRecord) {
    reasons["system-prompt"] = "already routed to system-prompt bucket";
  } else if (t >= sp.trainable && d >= sp.durability && g >= sp.generalizability) {
    buckets.push("system-prompt");
    reasons["system-prompt"] = `scores meet system-prompt thresholds (t=${t.toFixed(2)} d=${d.toFixed(2)} g=${g.toFixed(2)})`;
  } else {
    reasons["system-prompt"] = belowReason("system-prompt", sp, t, d, g);
  }
  if (trRecord) {
    reasons.training = "already routed to training bucket";
  } else if (t >= tr.trainable && d >= tr.durability && g >= tr.generalizability) {
    buckets.push("training");
    reasons.training = `scores meet training thresholds (t=${t.toFixed(2)} d=${d.toFixed(2)} g=${g.toFixed(2)})`;
  } else {
    reasons.training = belowReason("training", tr, t, d, g);
  }
  return { buckets, reasons };
}
function belowReason(bucket, th, t, d, g) {
  const miss = [];
  if (t < th.trainable) miss.push(`trainable ${t.toFixed(2)} < ${th.trainable}`);
  if (d < th.durability) miss.push(`durability ${d.toFixed(2)} < ${th.durability}`);
  if (g < th.generalizability) miss.push(`generalizability ${g.toFixed(2)} < ${th.generalizability}`);
  return `below ${bucket}: ${miss.join(", ")}`;
}
var init_router = __esm({
  "packages/core/src/buckets/router.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/buckets/system-prompt.ts
function writeSystemPromptCompanion(version, memories, thresholds) {
  const companion = renderCompanion(version, memories);
  const manifest = renderManifest(version, memories, thresholds);
  const companionName = `v${version}.md`;
  const manifestName = `v${version}.manifest.json`;
  const companionPath = writeArtifact("system-prompt-companion", companionName, companion);
  const manifestPath = writeArtifact("system-prompt-companion", manifestName, manifest);
  return {
    version,
    companionPath,
    manifestPath,
    memoryIds: memories.map((m) => m.id)
  };
}
function renderCompanion(version, memories) {
  if (memories.length === 0) {
    return `# System-prompt companion v${version}

_No memories met the routing thresholds for this bucket._
`;
  }
  const byCollection = /* @__PURE__ */ new Map();
  for (const m of memories) {
    const arr = byCollection.get(m.collection) ?? [];
    arr.push(m);
    byCollection.set(m.collection, arr);
  }
  const lines = [
    `# System-prompt companion v${version}`,
    "",
    "_Durable, generalizable knowledge that should be available as persistent context. Generated by YAPA bucket routing._",
    ""
  ];
  const collections = [...byCollection.keys()].sort();
  for (const coll of collections) {
    lines.push(`## ${coll}`);
    lines.push("");
    for (const m of byCollection.get(coll)) {
      lines.push(m.content);
      lines.push("");
    }
  }
  return lines.join("\n");
}
function renderManifest(version, memories, thresholds) {
  const payload = {
    version,
    kind: "system-prompt-companion",
    created_at: Math.floor(Date.now() / 1e3),
    thresholds,
    memory_ids: memories.map((m) => m.id),
    memories: memories.map((m) => ({
      id: m.id,
      collection: m.collection,
      trainable: m.metadata.trainable,
      durability: m.metadata.durability,
      generalizability: m.metadata.generalizability
    }))
  };
  return JSON.stringify(payload, null, 2) + "\n";
}
var init_system_prompt = __esm({
  "packages/core/src/buckets/system-prompt.ts"() {
    "use strict";
    init_artifacts();
  }
});

// packages/core/src/buckets/training-manifest.ts
function writeTrainingManifest(version, memories, thresholds) {
  const lines = memories.map((m) => JSON.stringify({
    id: m.id,
    collection: m.collection,
    content: m.content,
    trainable: m.metadata.trainable,
    durability: m.metadata.durability,
    generalizability: m.metadata.generalizability,
    rationale: m.metadata.classification_rationale
  }));
  const manifestName = `v${version}.jsonl`;
  const sidecarName = `v${version}.manifest.json`;
  const manifestPath = writeArtifact(
    "training-manifests",
    manifestName,
    lines.join("\n") + (lines.length ? "\n" : "")
  );
  const sidecar = JSON.stringify({
    version,
    kind: "training-manifest",
    created_at: Math.floor(Date.now() / 1e3),
    thresholds,
    memory_count: memories.length,
    memory_ids: memories.map((m) => m.id)
  }, null, 2) + "\n";
  const sidecarPath = writeArtifact("training-manifests", sidecarName, sidecar);
  return {
    version,
    manifestPath,
    sidecarPath,
    memoryIds: memories.map((m) => m.id)
  };
}
var init_training_manifest = __esm({
  "packages/core/src/buckets/training-manifest.ts"() {
    "use strict";
    init_artifacts();
  }
});

// packages/core/src/buckets/index.ts
async function collectClassifiedMemories() {
  const collections = await listCollections2();
  const out = [];
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION2);
      for (const d of docs) {
        if (d.metadata.classified_at != null) {
          out.push({
            id: d.id,
            collection: c.name,
            content: d.content,
            metadata: d.metadata
          });
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}
function computeRouting(memories) {
  const sp = systemPromptThresholds();
  const tr = trainingThresholds();
  return memories.map((m) => {
    const decision = routeMemory({ metadata: m.metadata }, { systemPrompt: sp, training: tr });
    return { ...m, buckets: decision.buckets, reasons: decision.reasons };
  });
}
function collectCurrentThresholds() {
  return {
    systemPrompt: {
      trainable: getConfig().SYSTEM_PROMPT_TRAINABLE_MIN,
      durability: getConfig().SYSTEM_PROMPT_DURABILITY_MIN,
      generalizability: getConfig().SYSTEM_PROMPT_GENERALIZABILITY_MIN
    },
    training: {
      trainable: getConfig().TRAINING_TRAINABLE_MIN,
      durability: getConfig().TRAINING_DURABILITY_MIN,
      generalizability: getConfig().TRAINING_GENERALIZABILITY_MIN
    }
  };
}
async function bucketRoutePreview() {
  const memories = await collectClassifiedMemories();
  const entries = computeRouting(memories);
  return {
    systemPromptVersion: nextVersion("system-prompt-companion"),
    trainingVersion: nextVersion("training-manifests"),
    systemPromptCandidates: entries.filter((e) => e.buckets.includes("system-prompt")),
    trainingCandidates: entries.filter((e) => e.buckets.includes("training")),
    thresholds: collectCurrentThresholds()
  };
}
async function bucketRouteNow() {
  const memories = await collectClassifiedMemories();
  const entries = computeRouting(memories);
  const spVersion = nextVersion("system-prompt-companion");
  const trVersion = nextVersion("training-manifests");
  const spCandidates = entries.filter((e) => e.buckets.includes("system-prompt"));
  const trCandidates = entries.filter((e) => e.buckets.includes("training"));
  const thresholds = collectCurrentThresholds();
  let systemPromptArtifact;
  if (spCandidates.length > 0) {
    const result = writeSystemPromptCompanion(spVersion, spCandidates, {
      trainable: thresholds.systemPrompt.trainable,
      durability: thresholds.systemPrompt.durability,
      generalizability: thresholds.systemPrompt.generalizability
    });
    systemPromptArtifact = { companionPath: result.companionPath, manifestPath: result.manifestPath };
  }
  let trainingArtifact;
  if (trCandidates.length > 0) {
    const result = writeTrainingManifest(trVersion, trCandidates, {
      trainable: thresholds.training.trainable,
      durability: thresholds.training.durability,
      generalizability: thresholds.training.generalizability
    });
    trainingArtifact = { manifestPath: result.manifestPath, sidecarPath: result.sidecarPath };
  }
  const now = Math.floor(Date.now() / 1e3);
  let tagged = 0;
  async function tag(entry, bucket, tag2) {
    const updated = {
      ...entry.metadata,
      selected_for: tag2,
      selected_at: now
    };
    try {
      await patchDocument(entry.collection, entry.id, metadataDelta(entry.metadata, updated));
      tagged++;
    } catch (e) {
      process.stderr.write(`[yapa-buckets] Tag error for ${entry.id}: ${e}
`);
    }
  }
  if (spCandidates.length > 0) {
    for (const e of spCandidates) await tag(e, "system-prompt", `system-prompt-v${spVersion}`);
  }
  if (trCandidates.length > 0) {
    for (const e of trCandidates) await tag(e, "training", `training-v${trVersion}`);
  }
  const decisions = entries.map((e) => ({
    id: e.id,
    collection: e.collection,
    buckets: e.buckets,
    reasons: e.reasons,
    scores: {
      trainable: e.metadata.trainable,
      durability: e.metadata.durability,
      generalizability: e.metadata.generalizability
    }
  }));
  const routingDecisions = JSON.stringify({
    created_at: now,
    system_prompt_version: spCandidates.length > 0 ? spVersion : null,
    training_version: trCandidates.length > 0 ? trVersion : null,
    thresholds,
    decisions
  }, null, 2) + "\n";
  const auditVersion = Math.max(spVersion, trVersion);
  const routingDecisionsPath = writeArtifact(
    "routing-decisions",
    `v${auditVersion}.json`,
    routingDecisions
  );
  if (spCandidates.length > 0 || trCandidates.length > 0) {
    process.stderr.write(
      `[yapa-buckets] Routed ${spCandidates.length} to system-prompt-v${spVersion}, ${trCandidates.length} to training-v${trVersion}
`
    );
  } else {
    process.stderr.write("[yapa-buckets] No memories met routing thresholds\n");
  }
  return {
    systemPromptVersion: spVersion,
    trainingVersion: trVersion,
    systemPromptCandidates: spCandidates,
    trainingCandidates: trCandidates,
    thresholds,
    systemPromptArtifact,
    trainingArtifact,
    routingDecisionsPath,
    tagged
  };
}
async function systemPromptActivate(version) {
  const target = `system-prompt-v${version}`;
  const collections = await listCollections2();
  let promoted = 0;
  const now = Math.floor(Date.now() / 1e3);
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION2);
      for (const d of docs) {
        if (d.metadata.selected_for === target && d.metadata.promoted_to == null) {
          await patchDocument(c.name, d.id, { promoted_to: target, promoted_at: now });
          promoted++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-buckets] Activate error in ${c.name}: ${e}
`);
    }
  }
  return { promoted };
}
async function systemPromptDeactivate(version) {
  const target = `system-prompt-v${version}`;
  const collections = await listCollections2();
  let rolledBack = 0;
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION2);
      for (const d of docs) {
        if (d.metadata.promoted_to === target) {
          const updated = { ...d.metadata };
          delete updated.promoted_to;
          delete updated.promoted_at;
          await patchDocument(c.name, d.id, metadataDelta(d.metadata, updated));
          rolledBack++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-buckets] Deactivate error in ${c.name}: ${e}
`);
    }
  }
  return { rolledBack };
}
async function bucketStatus() {
  const collections = await listCollections2();
  const bySelection = {};
  const byPromotion = {};
  let pendingClassification = 0;
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION2);
      for (const d of docs) {
        if (d.metadata.classified_at == null) pendingClassification++;
        const sel = d.metadata.selected_for;
        const prom = d.metadata.promoted_to;
        if (sel) bySelection[sel] = (bySelection[sel] ?? 0) + 1;
        if (prom) byPromotion[prom] = (byPromotion[prom] ?? 0) + 1;
      }
    } catch {
      continue;
    }
  }
  return { bySelection, byPromotion, pendingClassification };
}
var MAX_PER_COLLECTION2;
var init_buckets = __esm({
  "packages/core/src/buckets/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_artifacts();
    init_router();
    init_system_prompt();
    init_training_manifest();
    MAX_PER_COLLECTION2 = 2e3;
  }
});

// packages/core/src/sync/pull.ts
function emptyPullStats() {
  return { pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, archived: 0, keptDirty: 0, errors: 0 };
}
async function pullFromRemote() {
  const stats = emptyPullStats();
  const backend = await getSyncBackend();
  if (!backend) return stats;
  await resolveSyncUsername();
  const cycleStartedAt = Math.floor(Date.now() / 1e3) - getConfig().SYNC_PULL_OVERLAP_SECONDS;
  const lastPull = await getSyncPullTimestamp();
  const recovering = lastPull === 0;
  if (recovering) {
    try {
      const unfollowed2 = await getUnfollowedCollections();
      const mine = (await backend.collectionsForUser()).filter((c) => isSyncableCollection(c) && !unfollowed2.has(c));
      const subs = await getSyncSubscriptions();
      const add = mine.filter((c) => !subs.includes(c));
      if (add.length) await updateSyncSubscriptions([...subs, ...add]);
    } catch (e) {
      process.stderr.write(`[yapa-sync] Recovery subscribe failed: ${e}
`);
      noteSyncError(e);
      if (isCycleFatal(e)) {
        stats.errors++;
        return stats;
      }
    }
  }
  const collections = await listCollections2();
  const localCollectionNames = new Set(collections.map((c) => c.name));
  const unfollowed = await getUnfollowedCollections();
  const pullCollectionNames = [];
  for (const col of collections) {
    if (isSyncableCollection(col.name) && !unfollowed.has(col.name)) pullCollectionNames.push(col.name);
  }
  const pendingBackfills = (await getPendingBackfills()).filter((n) => !unfollowed.has(n));
  const backfill = new Set(pendingBackfills);
  const subscriptions = await getSyncSubscriptions();
  for (const sub of subscriptions) {
    if ((!localCollectionNames.has(sub) || backfill.has(sub)) && isSyncableCollection(sub) && !unfollowed.has(sub)) {
      await getOrCreateCollection2(sub);
      if (!pullCollectionNames.includes(sub)) pullCollectionNames.push(sub);
      backfill.add(sub);
    }
  }
  const followed = new Set(pullCollectionNames);
  let fatal = false;
  for (const collectionName of pullCollectionNames) {
    const errorsBefore = stats.errors;
    await pullCollection(collectionName, backfill.has(collectionName) ? 0 : lastPull, stats, {
      includeOwnDevice: recovering,
      followedCollections: followed,
      onFatal: () => {
        fatal = true;
      }
    });
    if (fatal) break;
    if (pendingBackfills.includes(collectionName) && stats.errors === errorsBefore) await clearPendingBackfill(collectionName);
  }
  if (!fatal) await updateSyncPullTimestamp(cycleStartedAt);
  return stats;
}
async function pullCollection(collectionName, since, stats = emptyPullStats(), opts = {}) {
  if (!isSyncableCollection(collectionName)) return stats;
  const backend = await getSyncBackend();
  if (!backend) return stats;
  const failed = (what, e) => {
    process.stderr.write(`[yapa-sync] ${what}: ${e}
`);
    noteSyncError(e);
    stats.errors++;
    if (isCycleFatal(e)) opts.onFatal?.();
    return isCycleFatal(e);
  };
  if (opts.followedCollections) {
    let fatal = false;
    await dropMovedOut(backend, collectionName, opts.followedCollections, stats).catch((e) => {
      fatal = failed(`Move check failed for ${collectionName}`, e);
    });
    if (fatal) return stats;
  }
  try {
    let tombstones;
    let cursor;
    const seen = /* @__PURE__ */ new Set();
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const res = await backend.pull(collectionName, { since, cursor, includeOwnDevice: opts.includeOwnDevice });
      if (res.documents.length > 0 || res.deletions.length > 0) {
        await getOrCreateCollection2(collectionName);
        tombstones ??= await getLocalTombstones();
        for (const d of res.documents) seen.add(d.id);
        for (const del of res.deletions) {
          if (seen.has(del.id)) continue;
          try {
            await applyRemoteDeletion(collectionName, del, stats);
          } catch (e) {
            process.stderr.write(`[yapa-sync] Pull delete error for ${del.id}: ${e}
`);
            stats.errors++;
          }
        }
        for (const remoteDoc of res.documents) {
          try {
            if (tombstones.has(remoteDoc.id) || remoteDoc.metadata?.type === "journal_draft") {
              stats.skipped++;
              continue;
            }
            await applyRemoteDoc(backend, collectionName, remoteDoc, stats);
          } catch (e) {
            process.stderr.write(`[yapa-sync] Pull error for ${remoteDoc.id}: ${e}
`);
            stats.errors++;
          }
        }
      }
      if (!res.hasMore || !res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
  } catch (e) {
    failed(`Pull error for collection ${collectionName}`, e);
  }
  return stats;
}
async function applyRemoteDeletion(collectionName, del, stats) {
  await withDocLock(collectionName, del.id, async () => {
    const [existing] = await getDocumentsByIds2(collectionName, [del.id]).catch(() => []);
    if (!existing) return;
    if (del.purged) {
      await deleteDocument2(collectionName, del.id);
      stats.deleted++;
      if (existing.metadata.is_synced === false) process.stderr.write(`[yapa-sync] ${del.id} was purged by ${del.deleted_by}: dropped here, with its unpushed edits
`);
      return;
    }
    if (existing.metadata.is_synced === false && !isDeletedUpstream(existing.metadata)) {
      stats.keptDirty++;
      process.stderr.write(`[yapa-sync] ${del.id} was deleted remotely by ${del.deleted_by}, but this copy has unpushed edits: kept (it will be pushed again)
`);
      return;
    }
    if (del.reason === "retract" && del.deleted_by !== getConfig().USERNAME) {
      await deleteDocument2(collectionName, del.id);
      stats.deleted++;
      return;
    }
    if (isDeletedUpstream(existing.metadata)) return;
    await patchDocument(collectionName, del.id, {
      archived: true,
      // Equality-filterable marker, so the trash and its sweep needn't scan every archived doc.
      deleted_upstream: true,
      deleted_upstream_by: del.deleted_by,
      deleted_upstream_at: Number(del.deleted_at) || Math.floor(Date.now() / 1e3),
      deleted_upstream_reason: del.reason ?? "delete"
    });
    stats.archived++;
  });
}
function toUnixSeconds(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1e3);
}
function localMetadataFor(remoteDoc) {
  return {
    ...remoteDoc.metadata,
    origin_user: remoteDoc.origin_user,
    related_ids: remoteDoc.related_ids,
    updated_at: toUnixSeconds(remoteDoc.updated_at) || remoteDoc.metadata?.updated_at,
    is_synced: true
    // Already synced from remote
  };
}
async function copiesElsewhere(id, except) {
  const out = [];
  for (const col of await listCollections2()) {
    if (col.name === except || !isSyncableCollection(col.name)) continue;
    const [doc] = await getDocumentsByIds2(col.name, [id]).catch(() => []);
    if (doc) out.push({ collection: col.name, dirty: doc.metadata.is_synced === false });
  }
  return out;
}
async function dropMovedOut(backend, collectionName, followed, stats) {
  const local2 = (await getDocumentsByFilter2(collectionName, {}, 1e5)).filter((d) => !d.id.startsWith("__") && d.metadata.type !== "journal_draft" && d.metadata.is_synced !== false);
  if (local2.length === 0) return;
  const remote = await backend.collectionsByIds(local2.map((d) => d.id));
  for (const doc of local2) {
    const now = remote.get(doc.id);
    if (!now || now === collectionName || followed.has(now)) continue;
    await deleteDocument2(collectionName, doc.id);
    stats.moved++;
  }
}
async function applyRemoteDoc(backend, collectionName, remoteDoc, stats) {
  const after = [];
  await withDocLock(collectionName, remoteDoc.id, () => applyRemoteDocLocked(backend, collectionName, remoteDoc, stats, after));
  for (const fn of after) await fn().catch((e) => process.stderr.write(`[yapa-sync] Link error for ${remoteDoc.id}: ${e}
`));
}
async function applyRemoteDocLocked(backend, collectionName, remoteDoc, stats, after) {
  const [existing] = await getDocumentsByIds2(collectionName, [remoteDoc.id]).catch(() => []);
  if (!existing) {
    const elsewhere = await copiesElsewhere(remoteDoc.id, collectionName);
    if (elsewhere.some((c) => c.dirty)) {
      stats.skipped++;
      return;
    }
    if (elsewhere.length > 0) {
      for (const c of elsewhere) await deleteDocument2(c.collection, remoteDoc.id);
      await addDocument2(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
      stats.moved++;
      return;
    }
  }
  if (existing) {
    const upstreamGone = isDeletedUpstream(existing.metadata);
    const localDirty = existing.metadata.is_synced === false && !upstreamGone;
    const localUpdated = toUnixSeconds(existing.metadata.updated_at ?? existing.metadata.created_at);
    if (upstreamGone || !localDirty && toUnixSeconds(remoteDoc.updated_at) > localUpdated) {
      await addDocument2(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
      stats.updated++;
    } else {
      stats.skipped++;
    }
    return;
  }
  try {
    const similarLocal = await queryDocuments2(collectionName, remoteDoc.content, 1);
    if (similarLocal.length > 0) {
      const similarity = 1 - similarLocal[0].distance;
      if (similarity > getConfig().SYNC_SIMILARITY_THRESHOLD) {
        const localId = similarLocal[0].id;
        after.push(async () => {
          await withDocLock(collectionName, localId, async () => {
            const [cur] = await getDocumentsByIds2(collectionName, [localId]);
            if (!cur) return;
            const related = Array.isArray(cur.metadata.related_ids) ? [...cur.metadata.related_ids] : [];
            if (!related.includes(remoteDoc.id)) await patchDocument(collectionName, localId, { related_ids: [...related, remoteDoc.id] });
          });
          await backend.addRelatedIds(remoteDoc.id, [localId]);
        });
        stats.linked++;
      }
    }
  } catch {
  }
  await addDocument2(collectionName, remoteDoc.id, remoteDoc.content, localMetadataFor(remoteDoc));
  stats.pulled++;
}
var MAX_PULL_PAGES;
var init_pull = __esm({
  "packages/core/src/sync/pull.ts"() {
    "use strict";
    init_doc_lock();
    init_config();
    init_store();
    init_backend();
    init_sentinel();
    init_deletes();
    init_syncable();
    MAX_PULL_PAGES = 200;
  }
});

// packages/core/src/sync/shared-cycle.ts
import { createHash as createHash3 } from "node:crypto";
import { closeSync as closeSync2, mkdirSync as mkdirSync7, openSync as openSync2, readFileSync as readFileSync11, renameSync as renameSync4, rmSync as rmSync4, writeFileSync as writeFileSync5, writeSync as writeSync2 } from "node:fs";
import { dirname as dirname7, join as join10 } from "node:path";
function syncTargetKey(config = getConfig()) {
  let remote = "";
  if (config.SYNC_MCP_URL) remote = `mcp:${config.SYNC_MCP_URL}`;
  else if (config.SYNC_SERVICE_URL) remote = `service:${config.SYNC_SERVICE_URL}`;
  else if (config.SYNC_DATABASE_URL) {
    try {
      const u = new URL(config.SYNC_DATABASE_URL);
      remote = `postgres:${u.hostname}:${u.port}${u.pathname}`;
    } catch {
      remote = "postgres:unparsed";
    }
  }
  const store = config.STORAGE === "local" ? `local:${config.LOCAL_STORE_PATH}` : `chroma:${config.CHROMA_URL}`;
  return createHash3("sha256").update(JSON.stringify([remote, store, config.USERNAME])).digest("hex").slice(0, 12);
}
function sharedDir(config = getConfig()) {
  if (!config.SYNC_COORDINATE || !config.SYNC_HEALTH_FILE) return void 0;
  return dirname7(config.SYNC_HEALTH_FILE);
}
function paths(config = getConfig()) {
  const dir = sharedDir(config);
  if (!dir) return void 0;
  const key = syncTargetKey(config);
  return {
    dir,
    record: join10(dir, `sync-cycle-${key}.json`),
    lock: join10(dir, `sync-cycle-${key}.lock`),
    pulls: join10(dir, `sync-pulls-${key}.json`)
  };
}
function readJson(path3) {
  try {
    return JSON.parse(readFileSync11(path3, "utf-8"));
  } catch {
    return void 0;
  }
}
function writeJson(path3, value) {
  try {
    mkdirSync7(dirname7(path3), { recursive: true, mode: 448 });
    const tmp = `${path3}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync5(tmp, JSON.stringify(value) + "\n", { mode: 384 });
    renameSync4(tmp, path3);
  } catch {
  }
}
function readCycleRecord(config = getConfig()) {
  const p = paths(config);
  if (!p) return void 0;
  const r = readJson(p.record);
  return r && typeof r.finished_at === "number" ? r : void 0;
}
function shouldRunCycle(now = Date.now(), config = getConfig()) {
  const r = readCycleRecord(config);
  if (!r) return true;
  return now - r.finished_at >= config.SYNC_INTERVAL_MS * DUE_FRACTION || r.finished_at > now + 6e4;
}
function tryAcquireCycle(opts = {}, config = getConfig()) {
  const p = paths(config);
  if (!p) return () => {
  };
  const now = opts.now ?? Date.now();
  const alive2 = opts.alive ?? pidAlive;
  const staleAfter = Math.max(2 * config.SYNC_INTERVAL_MS, MIN_STALE_LOCK_MS);
  const body = { pid: process.pid, started_at: now, ...opts.version ? { version: opts.version } : {} };
  for (let attempt2 = 0; attempt2 < 2; attempt2++) {
    try {
      mkdirSync7(p.dir, { recursive: true, mode: 448 });
      const fd = openSync2(p.lock, "wx", 384);
      try {
        writeSync2(fd, JSON.stringify(body));
      } finally {
        closeSync2(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const held2 = readJson(p.lock);
        if (held2?.pid === process.pid && held2.started_at === now) rmSync4(p.lock, { force: true });
      };
    } catch (e) {
      if (e.code !== "EEXIST") return () => {
      };
      const held2 = readJson(p.lock);
      const stale2 = !held2 || !alive2(held2.pid) || now - held2.started_at > staleAfter || held2.started_at > now + 6e4;
      if (!stale2 || attempt2 > 0) return void 0;
      rmSync4(p.lock, { force: true });
    }
  }
  return void 0;
}
function recordCycle(run2, config = getConfig()) {
  const p = paths(config);
  if (!p) return;
  const prev = readJson(p.record);
  const finished = run2.finishedAt ?? Date.now();
  const next = {
    started_at: run2.startedAt,
    finished_at: finished,
    pid: process.pid,
    cycles: (typeof prev?.cycles === "number" ? prev.cycles : 0) + 1,
    ...run2.version ? { version: run2.version } : {}
  };
  const okAt = run2.ok ? finished : prev?.ok_at;
  if (okAt) next.ok_at = okAt;
  writeJson(p.record, next);
}
function shouldPull(collection, now = Date.now(), config = getConfig()) {
  const p = paths(config);
  const window = config.HOOK_PULL_WINDOW_MS;
  if (!p || !(window > 0)) return true;
  const pulls = readJson(p.pulls) ?? {};
  const last = Math.max(Number(pulls[collection]) || 0, readCycleRecord(config)?.ok_at ?? 0);
  if (last > now + 6e4) return true;
  return now - last >= window;
}
function recordPull(collection, now = Date.now(), config = getConfig()) {
  const p = paths(config);
  if (!p) return;
  const pulls = readJson(p.pulls) ?? {};
  const keep = Math.max(config.HOOK_PULL_WINDOW_MS, 6e4) * 10;
  const next = {};
  for (const [c, at] of Object.entries(pulls)) if (typeof at === "number" && now - at < keep) next[c] = at;
  next[collection] = now;
  writeJson(p.pulls, next);
}
var DUE_FRACTION, MIN_STALE_LOCK_MS;
var init_shared_cycle = __esm({
  "packages/core/src/sync/shared-cycle.ts"() {
    "use strict";
    init_fs_lock();
    init_config();
    DUE_FRACTION = 0.9;
    MIN_STALE_LOCK_MS = 10 * 60 * 1e3;
  }
});

// packages/core/src/update-check.ts
import { mkdirSync as mkdirSync8, readFileSync as readFileSync12, renameSync as renameSync5, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname8, join as join11 } from "node:path";
function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a ?? "").trim());
  const pb = SEMVER.exec(String(b ?? "").trim());
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return (pa[4] ?? "").localeCompare(pb[4] ?? "");
}
function updateStatePath() {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join11(dirname8(health), "update-check.json") : void 0;
}
function readUpdateState(path3 = updateStatePath()) {
  if (!path3) return void 0;
  try {
    const s = JSON.parse(readFileSync12(path3, "utf-8"));
    return s && typeof s.current === "string" && typeof s.checked_at === "number" ? s : void 0;
  } catch {
    return void 0;
  }
}
function writeUpdateState(s, path3 = updateStatePath()) {
  if (!path3) return;
  try {
    mkdirSync8(dirname8(path3), { recursive: true, mode: 448 });
    const tmp = `${path3}.${process.pid}.tmp`;
    writeFileSync6(tmp, JSON.stringify(s) + "\n", { mode: 384 });
    renameSync5(tmp, path3);
  } catch {
  }
}
function noteInstalledVersion(current, path3 = updateStatePath()) {
  if (!path3) return void 0;
  const prev = readUpdateState(path3);
  if (prev && prev.current === current) return prev;
  const next = { current, checked_at: prev?.checked_at ?? 0 };
  if (prev?.latest && compareVersions(prev.latest, current) > 0) next.latest = prev.latest;
  if (next.latest && prev?.notified === next.latest) next.notified = prev.notified;
  writeUpdateState(next, path3);
  return next;
}
async function checkForUpdate(current, opts = {}) {
  const config = getConfig();
  const path3 = opts.path ?? updateStatePath();
  if (!config.UPDATE_CHECK || !path3 || !config.UPDATE_SOURCE) return void 0;
  const now = opts.now ?? Date.now();
  const prev = noteInstalledVersion(current, path3);
  if (!opts.force && prev && prev.checked_at > 0 && now - prev.checked_at < UPDATE_CHECK_INTERVAL_MS) return prev;
  let released;
  try {
    const r = await (opts.fetchImpl ?? fetch)(config.UPDATE_SOURCE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return prev;
    const body = await r.json();
    if (typeof body?.version !== "string" || !SEMVER.test(body.version.trim())) return prev;
    released = body.version.trim().replace(/^v/, "");
  } catch {
    return prev;
  }
  const next = { current, checked_at: now };
  if (compareVersions(released, current) > 0) next.latest = released;
  if (next.latest && prev?.notified === next.latest) next.notified = prev.notified;
  writeUpdateState(next, path3);
  return next;
}
function markUpdateNotified(version, path3 = updateStatePath()) {
  const s = readUpdateState(path3);
  if (s && s.latest === version && s.notified !== version) writeUpdateState({ ...s, notified: version }, path3);
}
function startUpdateChecks(current) {
  if (timer2 || !getConfig().UPDATE_CHECK) return;
  void checkForUpdate(current);
  timer2 = setInterval(() => void checkForUpdate(current), UPDATE_CHECK_INTERVAL_MS);
  timer2.unref?.();
}
function stopUpdateChecks() {
  if (timer2) clearInterval(timer2);
  timer2 = void 0;
}
var UPDATE_CHECK_INTERVAL_MS, FETCH_TIMEOUT_MS, SEMVER, timer2;
var init_update_check = __esm({
  "packages/core/src/update-check.ts"() {
    "use strict";
    init_config();
    UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
    FETCH_TIMEOUT_MS = 5e3;
    SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
  }
});

// packages/core/src/sync/index.ts
function getSyncState() {
  return { lastCycleAt, lastCycleError, cycleCount: cycleCount2, skippedCount, timerActive: timerActive2, lastStats, lastError: lastSyncError() ?? null };
}
async function syncCycle() {
  if (syncRunning) {
    process.stderr.write("[yapa-sync] Skipping cycle \u2014 previous still running\n");
    return null;
  }
  syncRunning = true;
  const startedAt = Date.now();
  try {
    let pushStats = emptyPushStats();
    let pullStats = emptyPullStats();
    try {
      pushStats = await pushToRemote();
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push phase error: ${e}
`);
      pushStats.errors++;
    }
    try {
      pullStats = await pullFromRemote();
    } catch (e) {
      process.stderr.write(`[yapa-sync] Pull phase error: ${e}
`);
      pullStats.errors++;
    }
    const hasPushActivity = pushStats.pushed > 0 || pushStats.linked > 0 || pushStats.deleted > 0 || pushStats.purged > 0 || pushStats.retracted > 0;
    const hasPullActivity = pullStats.pulled > 0 || pullStats.updated > 0 || pullStats.moved > 0 || pullStats.linked > 0 || pullStats.deleted > 0 || pullStats.archived > 0 || pullStats.keptDirty > 0;
    const hasErrors = pushStats.errors > 0 || pullStats.errors > 0;
    if (hasPushActivity || hasPullActivity || pushStats.rejected > 0) {
      process.stderr.write(`[yapa-sync] ${formatSyncStats({ push: pushStats, pull: pullStats })}
`);
    }
    if (hasErrors) {
      process.stderr.write(
        `[yapa-sync] Errors: ${pushStats.errors} push, ${pullStats.errors} pull
`
      );
    }
    try {
      await (await getSyncBackend())?.maintain();
    } catch {
    }
    if (!hasErrors) {
      try {
        const { retryUnsharedClaims: retryUnsharedClaims2 } = await Promise.resolve().then(() => (init_claim(), claim_exports));
        await retryUnsharedClaims2();
      } catch (e) {
        process.stderr.write(`[yapa-sync] Claim retry error: ${e}
`);
      }
    }
    const unpushed = await countUnpushed().catch(() => void 0);
    if (!hasErrors) noteSyncOk(unpushed);
    else if (unpushed !== void 0) recordUnpushed(unpushed);
    lastCycleAt = Date.now();
    lastCycleError = null;
    cycleCount2++;
    lastStats = { push: pushStats, pull: pullStats };
    recordCycle({ startedAt, finishedAt: lastCycleAt, ok: !hasErrors, version: runningVersion });
    return lastStats;
  } catch (e) {
    const msg = `${e}`;
    process.stderr.write(`[yapa-sync] Cycle error: ${msg}
`);
    lastCycleAt = Date.now();
    lastCycleError = msg;
    cycleCount2++;
    recordCycle({ startedAt, finishedAt: lastCycleAt, ok: false, version: runningVersion });
    return null;
  } finally {
    syncRunning = false;
  }
}
function runTracked(work) {
  const tracked = work.finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;
  return tracked;
}
async function pushNow() {
  const stats = await pushToRemote();
  const unpushed = await countUnpushed().catch(() => void 0);
  if (stats.errors === 0) noteSyncOk(unpushed);
  else if (unpushed !== void 0) recordUnpushed(unpushed);
  return stats;
}
function scheduleSyncSoon(delayMs = getConfig().SYNC_PUSH_DEBOUNCE_MS) {
  if (!isSyncConfigured() || delayMs <= 0) return;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    runTracked(pushNow()).catch((e) => process.stderr.write(`[yapa-sync] Write-triggered push error: ${e}
`));
  }, delayMs);
}
async function syncTick(opts = {}) {
  const now = opts.now ?? Date.now();
  let due = shouldRunCycle(now);
  if (!due && opts.initial) {
    const lastPull = await getSyncPullTimestamp().catch(() => 0);
    const last = readCycleRecord();
    due = lastPull === 0 || !!runningVersion && compareVersions(runningVersion, last?.version) > 0;
  }
  if (!due) {
    skippedCount++;
    return null;
  }
  const release = tryAcquireCycle({ now, version: runningVersion });
  if (!release) {
    skippedCount++;
    return null;
  }
  try {
    return await syncCycle();
  } finally {
    release();
  }
}
function scheduleTick() {
  const base = getConfig().SYNC_INTERVAL_MS;
  const delay = Math.max(1e3, Math.round(base * (0.9 + Math.random() * 0.2)));
  syncTimer = setTimeout(() => {
    runTracked(syncTick()).catch((e) => process.stderr.write(`[yapa-sync] Sync error: ${e}
`)).finally(() => {
      if (timerActive2) scheduleTick();
    });
  }, delay);
}
function hasPendingSync() {
  return soonTimer !== null;
}
async function flushPendingSync(timeoutMs = 5e3) {
  const work = [];
  if (soonTimer) {
    clearTimeout(soonTimer);
    soonTimer = null;
    work.push(runTracked(pushToRemote()).catch((e) => process.stderr.write(`[yapa-sync] Shutdown push error: ${e}
`)));
  } else if (inFlight) {
    work.push(inFlight.catch(() => void 0));
  }
  if (work.length === 0) return;
  let timer3;
  const timeout = new Promise((resolve3) => {
    timer3 = setTimeout(resolve3, timeoutMs);
  });
  await Promise.race([Promise.all(work), timeout]);
  if (timer3) clearTimeout(timer3);
}
async function startSync(opts = {}) {
  if (opts.version) runningVersion = opts.version;
  if (!getConfig().SYNC_ENABLED) {
    recordSyncHealth({ status: "disabled" });
    return;
  }
  const kind = syncBackendKind();
  if (!kind) {
    process.stderr.write("[yapa-sync] YAPA_SYNC_SERVICE_URL (or YAPA_SYNC_MCP_URL) not set: sync disabled\n");
    recordSyncHealth({ status: "disabled" });
    return;
  }
  const transport = syncTransportKind();
  if (kind === "service" && getConfig().SYNC_DATABASE_URL) {
    process.stderr.write("[yapa-sync] Using the sync service; YAPA_SYNC_DATABASE_URL is ignored\n");
  }
  if (transport === "mcp" && getConfig().SYNC_SERVICE_URL) {
    process.stderr.write("[yapa-sync] Using sync over MCP; YAPA_SYNC_SERVICE_URL is ignored\n");
  }
  if (kind !== "service" && !process.env.YAPA_USERNAME) {
    process.stderr.write(`[yapa-sync] Username defaults to the OS login '${getConfig().USERNAME}'. Set YAPA_USERNAME (plugin option username) to a name unique on your team: task ids and ownership are keyed on it.
`);
  }
  try {
    const backend = await getSyncBackend();
    await backend?.prepare();
    const what = transport === "mcp" ? "the sync service over MCP" : kind === "service" ? "the sync service" : "the remote database";
    process.stderr.write(`[yapa-sync] Connected to ${what} (${backend?.target})
`);
  } catch (e) {
    process.stderr.write(`[yapa-sync] Sync not connected: ${e}
`);
    process.stderr.write("[yapa-sync] Sync will retry on next interval\n");
  }
  runTracked(syncTick({ initial: true })).catch((e) => process.stderr.write(`[yapa-sync] Initial sync error: ${e}
`));
  timerActive2 = true;
  scheduleTick();
  process.stderr.write(`[yapa-sync] Background sync started (interval: ${getConfig().SYNC_INTERVAL_MS / 1e3}s)
`);
}
function formatSyncStats({ push, pull }) {
  let line = `Push: ${push.pushed} new, ${push.linked} linked, ${push.deleted} deleted, ${push.purged ?? 0} purged, ${push.retracted} retracted`;
  if (push.renamed) line += `, ${push.renamed} renamed`;
  if (push.rejected) line += `, ${push.rejected} refused (kept local)`;
  line += `, ${push.errors} errors | Pull: ${pull.pulled} new, ${pull.updated} updated, ${pull.moved} moved, ${pull.linked} linked, ${pull.deleted} deleted, ${pull.archived ?? 0} archived, ${pull.skipped} skipped`;
  if (pull.keptDirty) line += `, ${pull.keptDirty} remote deletions not applied (local edits kept)`;
  return `${line}, ${pull.errors} errors`;
}
async function stopSync() {
  timerActive2 = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  await closeSyncBackend();
  process.stderr.write("[yapa-sync] Sync stopped\n");
}
var syncTimer, syncRunning, runningVersion, lastCycleAt, lastCycleError, cycleCount2, skippedCount, timerActive2, lastStats, soonTimer, inFlight;
var init_sync = __esm({
  "packages/core/src/sync/index.ts"() {
    "use strict";
    init_config();
    init_push();
    init_pull();
    init_backend();
    init_health();
    init_shared_cycle();
    init_sentinel();
    init_update_check();
    syncTimer = null;
    syncRunning = false;
    lastCycleAt = null;
    lastCycleError = null;
    cycleCount2 = 0;
    skippedCount = 0;
    timerActive2 = false;
    lastStats = null;
    soonTimer = null;
    inFlight = null;
  }
});

// packages/core/src/training/fireworks.ts
import { spawn as spawn2 } from "child_process";
function tryJsonParse(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
    } catch {
    }
  }
  return null;
}
function mapState(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("complete") || s === "succeeded" || s === "success") return "completed";
  if (s.includes("fail") || s === "error") return "failed";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("run") || s === "in_progress") return "running";
  if (s === "pending" || s === "queued" || s === "created") return "pending";
  return "unknown";
}
function extractJobIdFromText(stdout) {
  const patterns = [
    /(?:job\s*id|id)\s*[:=]\s*([A-Za-z0-9_\-]+)/i,
    /sftj_[A-Za-z0-9]+/
  ];
  for (const p of patterns) {
    const m = stdout.match(p);
    if (m) return m[1] ?? m[0];
  }
  return null;
}
var defaultRunner, FireworksBackend;
var init_fireworks = __esm({
  "packages/core/src/training/fireworks.ts"() {
    "use strict";
    init_config();
    defaultRunner = {
      async run(args) {
        return new Promise((resolve3, reject) => {
          const child = spawn2(getConfig().TRAINING_FIRECTL_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += d.toString();
          });
          child.stderr.on("data", (d) => {
            stderr += d.toString();
          });
          child.on("error", (err) => {
            if (err.code === "ENOENT") {
              reject(new Error(
                `firectl not found at "${getConfig().TRAINING_FIRECTL_PATH}". Install it from https://docs.fireworks.ai/tools-sdks/firectl or set YAPA_TRAINING_FIRECTL_PATH to its location.`
              ));
            } else {
              reject(err);
            }
          });
          child.on("close", (code) => {
            resolve3({ stdout, stderr, code: code ?? -1 });
          });
        });
      }
    };
    FireworksBackend = class {
      constructor(runner = defaultRunner) {
        this.runner = runner;
      }
      runner;
      name = "fireworks";
      async submit(config) {
        const datasetId = config.outputModelId.replace(/[^a-z0-9-]/gi, "-").toLowerCase() + "-data";
        const dsArgs = ["create", "dataset", datasetId, config.datasetPath];
        const dsResult = await this.runner.run(dsArgs);
        if (dsResult.code !== 0 && !/already exists/i.test(dsResult.stderr)) {
          throw new Error(`firectl dataset create failed: ${dsResult.stderr || dsResult.stdout}`);
        }
        const jobArgs = [
          "sftj",
          "create",
          "--base-model",
          config.baseModel,
          "--dataset",
          datasetId,
          "--output-model",
          config.outputModelId
        ];
        if (config.evaluationDatasetPath) {
          jobArgs.push("--evaluation-dataset", config.evaluationDatasetPath);
        }
        const hp = config.hyperparameters ?? {};
        if (typeof hp.epochs === "number") jobArgs.push("--epochs", String(hp.epochs));
        if (typeof hp.learningRate === "number") jobArgs.push("--learning-rate", String(hp.learningRate));
        if (typeof hp.loraRank === "number") jobArgs.push("--lora-rank", String(hp.loraRank));
        if (hp.earlyStop === true) jobArgs.push("--early-stop");
        const jobResult = await this.runner.run(jobArgs);
        if (jobResult.code !== 0) {
          throw new Error(`firectl sftj create failed: ${jobResult.stderr || jobResult.stdout}`);
        }
        const parsed = tryJsonParse(jobResult.stdout);
        const jobId = parsed?.id ?? parsed?.name ?? extractJobIdFromText(jobResult.stdout);
        if (!jobId) {
          throw new Error(`Could not determine job ID from firectl output:
${jobResult.stdout}`);
        }
        return {
          backend: this.name,
          jobId: String(jobId),
          raw: parsed ?? jobResult.stdout
        };
      }
      async poll(handle) {
        const result = await this.runner.run(["sftj", "get", handle.jobId]);
        if (result.code !== 0) {
          return {
            state: "unknown",
            error: result.stderr || result.stdout
          };
        }
        const parsed = tryJsonParse(result.stdout);
        const state = mapState(parsed?.state ?? parsed?.status);
        return {
          state,
          outputModelRef: parsed?.outputModel ?? parsed?.output_model ?? parsed?.output_model_ref,
          error: state === "failed" ? parsed?.error ?? "failed" : void 0,
          raw: parsed ?? result.stdout
        };
      }
      async retrieve(handle) {
        const status = await this.poll(handle);
        if (status.state !== "completed") {
          throw new Error(`Cannot retrieve \u2014 job ${handle.jobId} is in state ${status.state}`);
        }
        const ref = status.outputModelRef;
        if (!ref) throw new Error(`Completed job ${handle.jobId} had no outputModelRef`);
        return {
          ref,
          metadata: { raw: status.raw, backend: this.name }
        };
      }
      async cancel(handle) {
        const result = await this.runner.run(["sftj", "cancel", handle.jobId]);
        if (result.code !== 0) {
          throw new Error(`firectl sftj cancel failed: ${result.stderr || result.stdout}`);
        }
      }
    };
  }
});

// packages/core/src/training/registry.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync9, readFileSync as readFileSync13, writeFileSync as writeFileSync7 } from "fs";
import { join as join12 } from "path";
function registryPath() {
  return join12(getConfig().ARTIFACTS_DIR, "adapters", "registry.json");
}
function ensureDir() {
  const dir = join12(getConfig().ARTIFACTS_DIR, "adapters");
  if (!existsSync2(dir)) mkdirSync9(dir, { recursive: true });
}
function load() {
  ensureDir();
  const path3 = registryPath();
  if (!existsSync2(path3)) return { version: 1, adapters: [] };
  try {
    const parsed = JSON.parse(readFileSync13(path3, "utf-8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.adapters)) {
      return { version: 1, adapters: [] };
    }
    return parsed;
  } catch {
    return { version: 1, adapters: [] };
  }
}
function save(file) {
  ensureDir();
  writeFileSync7(registryPath(), JSON.stringify(file, null, 2) + "\n");
}
function addAdapter(entry) {
  const file = load();
  file.adapters.push(entry);
  save(file);
  return entry;
}
function getAdapter(id) {
  const file = load();
  return file.adapters.find((a) => a.id === id) ?? null;
}
function listAdapters() {
  return load().adapters;
}
function updateAdapter(id, updates) {
  const file = load();
  const idx = file.adapters.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const merged = {
    ...file.adapters[idx],
    ...updates,
    updatedAt: Math.floor(Date.now() / 1e3)
  };
  file.adapters[idx] = merged;
  save(file);
  return merged;
}
function getRegistryPath() {
  return registryPath();
}
var init_registry = __esm({
  "packages/core/src/training/registry.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/training/synthesis.ts
import { readFileSync as readFileSync14 } from "fs";
async function synthesizeMemory(memory, options = {}) {
  const caller = options.call ?? callCurationLLM;
  const userPrompt = `[MEMORY]
ID: ${memory.id}${memory.collection ? `
COLLECTION: ${memory.collection}` : ""}
CONTENT:
${memory.content}`;
  const raw = await caller({
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.3,
    max_tokens: 2048,
    json_mode: true
  });
  const examples = parseSynthesisResponse(raw);
  return { id: memory.id, examples };
}
function parseSynthesisResponse(raw) {
  const parsed = extractJsonArray3(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Synthesis response not a JSON array: ${raw.slice(0, 200)}`);
  }
  const results = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const messages = entry.messages;
    if (!Array.isArray(messages) || messages.length < 2) continue;
    const cleaned = [];
    let valid = true;
    for (const m of messages) {
      if (!m || typeof m !== "object") {
        valid = false;
        break;
      }
      const role = m.role;
      const content = m.content;
      if (!["system", "user", "assistant"].includes(role) || typeof content !== "string") {
        valid = false;
        break;
      }
      cleaned.push({ role, content });
    }
    if (!valid) continue;
    if (!cleaned.some((m) => m.role === "assistant")) continue;
    results.push({ messages: cleaned });
  }
  return results;
}
function extractJsonArray3(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
    }
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }
  throw new Error(`Could not extract JSON array from synthesis response: ${raw.slice(0, 200)}`);
}
function readManifestSource(path3) {
  const content = readFileSync14(path3, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l) => {
    const entry = JSON.parse(l);
    return { id: entry.id, collection: entry.collection, content: entry.content };
  });
}
function formatTrainingJsonl(results) {
  const lines = [];
  for (const r of results) {
    for (const ex of r.examples) {
      lines.push(JSON.stringify(ex));
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}
var SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SYSTEM_PROMPT;
var init_synthesis = __esm({
  "packages/core/src/training/synthesis.ts"() {
    "use strict";
    init_config();
    init_provider();
    SYNTHESIS_PROMPT_VERSION = "v1";
    SYNTHESIS_SYSTEM_PROMPT = `You convert a single memory into one or more training examples for supervised fine-tuning.

GOAL

Produce examples that teach a language model the PATTERNS, STYLE, and REASONING in the memory \u2014 not point-in-time facts. Examples must be standalone: a reader with no access to the memory should still get a plausible answer from the user/system turn alone.

FORMAT

Return valid JSON only, no commentary. The output must be a JSON array of one to three training examples, each in OpenAI chat format:

[
  {
    "messages": [
      { "role": "system", "content": "<optional persona or task framing>" },
      { "role": "user", "content": "<question or prompt a realistic user might ask>" },
      { "role": "assistant", "content": "<ideal response grounded in the memory's content/reasoning>" }
    ]
  }
]

RULES

- Keep user prompts realistic \u2014 not "Summarize this memory" but rather the kind of question a user would naturally ask.
- Assistant responses must reflect the reasoning, style, and judgment in the memory. Do not copy the memory verbatim; transform it into a response.
- If the memory is purely a transient fact ("version X is running on Y"), return an empty array [] \u2014 such memories are not suitable for fine-tuning.
- Keep examples under 800 tokens total each.
- Do not wrap the JSON in \`\`\` fences.
- Do not include fields other than "messages" on each example.`;
  }
});

// packages/core/src/training/index.ts
import { createHash as createHash4 } from "crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync10, readFileSync as readFileSync15, writeFileSync as writeFileSync8 } from "fs";
import { join as join13 } from "path";
function getBackend() {
  switch (getConfig().TRAINING_BACKEND) {
    case "fireworks":
      return new FireworksBackend();
    default:
      throw new Error(`Unknown training backend: ${getConfig().TRAINING_BACKEND}`);
  }
}
function previewDir() {
  const dir = join13(getConfig().ARTIFACTS_DIR, "training-runs");
  if (!existsSync3(dir)) mkdirSync10(dir, { recursive: true });
  return dir;
}
function sha256(content) {
  return createHash4("sha256").update(content, "utf-8").digest("hex");
}
async function trainingDatasetPreview(manifestVersion) {
  const manifestName = `v${manifestVersion}.jsonl`;
  const manifestPath = artifactPath("training-manifests", manifestName);
  if (!existsSync3(manifestPath)) {
    throw new Error(`Training manifest not found: ${manifestPath}. Run bucket_route_now first.`);
  }
  const sourceMemories = readManifestSource(manifestPath);
  const results = [];
  let skipped = 0;
  for (const mem of sourceMemories) {
    try {
      const result = await synthesizeMemory(mem);
      if (result.examples.length === 0) {
        skipped++;
      } else {
        results.push(result);
      }
    } catch (e) {
      process.stderr.write(`[yapa-training] Synthesis error for ${mem.id}: ${e}
`);
      skipped++;
    }
  }
  const jsonl = formatTrainingJsonl(results);
  const exampleCount = results.reduce((n, r) => n + r.examples.length, 0);
  const dir = previewDir();
  const filename = `preview-v${manifestVersion}-${Date.now()}.jsonl`;
  const previewPath = join13(dir, filename);
  writeFileSync8(previewPath, jsonl);
  return {
    manifestVersion,
    previewPath,
    previewRef: sha256(jsonl),
    exampleCount,
    skippedMemories: skipped
  };
}
async function trainingTrigger(args) {
  if (args.confirm !== true) {
    throw new Error("Refusing to submit \u2014 confirm must be true.");
  }
  if (!existsSync3(args.previewPath)) {
    throw new Error(`Preview file not found: ${args.previewPath}. Run training_dataset_preview first.`);
  }
  const contentOnDisk = readFileSync15(args.previewPath, "utf-8");
  const diskHash = sha256(contentOnDisk);
  if (diskHash !== args.previewRef) {
    throw new Error(
      `Preview hash mismatch. The preview file has been modified since it was generated, or preview_ref does not match. Run training_dataset_preview again and pass the returned preview_ref.`
    );
  }
  const adapterId = args.adapterId ?? `yapa-adapter-v${args.manifestVersion}-${Date.now()}`;
  const backend = getBackend();
  const now = Math.floor(Date.now() / 1e3);
  const entry = {
    id: adapterId,
    manifestVersion: args.manifestVersion,
    datasetPath: args.previewPath,
    previewRef: args.previewRef,
    baseModel: getConfig().TRAINING_BASE_MODEL,
    backend: backend.name,
    status: "pending",
    createdAt: now,
    updatedAt: now
  };
  addAdapter(entry);
  try {
    const handle = await backend.submit({
      datasetPath: args.previewPath,
      baseModel: getConfig().TRAINING_BASE_MODEL,
      outputModelId: adapterId,
      hyperparameters: args.hyperparameters
    });
    updateAdapter(adapterId, {
      backendJobId: handle.jobId,
      status: "running"
    });
    return { adapterId, handle };
  } catch (e) {
    updateAdapter(adapterId, {
      status: "failed",
      error: String(e)
    });
    await clearSelectedForManifest(args.manifestVersion);
    throw e;
  }
}
async function trainingStatus() {
  return { adapters: listAdapters() };
}
async function trainingGet(adapterId) {
  const entry = getAdapter(adapterId);
  if (!entry) return null;
  if (entry.backendJobId && (entry.status === "running" || entry.status === "pending")) {
    try {
      const backend = getBackend();
      const status = await backend.poll({ backend: entry.backend, jobId: entry.backendJobId });
      let mappedStatus = entry.status;
      if (status.state === "completed") mappedStatus = "completed";
      else if (status.state === "failed") mappedStatus = "failed";
      else if (status.state === "cancelled") mappedStatus = "cancelled";
      else if (status.state === "running") mappedStatus = "running";
      else if (status.state === "pending") mappedStatus = "pending";
      const updated = updateAdapter(adapterId, {
        status: mappedStatus,
        outputModelRef: status.outputModelRef ?? entry.outputModelRef,
        error: status.error
      });
      return {
        entry: updated ?? entry,
        remoteStatus: {
          state: status.state,
          error: status.error,
          outputModelRef: status.outputModelRef
        }
      };
    } catch (e) {
      return {
        entry,
        remoteStatus: { state: "unknown", error: String(e) }
      };
    }
  }
  return { entry };
}
async function trainingCancel(adapterId) {
  const entry = getAdapter(adapterId);
  if (!entry) return null;
  if (!entry.backendJobId) {
    return updateAdapter(adapterId, { status: "cancelled" });
  }
  const backend = getBackend();
  try {
    await backend.cancel({ backend: entry.backend, jobId: entry.backendJobId });
  } catch (e) {
    process.stderr.write(`[yapa-training] Cancel error for ${adapterId}: ${e}
`);
  }
  const result = updateAdapter(adapterId, { status: "cancelled" });
  await clearSelectedForManifest(entry.manifestVersion);
  return result;
}
async function clearSelectedForManifest(manifestVersion) {
  const target = `training-v${manifestVersion}`;
  const collections = await listCollections2();
  let cleared = 0;
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION3);
      for (const d of docs) {
        if (d.metadata.selected_for === target) {
          const updated = { ...d.metadata };
          delete updated.selected_for;
          delete updated.selected_at;
          await patchDocument(c.name, d.id, metadataDelta(d.metadata, updated));
          cleared++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-training] Clear selected_for error in ${c.name}: ${e}
`);
    }
  }
  return { cleared };
}
var MAX_PER_COLLECTION3;
var init_training = __esm({
  "packages/core/src/training/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_artifacts();
    init_fireworks();
    init_registry();
    init_synthesis();
    MAX_PER_COLLECTION3 = 2e3;
  }
});

// packages/core/src/training/backend.ts
var init_backend2 = __esm({
  "packages/core/src/training/backend.ts"() {
    "use strict";
  }
});

// packages/core/src/training/inference.ts
var defaultInferenceCaller;
var init_inference = __esm({
  "packages/core/src/training/inference.ts"() {
    "use strict";
    init_config();
    defaultInferenceCaller = async (opts) => {
      if (!getConfig().FIREWORKS_API_KEY) {
        throw new Error("YAPA_FIREWORKS_API_KEY not set \u2014 cannot call the adapter inference endpoint.");
      }
      const response = await fetch(`${getConfig().INFERENCE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getConfig().FIREWORKS_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0,
          max_tokens: opts.max_tokens ?? 1024
        })
      });
      if (!response.ok) {
        throw new Error(`Adapter inference error: ${response.status} ${await response.text()}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`Unexpected inference response shape: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return content;
    };
  }
});

// packages/core/src/training/judge.ts
async function judgeAggregate(reference, candidate, userPrompt, options = {}) {
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: "system", content: AGGREGATE_JUDGE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `QUESTION:
${userPrompt}

REFERENCE:
${reference}

CANDIDATE:
${candidate}`
      }
    ],
    temperature: 0,
    max_tokens: 512,
    json_mode: true
  });
  return parseAggregateJudge(raw);
}
function parseAggregateJudge(raw) {
  const parsed = extractObject(raw);
  const score = clamp012(parsed?.score);
  const winnerRaw = String(parsed?.winner ?? "").toLowerCase();
  const winner = winnerRaw === "candidate" || winnerRaw === "reference" || winnerRaw === "tie" ? winnerRaw : score > 0.5 ? "candidate" : score < 0.5 ? "reference" : "tie";
  const rationale = typeof parsed?.rationale === "string" ? parsed.rationale : "";
  return { score, winner, rationale };
}
async function judgeVerification(memoryContent, adapterAnswer, userPrompt, options = {}) {
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: "system", content: VERIFY_JUDGE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `QUESTION TO THE MODEL:
${userPrompt}

REFERENCE MEMORY:
${memoryContent}

MODEL ANSWER:
${adapterAnswer}`
      }
    ],
    temperature: 0,
    max_tokens: 400,
    json_mode: true
  });
  return parseVerifyJudge(raw);
}
function parseVerifyJudge(raw) {
  const parsed = extractObject(raw);
  const passed = parsed?.passed === true || String(parsed?.passed).toLowerCase() === "true";
  const confidence = clamp012(parsed?.confidence);
  const rationale = typeof parsed?.rationale === "string" ? parsed.rationale : "";
  return { passed, confidence, rationale };
}
function clamp012(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function extractObject(raw) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }
  throw new Error(`Could not extract JSON object from judge response: ${raw.slice(0, 200)}`);
}
var AGGREGATE_JUDGE_SYSTEM_PROMPT, VERIFY_JUDGE_SYSTEM_PROMPT;
var init_judge = __esm({
  "packages/core/src/training/judge.ts"() {
    "use strict";
    init_provider();
    AGGREGATE_JUDGE_SYSTEM_PROMPT = `You are an impartial grader for language model outputs. Given a REFERENCE answer (the ground-truth, derived from the user's curated memory) and a CANDIDATE answer (produced by a model), decide whether the CANDIDATE is at least as good as the REFERENCE on content, reasoning, and coverage.

Return valid JSON only, no commentary, no fences:

{"score": <0.0-1.0>, "winner": "candidate" | "reference" | "tie", "rationale": "<one short sentence>"}

Scoring:
- 1.0 = candidate clearly superior or strictly matches the reference
- 0.75 = candidate matches the reference's key claims, minor gaps
- 0.5 = partial coverage or mostly correct with notable gaps
- 0.25 = shallow or partially wrong
- 0.0 = wrong, contradictory, or empty

Do not invent information. Do not reward fluency over correctness.`;
    VERIFY_JUDGE_SYSTEM_PROMPT = `You verify whether a model's ANSWER covers the key content of a REFERENCE memory well enough that the memory can safely be removed from retrieval (because the knowledge now lives in the model's weights).

Return valid JSON only:

{"passed": <true|false>, "confidence": <0.0-1.0>, "rationale": "<one short sentence>"}

Pass criteria \u2014 BOTH must hold:
- The ANSWER states the memory's key claims, reasoning, or guidance.
- The ANSWER is factually consistent with the memory (no contradictions, no invented details).

Partial coverage is a fail. Being correct on general principles but missing the specific content of the memory is a fail.`;
  }
});

// packages/core/src/training/holdout.ts
import { readFileSync as readFileSync16 } from "fs";
function seededShuffle(items, seed) {
  const arr = items.slice();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let s = h || 2654435769;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967295;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function splitManifest(memories, manifestVersion, fraction = getConfig().EVAL_HOLDOUT_FRACTION, minHoldout = getConfig().EVAL_HOLDOUT_MIN) {
  if (memories.length === 0) return { train: [], holdout: [] };
  const shuffled = seededShuffle(memories, `manifest-v${manifestVersion}`);
  const raw = Math.round(memories.length * fraction);
  const holdoutSize = Math.min(
    memories.length - 1,
    // always keep at least 1 in train
    Math.max(Math.min(minHoldout, memories.length), raw)
  );
  return {
    train: shuffled.slice(holdoutSize),
    holdout: shuffled.slice(0, holdoutSize)
  };
}
function loadManifestSplit(manifestPath, manifestVersion) {
  const memories = readManifestSource(manifestPath);
  return splitManifest(memories, manifestVersion);
}
function readHoldoutFile(path3) {
  const content = readFileSync16(path3, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l) => {
    const entry = JSON.parse(l);
    return { id: entry.id, collection: entry.collection, content: entry.content };
  });
}
var init_holdout = __esm({
  "packages/core/src/training/holdout.ts"() {
    "use strict";
    init_config();
    init_synthesis();
  }
});

// packages/core/src/training/eval.ts
async function evalRun(input2, options = {}) {
  const inference = options.inferenceCall ?? defaultInferenceCaller;
  const manifestName = `v${input2.manifestVersion}.jsonl`;
  const manifestPath = artifactPath("training-manifests", manifestName);
  const { holdout } = loadManifestSplit(manifestPath, input2.manifestVersion);
  const items = [];
  for (const mem of holdout) {
    let userPrompt = "";
    let candidateAnswer = "";
    try {
      const syn = await synthesizeMemory(mem);
      const example = syn.examples[0];
      if (!example) continue;
      const userTurn = example.messages.find((m) => m.role === "user");
      const assistantTurn = example.messages.find((m) => m.role === "assistant");
      if (!userTurn || !assistantTurn) continue;
      userPrompt = userTurn.content;
      candidateAnswer = await inference({
        model: input2.adapterRef,
        messages: [
          ...example.messages.filter((m) => m.role !== "assistant")
        ],
        temperature: 0,
        max_tokens: 1024
      });
      const result = await judgeAggregate(
        assistantTurn.content,
        candidateAnswer,
        userPrompt,
        { call: options.judgeCall }
      );
      items.push({
        memoryId: mem.id,
        score: result.score,
        winner: result.winner,
        rationale: result.rationale,
        userPrompt
      });
    } catch (e) {
      items.push({
        memoryId: mem.id,
        score: 0,
        winner: "reference",
        rationale: `error: ${e}`,
        userPrompt
      });
    }
  }
  const averageScore = items.length > 0 ? items.reduce((s, i) => s + i.score, 0) / items.length : 0;
  return {
    adapterRef: input2.adapterRef,
    manifestVersion: input2.manifestVersion,
    itemCount: items.length,
    averageScore,
    items
  };
}
async function evalCompare(adapterRefA, adapterRefB, manifestVersion, options = {}) {
  const a = await evalRun({ adapterRef: adapterRefA, manifestVersion }, options);
  const b = await evalRun({ adapterRef: adapterRefB, manifestVersion }, options);
  const delta = b.averageScore - a.averageScore;
  const winner = delta > 0.01 ? "B" : delta < -0.01 ? "A" : "tie";
  return { adapterA: a, adapterB: b, delta, winner };
}
var init_eval = __esm({
  "packages/core/src/training/eval.ts"() {
    "use strict";
    init_artifacts();
    init_inference();
    init_judge();
    init_holdout();
    init_synthesis();
  }
});

// packages/core/src/training/promotion.ts
async function adapterPromote(args) {
  if (args.confirm !== true) {
    throw new Error("Refusing to promote \u2014 confirm must be true.");
  }
  const entry = getAdapter(args.adapterId);
  if (!entry) throw new Error(`Adapter ${args.adapterId} not found in registry.`);
  if (entry.status !== "completed") {
    throw new Error(`Adapter ${args.adapterId} is in status ${entry.status}, not 'completed'. Cannot promote.`);
  }
  const target = `training-v${entry.manifestVersion}`;
  const collections = await listCollections2();
  const now = Math.floor(Date.now() / 1e3);
  let promoted = 0;
  let rolledBackSelections = 0;
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION4);
      for (const d of docs) {
        if (d.metadata.selected_for !== target) continue;
        if (d.metadata.verification_last_result === "passed") {
          await patchDocument(c.name, d.id, { promoted_to: target, promoted_at: now });
          promoted++;
        } else {
          const updated = { ...d.metadata };
          delete updated.selected_for;
          delete updated.selected_at;
          await patchDocument(c.name, d.id, metadataDelta(d.metadata, updated));
          rolledBackSelections++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-promote] Error in ${c.name}: ${e}
`);
    }
  }
  updateAdapter(args.adapterId, { status: "promoted", promoted: true });
  return {
    adapterId: args.adapterId,
    manifestVersion: entry.manifestVersion,
    promoted,
    rolledBackSelections,
    outputModelRef: entry.outputModelRef
  };
}
async function adapterDemote(adapterId) {
  const entry = getAdapter(adapterId);
  if (!entry) throw new Error(`Adapter ${adapterId} not found in registry.`);
  const target = `training-v${entry.manifestVersion}`;
  const collections = await listCollections2();
  let rolledBack = 0;
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION4);
      for (const d of docs) {
        if (d.metadata.promoted_to === target) {
          const updated = { ...d.metadata };
          delete updated.promoted_to;
          delete updated.promoted_at;
          await patchDocument(c.name, d.id, metadataDelta(d.metadata, updated));
          rolledBack++;
        }
      }
    } catch (e) {
      process.stderr.write(`[yapa-demote] Error in ${c.name}: ${e}
`);
    }
  }
  updateAdapter(adapterId, { status: "demoted", promoted: false });
  return { adapterId, rolledBack };
}
var MAX_PER_COLLECTION4;
var init_promotion = __esm({
  "packages/core/src/training/promotion.ts"() {
    "use strict";
    init_store();
    init_registry();
    MAX_PER_COLLECTION4 = 2e3;
  }
});

// packages/core/src/training/verification.ts
async function findDocByManifestId(manifestId) {
  const collections = await listCollections2();
  for (const c of collections) {
    try {
      const docs = await getDocumentsByFilter2(c.name, { type: "memory" }, MAX_PER_COLLECTION5);
      const match = docs.find((d) => d.id === manifestId);
      if (match) return { collection: c.name, metadata: match.metadata };
    } catch {
      continue;
    }
  }
  return null;
}
async function verifyAdapterAgainstManifest(adapterRef, manifestVersion, options = {}) {
  if (!getConfig().VERIFICATION_ENABLED && !options.bypassEnabledGate) {
    throw new Error(
      "YAPA_VERIFICATION_ENABLED is false. Verification requires inference calls that may incur cost. Set the env var to true to opt in."
    );
  }
  const inference = options.inferenceCall ?? defaultInferenceCaller;
  const manifestPath = artifactPath("training-manifests", `v${manifestVersion}.jsonl`);
  const memories = readManifestSource(manifestPath);
  const items = [];
  for (const mem of memories) {
    const item = {
      memoryId: mem.id,
      collection: null,
      passed: false,
      confidence: 0,
      rationale: "",
      userPrompt: "",
      candidateAnswer: ""
    };
    try {
      const syn = await synthesizeMemory(mem);
      const example = syn.examples[0];
      if (!example) {
        item.rationale = "synthesis returned no examples";
        items.push(item);
        continue;
      }
      const userTurn = example.messages.find((m) => m.role === "user");
      if (!userTurn) {
        item.rationale = "synthesis example had no user turn";
        items.push(item);
        continue;
      }
      item.userPrompt = userTurn.content;
      item.candidateAnswer = await inference({
        model: adapterRef,
        messages: example.messages.filter((m) => m.role !== "assistant"),
        temperature: 0,
        max_tokens: 1024
      });
      const judgment = await judgeVerification(
        mem.content,
        item.candidateAnswer,
        item.userPrompt,
        { call: options.judgeCall }
      );
      item.passed = judgment.passed;
      item.confidence = judgment.confidence;
      item.rationale = judgment.rationale;
    } catch (e) {
      item.rationale = `error: ${e}`;
    }
    const found = await findDocByManifestId(mem.id);
    if (found) {
      item.collection = found.collection;
      const attempts = Number(found.metadata.verification_attempts ?? 0) + 1;
      const updated = {
        ...found.metadata,
        verification_attempts: attempts,
        verification_last_result: item.passed ? "passed" : "failed"
      };
      try {
        await patchDocument(found.collection, mem.id, metadataDelta(found.metadata, updated));
      } catch (e) {
        process.stderr.write(`[yapa-verify] Metadata update failed for ${mem.id}: ${e}
`);
      }
    }
    items.push(item);
  }
  const passedCount = items.filter((i) => i.passed).length;
  const failedCount = items.length - passedCount;
  return { adapterRef, manifestVersion, passedCount, failedCount, items };
}
var MAX_PER_COLLECTION5;
var init_verification = __esm({
  "packages/core/src/training/verification.ts"() {
    "use strict";
    init_config();
    init_artifacts();
    init_store();
    init_inference();
    init_judge();
    init_synthesis();
    MAX_PER_COLLECTION5 = 2e3;
  }
});

// packages/core/src/memory/external.ts
async function findExternal(collection, ref) {
  const docs = await getDocumentsByFilter2(collection, { type: "memory", external_ref: ref }, 50).catch(() => []);
  return docs.find((d) => d.metadata.archived !== true) ?? null;
}
async function putExternal(requested, ref, put) {
  if (!ref.trim()) throw new Error("external_ref is required");
  const { collection } = await resolveWriteCollection(requested);
  const typed = normalizeTyped({ ...put.typed, external_ref: ref });
  await getOrCreateCollection2(collection);
  return withDocLock(collection, `external_ref:${ref}`, () => putLocked(collection, ref, put, typed));
}
async function putLocked(collection, ref, put, typed) {
  const existing = await findExternal(collection, ref);
  if (!existing) {
    const r = await storeMemory(put.content, { collection, tags: put.tags, typed });
    return { id: r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, "") : r.ids[0], action: "created" };
  }
  const id = existing.metadata.parent_id ?? existing.id;
  const cur = carryTyped(existing.metadata);
  const typedChanged = Object.keys(typed).some((k) => !same(typed[k], cur[k]));
  const tagsChanged = put.tags !== void 0 && !same(put.tags, existing.metadata.tags);
  const contentChanged = existing.metadata.parent_id ? !put.content.startsWith(existing.content) : put.content !== existing.content;
  if (contentChanged && !existing.metadata.parent_id && chunkText(put.content).length === 1) {
    await updateMemory(id, { ...typed, content: put.content, ...tagsChanged ? { tags: put.tags } : {} }, collection);
    return { id, action: "updated" };
  }
  if (contentChanged) {
    const r = await storeMemory(put.content, { collection, tags: put.tags ?? existing.metadata.tags, typed: { ...cur, ...typed }, supersedes: id });
    return { id: r.ids.length > 1 ? String(r.ids[0]).replace(/-0$/, "") : r.ids[0], action: "updated" };
  }
  if (!typedChanged && !tagsChanged) return { id, action: "unchanged" };
  await updateMemory(id, { ...typed, ...tagsChanged ? { tags: put.tags } : {} }, collection);
  return { id, action: "updated" };
}
var same;
var init_external = __esm({
  "packages/core/src/memory/external.ts"() {
    "use strict";
    init_doc_lock();
    init_store();
    init_kinds();
    init_store2();
    init_chunking();
    init_update2();
    init_sentinel();
    same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
});

// packages/core/src/last-write.ts
import { mkdirSync as mkdirSync11, readdirSync as readdirSync5, readFileSync as readFileSync17, renameSync as renameSync6, rmSync as rmSync5, statSync as statSync2, writeFileSync as writeFileSync9 } from "node:fs";
import { dirname as dirname9, join as join14 } from "node:path";
function lastWriteDir() {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join14(dirname9(health), "last-write") : "";
}
function lastWriteFile(session, dir = lastWriteDir()) {
  return join14(dir, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function recordLastWrite(collection, opts = {}) {
  const session = currentSession(opts.session ?? process.env.CLAUDE_CODE_SESSION_ID);
  const dir = opts.dir ?? lastWriteDir();
  if (!collection || !session || !dir) return;
  const now = opts.now ?? Date.now();
  try {
    mkdirSync11(dir, { recursive: true, mode: 448 });
    const file = lastWriteFile(session, dir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync9(tmp, JSON.stringify({ collection, at: now }) + "\n", { mode: 384 });
    renameSync6(tmp, file);
    if (!pruned) {
      pruned = true;
      pruneLastWrites(dir, now);
    }
  } catch {
  }
}
function readLastWrite(session, dir = lastWriteDir()) {
  if (!dir) return void 0;
  try {
    const r = JSON.parse(readFileSync17(lastWriteFile(session, dir), "utf-8"));
    return r && typeof r.collection === "string" && typeof r.at === "number" ? r : void 0;
  } catch {
    return void 0;
  }
}
function pruneLastWrites(dir = lastWriteDir(), now = Date.now()) {
  if (!dir) return;
  try {
    for (const name of readdirSync5(dir)) {
      const p = join14(dir, name);
      try {
        if (now - statSync2(p).mtimeMs > PRUNE_AFTER_MS) rmSync5(p, { force: true });
      } catch {
      }
    }
  } catch {
  }
}
var PRUNE_AFTER_MS, pruned;
var init_last_write = __esm({
  "packages/core/src/last-write.ts"() {
    "use strict";
    init_config();
    init_coordination();
    PRUNE_AFTER_MS = 7 * 24 * 3600 * 1e3;
    pruned = false;
  }
});

// packages/core/src/session-record.ts
import { readdirSync as readdirSync6, readFileSync as readFileSync18, rmSync as rmSync6, statSync as statSync3 } from "node:fs";
import { dirname as dirname10, join as join15 } from "node:path";
function sessionRecordDir() {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join15(dirname10(health), "sessions") : "";
}
function sessionRecordFile(session, dir = sessionRecordDir()) {
  return join15(dir, `${session.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function sessionId(explicit) {
  const v = explicit ?? process.env.CLAUDE_CODE_SESSION_ID;
  return v && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : void 0;
}
function recordSessionStart(version, opts = {}) {
  const session = sessionId(opts.session);
  const dir = opts.dir ?? sessionRecordDir();
  if (!session || !dir) return void 0;
  const file = sessionRecordFile(session, dir);
  try {
    writeJsonAtomic(file, { version, pid: process.pid, started_at: opts.now ?? Date.now() });
    pruneSessionRecords(dir, opts.now ?? Date.now());
    return file;
  } catch {
    return void 0;
  }
}
function noteSessionStarting(session, opts = {}) {
  const id = sessionId(session);
  const dir = opts.dir ?? sessionRecordDir();
  if (!id || !dir) return;
  try {
    writeJsonAtomic(sessionRecordFile(id, dir).replace(/\.json$/, ".starting"), { at: opts.now ?? Date.now() });
  } catch {
  }
}
function recordSessionScope(session, collection, opts = {}) {
  const id = sessionId(session);
  const dir = opts.dir ?? sessionRecordDir();
  if (!id || !dir || !collection) return;
  const file = sessionRecordFile(id, dir).replace(/\.json$/, ".scope");
  try {
    if (JSON.parse(readFileSync18(file, "utf-8"))?.collection === collection) return;
  } catch {
  }
  try {
    writeJsonAtomic(file, { collection, at: opts.now ?? Date.now() });
  } catch {
  }
}
function removeSessionRecord(opts = {}) {
  const session = sessionId(opts.session);
  const dir = opts.dir ?? sessionRecordDir();
  if (!session || !dir) return;
  const file = sessionRecordFile(session, dir);
  try {
    const r = JSON.parse(readFileSync18(file, "utf-8"));
    if (r.pid === process.pid) rmSync6(file, { force: true });
  } catch {
  }
}
function pruneSessionRecords(dir = sessionRecordDir(), now = Date.now()) {
  if (!dir) return;
  try {
    for (const name of readdirSync6(dir)) {
      const p = join15(dir, name);
      if (name.endsWith(".starting") || name.endsWith(".scope")) {
        try {
          if (now - statSync3(p).mtimeMs > (name.endsWith(".scope") ? PRUNE_AFTER_MS2 : 24 * 3600 * 1e3)) rmSync6(p, { force: true });
        } catch {
        }
        continue;
      }
      if (!name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync18(p, "utf-8"));
        if (!pidAlive(r.pid) || now - statSync3(p).mtimeMs > PRUNE_AFTER_MS2) rmSync6(p, { force: true });
      } catch {
        rmSync6(p, { force: true });
      }
    }
  } catch {
  }
}
var PRUNE_AFTER_MS2;
var init_session_record = __esm({
  "packages/core/src/session-record.ts"() {
    "use strict";
    init_config();
    init_fs_lock();
    PRUNE_AFTER_MS2 = 7 * 24 * 3600 * 1e3;
  }
});

// packages/core/src/index.ts
var src_exports = {};
__export(src_exports, {
  AGGREGATE_JUDGE_SYSTEM_PROMPT: () => AGGREGATE_JUDGE_SYSTEM_PROMPT,
  CHUNK_OVERLAP: () => CHUNK_OVERLAP,
  CHUNK_SIZE: () => CHUNK_SIZE,
  CLASSIFIER_PROMPT_VERSION: () => CLASSIFIER_PROMPT_VERSION,
  CLASSIFIER_SYSTEM_PROMPT: () => CLASSIFIER_SYSTEM_PROMPT,
  ClaimBusyError: () => ClaimBusyError,
  CollectionDeleteRefusedError: () => CollectionDeleteRefusedError,
  CollectionLeftError: () => CollectionLeftError,
  CoordinationUnavailableError: () => CoordinationUnavailableError,
  DECAY_INTERVAL_MS: () => DECAY_INTERVAL_MS,
  DEFAULT_STATUS: () => DEFAULT_STATUS,
  DISPOSITIONS: () => DISPOSITIONS,
  EXTRACTOR_PROMPT_VERSION: () => EXTRACTOR_PROMPT_VERSION,
  EXTRACTOR_SYSTEM_PROMPT: () => EXTRACTOR_SYSTEM_PROMPT,
  FOLLOW_THROUGH_MAX_DISTANCE: () => FOLLOW_THROUGH_MAX_DISTANCE,
  FOLLOW_THROUGH_PROMPT_VERSION: () => FOLLOW_THROUGH_PROMPT_VERSION,
  FOLLOW_THROUGH_SYSTEM_PROMPT: () => FOLLOW_THROUGH_SYSTEM_PROMPT,
  FireworksBackend: () => FireworksBackend,
  HEARTBEAT_MAX_INTERVAL_S: () => HEARTBEAT_MAX_INTERVAL_S,
  HOOK_CHILD_ENV: () => HOOK_CHILD_ENV,
  HttpBackend: () => HttpBackend,
  IdTokenProvider: () => IdTokenProvider,
  KIND_STATUSES: () => KIND_STATUSES,
  LocalCoordinationError: () => LocalCoordinationError,
  LockTimeoutError: () => LockTimeoutError,
  MAX_EXTRACT_CHARS: () => MAX_EXTRACT_CHARS,
  MEMORY_KINDS: () => MEMORY_KINDS,
  MemoryNotFoundError: () => MemoryNotFoundError,
  OPEN_STATUSES: () => OPEN_STATUSES,
  PostgresBackend: () => PostgresBackend,
  REFERENCE_DATA_RULES: () => REFERENCE_DATA_RULES,
  RESOLVER_PROMPT_VERSION: () => RESOLVER_PROMPT_VERSION,
  RESOLVER_SYSTEM_PROMPT: () => RESOLVER_SYSTEM_PROMPT,
  SALIENCE_BOOST_ON_ACCESS: () => SALIENCE_BOOST_ON_ACCESS,
  SALIENCE_FLOOR: () => SALIENCE_FLOOR,
  SALIENCE_MAX: () => SALIENCE_MAX,
  SALIENCE_START: () => SALIENCE_START,
  SESSION_ID: () => SESSION_ID,
  SYNTHESIS_PROMPT_VERSION: () => SYNTHESIS_PROMPT_VERSION,
  SYNTHESIS_SYSTEM_PROMPT: () => SYNTHESIS_SYSTEM_PROMPT,
  ServiceError: () => ServiceError,
  TASK_COUNTER_COLLECTION: () => TASK_COUNTER_COLLECTION,
  TYPED_KEYS: () => TYPED_KEYS,
  TaskClaimedError: () => TaskClaimedError,
  TypedMemoryError: () => TypedMemoryError,
  UPDATE_CHECK_INTERVAL_MS: () => UPDATE_CHECK_INTERVAL_MS,
  UnsupportedByRemoteError: () => UnsupportedByRemoteError,
  VERIFY_JUDGE_SYSTEM_PROMPT: () => VERIFY_JUDGE_SYSTEM_PROMPT,
  adapterDemote: () => adapterDemote,
  adapterPromote: () => adapterPromote,
  addAdapter: () => addAdapter,
  addClaimNotice: () => addClaimNotice,
  addCollectionRedirect: () => addCollectionRedirect,
  addDependency: () => addDependency,
  addDocument: () => addDocument2,
  addDocumentsBatch: () => addDocumentsBatch2,
  addLeftCollection: () => addLeftCollection,
  addLocalTombstone: () => addLocalTombstone,
  addLocalTombstones: () => addLocalTombstones,
  addPendingBackfill: () => addPendingBackfill,
  applyCaptureEvent: () => applyCaptureEvent,
  applyCompaction: () => applyCompaction,
  applyDecay: () => applyDecay,
  applyServerUsername: () => applyServerUsername,
  artifactDir: () => artifactDir,
  artifactPath: () => artifactPath,
  assertWritable: () => assertWritable,
  bucketRouteNow: () => bucketRouteNow,
  bucketRoutePreview: () => bucketRoutePreview,
  bucketStatus: () => bucketStatus,
  buildClassifierUserPrompt: () => buildClassifierUserPrompt,
  buildClaudeCliArgs: () => buildClaudeCliArgs,
  buildExtractorUserPrompt: () => buildExtractorUserPrompt,
  buildFollowThroughPrompt: () => buildFollowThroughPrompt,
  buildResolverUserPrompt: () => buildResolverUserPrompt,
  callCurationLLM: () => callCurationLLM,
  captureDownLine: () => captureDownLine,
  captureFailing: () => captureFailing,
  captureHealthFile: () => captureHealthFile,
  captureNudge: () => captureNudge,
  captureTurn: () => captureTurn,
  carryTyped: () => carryTyped,
  checkForUpdate: () => checkForUpdate,
  chromaStore: () => chromaStore,
  chunk: () => chunk,
  chunkText: () => chunkText,
  claimKey: () => claimKey,
  claimNote: () => claimNote,
  claimSession: () => claimSession,
  claimTask: () => claimTask,
  claimsApply: () => claimsApply,
  claimsFor: () => claimsFor,
  classifyMemories: () => classifyMemories,
  clearCollectionRedirect: () => clearCollectionRedirect,
  clearEmbeddingMemo: () => clearEmbeddingMemo,
  clearLeftCollection: () => clearLeftCollection,
  clearPendingBackfill: () => clearPendingBackfill,
  clearPendingDeletes: () => clearPendingDeletes,
  clearPendingPurges: () => clearPendingPurges,
  clearSelectedForManifest: () => clearSelectedForManifest,
  closeSyncBackend: () => closeSyncBackend,
  collectClassifiedMemories: () => collectClassifiedMemories,
  collectionSize: () => collectionSize,
  compareVersions: () => compareVersions,
  completeTask: () => completeTask,
  consolidateSessionEverywhere: () => consolidateSessionEverywhere,
  consolidateStaleDrafts: () => consolidateStaleDrafts,
  coordinatedLocally: () => coordinatedLocally,
  countUnpushed: () => countUnpushed,
  createCollection: () => createCollection2,
  createConfig: () => createConfig,
  createLocalCoordination: () => createLocalCoordination,
  createLocalStore: () => createLocalStore,
  createNewCollection: () => createNewCollection,
  createTask: () => createTask,
  curationCycle: () => curationCycle,
  currentSession: () => currentSession,
  dayKey: () => dayKey,
  dayRuns: () => dayRuns,
  decayFactor: () => decayFactor,
  defaultInferenceCaller: () => defaultInferenceCaller,
  deleteCollection: () => deleteCollection2,
  deleteDocument: () => deleteDocument2,
  deleteDocumentEverywhere: () => deleteDocumentEverywhere,
  deleteTask: () => deleteTask,
  describeClaim: () => describeClaim,
  describeDataRules: () => describeDataRules,
  describeHolder: () => describeHolder,
  describeRefusal: () => describeRefusal,
  describeWaits: () => describeWaits,
  detectChromaVersion: () => detectChromaVersion,
  detectCollection: () => detectCollection,
  detectSector: () => detectSector,
  emptyPullStats: () => emptyPullStats,
  emptyPushStats: () => emptyPushStats,
  ensureArtifactDir: () => ensureArtifactDir,
  evalCompare: () => evalCompare,
  evalRun: () => evalRun,
  extractMemories: () => extractMemories,
  fenceWaiting: () => fenceWaiting,
  findAndDeleteDocument: () => findAndDeleteDocument2,
  findConflicts: () => findConflicts,
  findDuplicatePairs: () => findDuplicatePairs,
  findExternal: () => findExternal,
  findOpenItems: () => findOpenItems,
  flushPendingSync: () => flushPendingSync,
  followThrough: () => followThrough,
  forgetMemory: () => forgetMemory,
  formatDuration: () => formatDuration,
  formatSyncStats: () => formatSyncStats,
  formatTaskDate: () => formatTaskDate,
  formatTrainingJsonl: () => formatTrainingJsonl,
  formatWaiting: () => formatWaiting,
  fromChroma: () => fromChroma,
  generateEmbedding: () => generateEmbedding,
  generateEmbeddingsBatch: () => generateEmbeddingsBatch,
  getAdapter: () => getAdapter,
  getCollectionCount: () => getCollectionCount2,
  getCollectionRedirects: () => getCollectionRedirects,
  getConfig: () => getConfig,
  getCurationModel: () => getCurationModel,
  getCurationState: () => getCurationState,
  getDeviceId: () => getDeviceId,
  getDocumentsByFilter: () => getDocumentsByFilter2,
  getDocumentsByIds: () => getDocumentsByIds2,
  getDueTasks: () => getDueTasks,
  getEmbeddingModel: () => getEmbeddingModel,
  getLeftCollections: () => getLeftCollections,
  getLocalTombstones: () => getLocalTombstones,
  getNextTaskId: () => getNextTaskId,
  getOrCreateCollection: () => getOrCreateCollection2,
  getPendingBackfills: () => getPendingBackfills,
  getPendingDeletes: () => getPendingDeletes,
  getPendingPurges: () => getPendingPurges,
  getRegistryPath: () => getRegistryPath,
  getStore: () => getStore,
  getSyncBackend: () => getSyncBackend,
  getSyncPullTimestamp: () => getSyncPullTimestamp,
  getSyncState: () => getSyncState,
  getSyncSubscriptions: () => getSyncSubscriptions,
  getSynthesisModel: () => getSynthesisModel,
  getTask: () => getTask,
  getUnfollowedCollections: () => getUnfollowedCollections,
  hasPendingSync: () => hasPendingSync,
  healthStatusFor: () => healthStatusFor,
  heartbeatIfDue: () => heartbeatIfDue,
  heldKeys: () => heldKeys,
  isCoordinationUnavailable: () => isCoordinationUnavailable,
  isCycleFatal: () => isCycleFatal,
  isDetectionStale: () => isDetectionStale,
  isMemoryKind: () => isMemoryKind,
  isOpenTyped: () => isOpenTyped,
  isPushable: () => isPushable,
  isReadOnlyDoc: () => isReadOnlyDoc,
  isRejectedUnchanged: () => isRejectedUnchanged,
  isSignedOutError: () => isSignedOutError,
  isSyncConfigured: () => isSyncConfigured,
  isSyncableCollection: () => isSyncableCollection,
  janitorSweep: () => janitorSweep,
  journalAppend: () => journalAppend,
  journalConsolidate: () => journalConsolidate,
  judgeAggregate: () => judgeAggregate,
  judgeVerification: () => judgeVerification,
  keepDeletedUpstream: () => keepDeletedUpstream,
  lastSyncError: () => lastSyncError,
  lastWriteDir: () => lastWriteDir,
  lastWriteFile: () => lastWriteFile,
  linkMemoryToTasks: () => linkMemoryToTasks,
  listAdapters: () => listAdapters,
  listCollections: () => listCollections2,
  listCollectionsWithCounts: () => listCollectionsWithCounts,
  listDeletedUpstream: () => listDeletedUpstream,
  listMemories: () => listMemories,
  listRejectedDocs: () => listRejectedDocs,
  listSessionDrafts: () => listSessionDrafts,
  listTasks: () => listTasks,
  listTrash: () => listTrash,
  listVersions: () => listVersions,
  loadManifestSplit: () => loadManifestSplit,
  localCoordination: () => localCoordination,
  lockFileFor: () => lockFileFor,
  looksPrivateButShared: () => looksPrivateButShared,
  markDecayRun: () => markDecayRun,
  markUpdateNotified: () => markUpdateNotified,
  matchCollectionMap: () => matchCollectionMap,
  mergeCollections: () => mergeCollections,
  mergeReportLines: () => mergeReportLines,
  metadataDelta: () => metadataDelta,
  nextTasks: () => nextTasks,
  nextVersion: () => nextVersion,
  normalizeCollectionMap: () => normalizeCollectionMap,
  normalizeTyped: () => normalizeTyped,
  normalizedSalience: () => normalizedSalience,
  noteInstalledVersion: () => noteInstalledVersion,
  noteLeaseHeld: () => noteLeaseHeld,
  noteLeaseReleased: () => noteLeaseReleased,
  noteSessionStarting: () => noteSessionStarting,
  noteSyncError: () => noteSyncError,
  noteSyncOk: () => noteSyncOk,
  openWaits: () => openWaits,
  parseAggregateJudge: () => parseAggregateJudge,
  parseClassifierResponse: () => parseClassifierResponse,
  parseDataRules: () => parseDataRules,
  parseDuration: () => parseDuration,
  parseExtractorResponse: () => parseExtractorResponse,
  parseFollowThrough: () => parseFollowThrough,
  parseRelativeDate: () => parseRelativeDate,
  parseResolverResponse: () => parseResolverResponse,
  parseSynthesisResponse: () => parseSynthesisResponse,
  parseVerifyJudge: () => parseVerifyJudge,
  passesPromotedFilter: () => passesPromotedFilter,
  passesScoreFilters: () => passesScoreFilters,
  patchDocument: () => patchDocument,
  patchDocuments: () => patchDocuments2,
  pidAlive: () => pidAlive,
  pruneLastWrites: () => pruneLastWrites,
  pruneSessionRecords: () => pruneSessionRecords,
  pullCollection: () => pullCollection,
  pullFromRemote: () => pullFromRemote,
  purgeDocuments: () => purgeDocuments,
  pushDocsNow: () => pushDocsNow,
  pushNow: () => pushNow,
  pushToRemote: () => pushToRemote,
  putExternal: () => putExternal,
  queryAllCollections: () => queryAllCollections2,
  queryDocuments: () => queryDocuments2,
  queueSyncDelete: () => queueSyncDelete,
  queueSyncDeletes: () => queueSyncDeletes,
  queueSyncPurges: () => queueSyncPurges,
  rankScore: () => rankScore,
  readArtifact: () => readArtifact,
  readCaptureHealth: () => readCaptureHealth,
  readCycleRecord: () => readCycleRecord,
  readHoldoutFile: () => readHoldoutFile,
  readLastWrite: () => readLastWrite,
  readManifestSource: () => readManifestSource,
  readSyncHealth: () => readSyncHealth,
  readUpdateState: () => readUpdateState,
  recallMemory: () => recallMemory,
  recordCapture: () => recordCapture,
  recordCycle: () => recordCycle,
  recordForTask: () => recordForTask,
  recordLastWrite: () => recordLastWrite,
  recordPull: () => recordPull,
  recordSessionScope: () => recordSessionScope,
  recordSessionStart: () => recordSessionStart,
  recordSyncHealth: () => recordSyncHealth,
  recordUnpushed: () => recordUnpushed,
  redirectNote: () => redirectNote,
  refreshSyncHealthNames: () => refreshSyncHealthNames,
  rejoinCollection: () => rejoinCollection,
  rekeyTask: () => rekeyTask,
  releaseTaskClaim: () => releaseTaskClaim,
  remoteDataRules: () => remoteDataRules,
  removeCollection: () => removeCollection,
  removeDependency: () => removeDependency,
  removeReport: () => removeReport,
  removeSessionRecord: () => removeSessionRecord,
  requestDecision: () => requestDecision,
  requireCoordination: () => requireCoordination,
  requireSyncBackend: () => requireSyncBackend,
  resetConfig: () => resetConfig,
  resetDeviceId: () => resetDeviceId,
  resetLocalCoordination: () => resetLocalCoordination,
  resetStore: () => resetStore,
  resolveCollectionRedirect: () => resolveCollectionRedirect,
  resolveConflict: () => resolveConflict,
  resolveSyncUsername: () => resolveSyncUsername,
  resolveWriteCollection: () => resolveWriteCollection,
  restoreDeleted: () => restoreDeleted,
  retryUnsharedClaims: () => retryUnsharedClaims,
  routeMemory: () => routeMemory,
  runDecaySweep: () => runDecaySweep,
  scheduleSyncSoon: () => scheduleSyncSoon,
  scopeNotes: () => scopeNotes,
  searchTasks: () => searchTasks,
  serviceCoordination: () => serviceCoordination,
  sessionRecordDir: () => sessionRecordDir,
  sessionRecordFile: () => sessionRecordFile,
  sessionsHoldingLeases: () => sessionsHoldingLeases,
  setConfig: () => setConfig,
  setHostLLMCaller: () => setHostLLMCaller,
  setStore: () => setStore,
  setSyncBackend: () => setSyncBackend,
  settleRecallBoosts: () => settleRecallBoosts,
  sha256: () => sha256,
  shouldPull: () => shouldPull,
  shouldRunCycle: () => shouldRunCycle,
  shouldRunDecay: () => shouldRunDecay,
  splitCollectionMap: () => splitCollectionMap,
  splitManifest: () => splitManifest,
  startCuration: () => startCuration,
  startSync: () => startSync,
  startUpdateChecks: () => startUpdateChecks,
  stillQueuedForPurge: () => stillQueuedForPurge,
  stopCuration: () => stopCuration,
  stopSync: () => stopSync,
  stopUpdateChecks: () => stopUpdateChecks,
  storeMemory: () => storeMemory,
  suggestCompaction: () => suggestCompaction,
  summarizeCapture: () => summarizeCapture,
  sweepDeletedUpstream: () => sweepDeletedUpstream,
  sweepLockDebris: () => sweepLockDebris,
  syncBackendKind: () => syncBackendKind,
  syncCycle: () => syncCycle,
  syncFingerprint: () => syncFingerprint,
  syncTargetKey: () => syncTargetKey,
  syncTick: () => syncTick,
  syncTransportKind: () => syncTransportKind,
  syncUsernameNote: () => syncUsernameNote,
  synthesizeMemory: () => synthesizeMemory,
  systemPromptActivate: () => systemPromptActivate,
  systemPromptDeactivate: () => systemPromptDeactivate,
  systemPromptThresholds: () => systemPromptThresholds,
  takeClaimNotices: () => takeClaimNotices,
  taskNeedsPeople: () => taskNeedsPeople,
  toChroma: () => toChroma,
  touchDocument: () => touchDocument,
  trainingCancel: () => trainingCancel,
  trainingDatasetPreview: () => trainingDatasetPreview,
  trainingGet: () => trainingGet,
  trainingStatus: () => trainingStatus,
  trainingThresholds: () => trainingThresholds,
  trainingTrigger: () => trainingTrigger,
  tryAcquireCycle: () => tryAcquireCycle,
  typedLabel: () => typedLabel,
  updateAdapter: () => updateAdapter,
  updateDocument: () => updateDocument2,
  updateDocumentsBatch: () => updateDocumentsBatch2,
  updateMemory: () => updateMemory,
  updateStatePath: () => updateStatePath,
  updateSyncPullTimestamp: () => updateSyncPullTimestamp,
  updateSyncSubscriptions: () => updateSyncSubscriptions,
  updateTask: () => updateTask,
  validateLearned: () => validateLearned,
  verifyAdapterAgainstManifest: () => verifyAdapterAgainstManifest,
  waitingCount: () => waitingCount,
  waitingLine: () => waitingLine,
  waitingOn: () => waitingOn,
  waitsOnPeople: () => waitsOnPeople,
  withDocLock: () => withDocLock,
  withFileLock: () => withFileLock,
  withFileLockSync: () => withFileLockSync,
  writeArtifact: () => writeArtifact,
  writeJsonAtomic: () => writeJsonAtomic,
  writeSystemPromptCompanion: () => writeSystemPromptCompanion,
  writeTrainingManifest: () => writeTrainingManifest
});
var init_src = __esm({
  "packages/core/src/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_chroma();
    init_embeddings();
    init_chunking();
    init_lifecycle();
    init_scope();
    init_metadata_adapter();
    init_store2();
    init_recall();
    init_forget();
    init_list();
    init_decay();
    init_compact();
    init_journal();
    init_filters();
    init_create();
    init_list2();
    init_update();
    init_claim();
    init_next();
    init_search();
    init_delete();
    init_dependencies();
    init_dates();
    init_manage();
    init_curation();
    init_classifier();
    init_extractor();
    init_resolver();
    init_janitor();
    init_capture();
    init_provider();
    init_prompts();
    init_buckets();
    init_artifacts();
    init_router();
    init_system_prompt();
    init_training_manifest();
    init_sync();
    init_backend();
    init_coordination();
    init_local_coordination();
    init_fs_lock();
    init_shared_cycle();
    init_http_backend();
    init_postgres_backend();
    init_pull();
    init_syncable();
    init_push();
    init_deletes();
    init_sentinel();
    init_health();
    init_device();
    init_training();
    init_backend2();
    init_eval();
    init_fireworks();
    init_holdout();
    init_inference();
    init_judge();
    init_promotion();
    init_registry();
    init_synthesis();
    init_verification();
    init_kinds();
    init_update2();
    init_external();
    init_links();
    init_waiting();
    init_close();
    init_follow_through();
    init_health2();
    init_update_check();
    init_last_write();
    init_doc_lock();
    init_session_record();
    init_trash();
  }
});

// packages/mcp/src/rules.ts
var CLAUDE_CODE_RULES;
var init_rules = __esm({
  "packages/mcp/src/rules.ts"() {
    "use strict";
    CLAUDE_CODE_RULES = `## YAPA \u2014 Memory & Task Assistant (standing rules)

You have YAPA's persistent memory and durable task tools (the yapa MCP server: \`memory_*\`, \`task_*\`, \`journal_*\`, \`collection_*\`, \`compaction_*\`, \`sync\`). Hooks already do the routine work: this block plus open tasks and top memories are injected at session start, and a semantic recall for each prompt is injected as \`# YAPA Recall\` (after pulling teammates' latest writes for the active collection). Do not repeat that recall unless you need a different or more specific query.

### Scope
The injected \`**Scope:**\` line names the active collection (\`customer-{name}\`, \`project-{name}\`, or \`global\`). If it is flagged AMBIGUOUS, ask the user which collection to use BEFORE storing anything. Always pass the collection explicitly when storing. Recall searches the active collection plus a few strongly relevant hits from other customers/projects (labeled \`from <collection>\`): when troubleshooting, check whether another account already hit the same issue, and say where an answer came from. Before creating a new collection, confirm the name with the user (\`collection_list\` shows what exists). \`private-*\`, \`local-*\` and \`global\` collections never sync (\`global\` is personal; team-wide knowledge goes in a shared collection). To combine or rename collections use \`collection_merge\` (it keeps every document), not \`collection_delete\`. \`collection_delete\` removes a collection from this machine only; pass \`scope: "everyone"\` (with \`confirm\`) only when the user explicitly asks to delete it for the whole team.

### Capture as you go (do not batch to the end)
Call \`memory_store\` (salience >= 2.0) when: a bug's root cause is identified; a config value, env var, endpoint, or credential location is learned; the user states a preference, decision, or correction; a non-obvious technical fact is discovered; a solution took real effort; a decision or commitment surfaces.
\`memory_store\` returns \`potential_conflicts\`: decide supersede (re-store with \`supersedes: "<old id>"\`) or coexist before moving on. Reserve \`memory_forget\` for memories that should never have existed (forgetting a teammate's memory only removes it for you).
Do not store ephemeral conversation state, obvious code patterns, or anything already in git history or an existing memory.

### Where what you learn goes
Give a memory a \`kind\` when it is one of these, so it can be listed and waited on:
- a result, root cause, retraction or methodology trap: \`kind: finding\` (status open; resolve it later with a \`disposition\`: decision, task, limitation, or no-action with a reason)
- a choice that was made: \`kind: decision\`, status \`accepted\`
- a choice only a person can make: \`kind: decision\`, status \`needed\`, with \`options\`, a \`recommendation\` and the \`owner\` who decides. Never leave such a choice only in chat. When it is for the task you are on, use \`task_update\` with \`decision_needed\` instead: it records the decision and the task waits on it.
- something that can't be done yet: \`kind: limitation\`, with \`exit_criteria\`
- a question for a person or another team: \`kind: question\`, with the \`owner\` who must answer
- an idea nobody has committed to: \`kind: idea\`
- follow-up work: a task
A project's own instructions win where they keep these records elsewhere. Record a person's answer with \`memory_update\` (a decision: status accepted or rejected, the choice as \`note\`; a question: status answered). Session start lists what waits on you under "Waiting on you"; \`waiting\` lists everything: tell the user about items that are theirs.

### Tasks
Call \`task_create\` in the active collection BEFORE starting multi-step or long-lived work, when a follow-up is identified, or when something can't finish this turn. On completion \`task_complete\` (pass \`duration\` for hands-on effort when known), and record what the task produced in the same call: \`learned\` (typed memories, linked to the task) and \`follow_ups\` (new tasks). If the reply says nothing was recorded, consider whether something should have been. On a blocker \`task_update\` with status \`blocked\` and a reason; when the blocker is a person's choice, \`decision_needed\` instead (then take other work: the task comes back once the decision is recorded). On scope change amend the task instead of duplicating it. Tags \`auto\` (an unattended session may do all of it), \`needs-human\` (a step only a person takes) and \`needs:<user>\` (one person must take it) triage a task; \`task_next\` never offers a \`needs-human\` task and, with \`auto_only\`, only offers \`auto\` ones. Items marked "by <user>" were written by a teammate (for their tasks, coordinate before changing them); "from <collection>" marks a hit from another customer or project.

### Journal
Call \`journal_append\` with a one-line note when a meaningful step completes. Drafts are consolidated into a \`journal\` memory automatically when the session ends.

### Task claims
Setting a task to \`in_progress\` claims it for this session (a lease on its id: on the sync service in a shared collection, on this machine in a local-only one such as \`private-*\`), so teammates and your other sessions don't start the same work; leaving \`in_progress\` (complete, blocked, pending, delete) releases it. Set \`in_progress\` when you actually start a task. If the update is refused, nothing changed: tell the user who holds it and since when, and offer other work. If it names your own other session, pass \`reclaim: true\` only after the user confirms that session is finished or theirs to take over. If the reply says the claim is NOT shared (offline, signed out), tell the user others may start it too. Task lines show "claimed by <who>"; before starting a task claimed by someone else, tell the user. A "**YAPA claim:**" line in the context means a claim was taken over or clashed: pass it on to the user.

### Shared work (leases)
For other shared resources, some projects coordinate through bare YAPA leases (the \`lease\` tool, or a project script calling \`yapa coord\`). Take one only when the project's own instructions or tooling call for it, never on your own initiative. Session start lists live leases in the active collection under "Work in progress": before starting something listed there, tell the user who holds it. If an acquire is refused, say who holds the work and since when, and offer something else; don't retry in a loop. If you took over an expired lease, say whose it was. If the service is unreachable, say the work is not shared. Heartbeats are automatic while this session is active; don't schedule them.

### Memory compaction
When the injected context lists a "compaction candidate", call \`compaction_suggest\` for it, write a rolling summary per group, and submit with \`compaction_apply\`.

### Storage errors
If a yapa tool fails with a storage or sync error, do not swallow it: tell the user, and use \`sync\` (action \`status\`) to diagnose remote problems.
`;
  }
});

// packages/mcp/src/cli/statusline.ts
var statusline_exports = {};
__export(statusline_exports, {
  REMOVED_MARKER: () => REMOVED_MARKER,
  SCRIPT_VERSION: () => SCRIPT_VERSION,
  SESSION_REPORT_GRACE_MS: () => SESSION_REPORT_GRACE_MS,
  captureFailingAt: () => captureFailingAt,
  copyScript: () => copyScript,
  decodeWrapped: () => decodeWrapped,
  defaultSettingsPath: () => defaultSettingsPath,
  encodeWrapped: () => encodeWrapped,
  formatAgo: () => formatAgo,
  formatSince: () => formatSince,
  hasStatusLine: () => hasStatusLine,
  installStatusLine: () => installStatusLine,
  isLocalOnly: () => isLocalOnly,
  isYapaStatusLine: () => isYapaStatusLine,
  main: () => main,
  mergeStatusLine: () => mergeStatusLine,
  newer: () => newer,
  readHealth: () => readHealth,
  readLastWrite: () => readLastWrite2,
  readSessionRecord: () => readSessionRecord,
  readSessionScope: () => readSessionScope,
  readSessionStarting: () => readSessionStarting,
  readUpdate: () => readUpdate,
  removeStatusLine: () => removeStatusLine,
  renderSegment: () => renderSegment,
  sessionInfo: () => sessionInfo,
  setRemovedMarker: () => setRemovedMarker,
  stdinInfo: () => stdinInfo,
  stdinSession: () => stdinSession,
  uninstallStatusLine: () => uninstallStatusLine
});
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync as mkdirSync12, readFileSync as readFileSync19, realpathSync as realpathSync2, renameSync as renameSync7, rmSync as rmSync7, statSync as statSync4, writeFileSync as writeFileSync10 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname11, join as join16, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function newer(a, b) {
  const pa = SEMVER2.exec(String(a ?? "").trim());
  const pb = SEMVER2.exec(String(b ?? "").trim());
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0;
  }
  if (pa[4] && !pb[4]) return false;
  if (!pa[4] && pb[4]) return true;
  return (pa[4] ?? "") > (pb[4] ?? "");
}
function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function formatSince(at, now) {
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(now).toDateString()) return hhmm;
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hhmm}`;
}
function cleanLabel(label) {
  if (typeof label !== "string") return void 0;
  const v = label.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 32);
  return v || void 0;
}
function remoteName(health, explicit) {
  const legacy = cleanLabel(health?.label);
  return cleanLabel(explicit) ?? cleanLabel(health?.remote) ?? (legacy && legacy !== "yapa" ? legacy : void 0);
}
function renderSegment(health, now, opts = {}) {
  const paint = (tone, text) => opts.color ? `${ANSI[tone]}${text}${ANSI.reset}` : text;
  const installed = opts.version ?? SCRIPT_VERSION ?? opts.update?.current;
  const running2 = opts.session?.version ?? installed;
  const restart = installed && (opts.session?.missing || opts.session?.version && newer(installed, opts.session.version)) ? installed : void 0;
  const latest = opts.update?.latest && installed && newer(opts.update.latest, installed) ? opts.update.latest : void 0;
  const remote = remoteName(health, opts.remote ?? opts.label);
  const shown = opts.session?.missing ? "yapa" : `yapa${running2 ? `@v${running2}` : ""}`;
  const head = shown + (restart ? ` ${paint("yellow", `(restart for v${restart})`)}` : "") + (latest ? ` ${paint("yellow", `(v${latest} available)`)}` : "") + (remote ? ` <-> ${remote}` : "");
  const push = health?.unpushed ? ` \xB7 ${health.unpushed} to push` : "";
  const since = health?.since ? ` since ${formatSince(health.since, now)}` : "";
  const name = cleanCollection(opts.collection);
  const tail = name ? `${name}${isLocalOnly(name) ? " (local only)" : ""}` : void 0;
  const capture = opts.captureFailing ? ` ${paint("red", "\xB7 capture \u2717")}` : "";
  const state = (tone, text) => `${head} ${paint(tone, text)}${capture}${tail ? ` | ${tail}` : ""}`;
  if (!health) return state("dim", "\u25CB sync status unknown");
  switch (health.status) {
    case "disabled":
      return state("dim", "\u25CB local only");
    case "signed_out":
      return state("red", `\u25CF signed out${since}${push} \xB7 ${cleanLabel(health.sign_in) ?? "run: gcloud auth login"}`);
    case "unreachable":
      return state("yellow", `\u25CF offline${since}${push}`);
    case "error": {
      const why = health.message ? `: ${health.message.replace(/\s+/g, " ").slice(0, 60)}` : "";
      return state("yellow", `\u25CF sync error${since}${why}`);
    }
    case "ok": {
      const interval = health.interval_ms && health.interval_ms > 0 ? health.interval_ms : DEFAULT_INTERVAL_MS;
      if (now - health.at > STALE_INTERVALS * interval) {
        return state("dim", `\u25CB sync status unknown (last checked ${formatAgo(now - health.at)})`);
      }
      return state("green", `\u25CF synced ${formatAgo(now - (health.last_ok_at ?? health.at))}${push}`);
    }
    default:
      return state("dim", "\u25CB sync status unknown");
  }
}
function isLocalOnly(name) {
  return name === "global" || name.startsWith("private-") || name.startsWith("local-");
}
function cleanCollection(name) {
  if (typeof name !== "string") return void 0;
  const v = name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64);
  return v || void 0;
}
function readLastWrite2(dir, sessions) {
  let best;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync19(join16(dir, `${s.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf-8"));
      if (r && typeof r.collection === "string" && typeof r.at === "number" && (!best || r.at > best.at)) best = r;
    } catch {
    }
  }
  return best;
}
function stdinSession(input2) {
  return stdinInfo(input2).session;
}
function stdinInfo(input2, now = Date.now()) {
  let j;
  try {
    j = JSON.parse(input2);
  } catch {
    return {};
  }
  const session = typeof j?.session_id === "string" ? j.session_id : void 0;
  let ageMs = typeof j?.cost?.total_duration_ms === "number" ? j.cost.total_duration_ms : void 0;
  if (ageMs === void 0 && typeof j?.transcript_path === "string") {
    try {
      const born = statSync4(j.transcript_path).birthtimeMs;
      if (born > 0) ageMs = now - born;
    } catch {
    }
  }
  return { session, ageMs };
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function readSessionRecord(dir, sessions) {
  let best;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync19(join16(dir, `${s.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf-8"));
      if (r && typeof r.version === "string" && typeof r.pid === "number" && alive(r.pid) && (!best || r.started_at > best.started_at)) best = r;
    } catch {
    }
  }
  return best;
}
function readSessionScope(dir, sessions) {
  let best;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const r = JSON.parse(readFileSync19(join16(dir, `${s.replace(/[^A-Za-z0-9._-]/g, "_")}.scope`), "utf-8"));
      if (typeof r?.collection === "string" && typeof r.at === "number" && (!best || r.at > best.at)) best = r;
    } catch {
    }
  }
  return best?.collection;
}
function readSessionStarting(dir, sessions) {
  let best;
  for (const s of new Set(sessions)) {
    if (!s || !/^[A-Za-z0-9._:-]{1,128}$/.test(s)) continue;
    try {
      const at = JSON.parse(readFileSync19(join16(dir, `${s.replace(/[^A-Za-z0-9._-]/g, "_")}.starting`), "utf-8"))?.at;
      if (typeof at === "number" && (best === void 0 || at > best)) best = at;
    } catch {
    }
  }
  return best;
}
function sessionInfo(record, ageMs, startedAt, now = Date.now()) {
  if (record) return { version: record.version };
  const sinceStart = startedAt !== void 0 ? now - startedAt : ageMs;
  if (sinceStart !== void 0 && sinceStart > SESSION_REPORT_GRACE_MS) return { missing: true };
  return void 0;
}
function readUpdate(path3) {
  try {
    const u = JSON.parse(readFileSync19(path3, "utf-8"));
    return u && typeof u === "object" ? { current: typeof u.current === "string" ? u.current : void 0, latest: typeof u.latest === "string" ? u.latest : void 0 } : void 0;
  } catch {
    return void 0;
  }
}
function captureFailingAt(path3, now) {
  let h;
  try {
    h = JSON.parse(readFileSync19(path3, "utf-8"));
  } catch {
    return false;
  }
  if (!h || typeof h.at !== "number" || !h.days) return false;
  const err = h.last_error;
  if (err && typeof err.at === "number" && err.stage !== "follow-through" && err.at >= (h.last_ok_at ?? 0) && now - err.at < 36e5) return true;
  const d = h.days[localDay(now)];
  if (!d) return false;
  const n = (k) => Number(d[k] ?? 0);
  const clean = d.clean === void 0 ? n("turns") - n("follow_through_failed") : n("clean");
  const bad2 = n("failed") + (n("turns") - clean) + n("compactions_failed");
  const good = clean + n("compactions") - n("compactions_failed");
  return bad2 >= 2 && bad2 > good;
}
function readHealth(path3) {
  try {
    const h = JSON.parse(readFileSync19(path3, "utf-8"));
    return h && typeof h.status === "string" && typeof h.at === "number" ? h : void 0;
  } catch {
    return void 0;
  }
}
function encodeWrapped(statusLine) {
  return Buffer.from(JSON.stringify(statusLine)).toString("base64url");
}
function decodeWrapped(b64) {
  try {
    const v = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8"));
    return v && typeof v === "object" ? v : void 0;
  } catch {
    return void 0;
  }
}
function isYapaStatusLine(statusLine, script) {
  if (typeof statusLine?.command !== "string") return false;
  return /yapa[\\/]statusline\.mjs/.test(statusLine.command) || !!script && statusLine.command.includes(`"${script}"`);
}
function wrappedOf(statusLine) {
  const m = typeof statusLine?.command === "string" ? statusLine.command.match(/--wrap\s+([A-Za-z0-9_-]+)/) : null;
  return m ? decodeWrapped(m[1]) : void 0;
}
function mergeStatusLine(settings, script, refreshInterval = 30) {
  const next = structuredClone(settings ?? {});
  const current = next.statusLine;
  const wrapped = isYapaStatusLine(current, script) ? wrappedOf(current) : current && typeof current === "object" ? current : void 0;
  let command = `node "${script}"`;
  if (wrapped) command += ` --wrap ${encodeWrapped(wrapped)}`;
  next.statusLine = {
    ...wrapped ?? {},
    type: "command",
    command,
    refreshInterval: Math.min(Number(wrapped?.refreshInterval) || refreshInterval, refreshInterval)
  };
  return next;
}
function removeStatusLine(settings, script) {
  const next = structuredClone(settings ?? {});
  if (!isYapaStatusLine(next.statusLine, script)) return next;
  const wrapped = wrappedOf(next.statusLine);
  if (wrapped) next.statusLine = wrapped;
  else delete next.statusLine;
  return next;
}
function defaultSettingsPath() {
  return join16(process.env.CLAUDE_CONFIG_DIR ?? join16(homedir3(), ".claude"), "settings.json");
}
function readSettings(path3) {
  try {
    return JSON.parse(readFileSync19(path3, "utf-8"));
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Refusing to edit ${path3}: ${e?.message ?? e}`);
  }
}
function writeSettings(path3, settings) {
  mkdirSync12(dirname11(path3), { recursive: true });
  const tmp = `${path3}.${process.pid}.tmp`;
  writeFileSync10(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync7(tmp, path3);
}
function installStatusLine(script, path3 = defaultSettingsPath()) {
  writeSettings(path3, mergeStatusLine(readSettings(path3), script));
  return path3;
}
function uninstallStatusLine(path3 = defaultSettingsPath(), script) {
  writeSettings(path3, removeStatusLine(readSettings(path3), script));
  return path3;
}
function hasStatusLine(path3 = defaultSettingsPath(), script) {
  try {
    return isYapaStatusLine(JSON.parse(readFileSync19(path3, "utf-8")).statusLine, script);
  } catch {
    return false;
  }
}
function copyScript(from, to) {
  let src;
  try {
    src = readFileSync19(from);
  } catch {
    return false;
  }
  try {
    if (readFileSync19(to).equals(src)) return false;
  } catch {
  }
  mkdirSync12(dirname11(to), { recursive: true, mode: 448 });
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  renameSync7(tmp, to);
  return true;
}
function setRemovedMarker(dir, removed) {
  const p = join16(dir, REMOVED_MARKER);
  try {
    if (removed) {
      mkdirSync12(dir, { recursive: true, mode: 448 });
      writeFileSync10(p, `${(/* @__PURE__ */ new Date()).toISOString()}
`);
    } else {
      rmSync7(p, { force: true });
    }
  } catch {
  }
}
function argValue(args, flag4) {
  const i = args.indexOf(flag4);
  return i >= 0 ? args[i + 1] : void 0;
}
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk2 of process.stdin) chunks.push(chunk2);
  return Buffer.concat(chunks).toString("utf-8");
}
async function main(args, self2) {
  const settings = argValue(args, "--settings");
  if (args.includes("--install")) {
    process.stdout.write(`Status line added to ${installStatusLine(self2, settings)}
`);
    setRemovedMarker(dirname11(self2), false);
    return;
  }
  if (args.includes("--uninstall")) {
    process.stdout.write(`Status line removed from ${uninstallStatusLine(settings, self2)}
`);
    setRemovedMarker(dirname11(self2), true);
    return;
  }
  const input2 = await readStdin();
  const wrapped = argValue(args, "--wrap");
  const previous = wrapped ? decodeWrapped(wrapped) : void 0;
  if (typeof previous?.command === "string") {
    const r = spawnSync(previous.command, { shell: true, input: input2, encoding: "utf-8", timeout: WRAP_TIMEOUT_MS });
    const out = (r.stdout ?? "").replace(/\s+$/, "");
    if (r.status === 0 && out) process.stdout.write(out + "\n");
  }
  const healthPath = process.env.YAPA_SYNC_HEALTH_FILE || join16(dirname11(self2), "sync-health.json");
  const update = readUpdate(join16(dirname11(healthPath), "update-check.json"));
  const info = stdinInfo(input2);
  const ids = [info.session, process.env.CLAUDE_CODE_SESSION_ID];
  const last = readLastWrite2(join16(dirname11(healthPath), "last-write"), ids);
  const sessionsDir = join16(dirname11(healthPath), "sessions");
  const session = sessionInfo(readSessionRecord(sessionsDir, ids), info.ageMs, readSessionStarting(sessionsDir, ids));
  const collection = last?.collection ?? readSessionScope(sessionsDir, ids);
  const color = !process.env.NO_COLOR;
  process.stdout.write(renderSegment(readHealth(healthPath), Date.now(), {
    color,
    remote: argValue(args, "--remote") ?? argValue(args, "--label"),
    update,
    collection,
    session,
    captureFailing: captureFailingAt(join16(dirname11(healthPath), "capture-health.json"), Date.now())
  }) + "\n");
}
function isMain(argv1, self2) {
  if (!argv1 || !/statusline\.m?js$/.test(self2)) return false;
  try {
    return realpathSync2(resolve(argv1)) === realpathSync2(self2);
  } catch {
    return false;
  }
}
var SCRIPT_VERSION, SEMVER2, DEFAULT_INTERVAL_MS, STALE_INTERVALS, WRAP_TIMEOUT_MS, ANSI, SESSION_REPORT_GRACE_MS, localDay, REMOVED_MARKER, self;
var init_statusline = __esm({
  "packages/mcp/src/cli/statusline.ts"() {
    "use strict";
    SCRIPT_VERSION = true ? "1.13.0" : void 0;
    SEMVER2 = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
    DEFAULT_INTERVAL_MS = 3e5;
    STALE_INTERVALS = 3;
    WRAP_TIMEOUT_MS = 5e3;
    ANSI = { green: "\x1B[32m", red: "\x1B[31m", yellow: "\x1B[33m", dim: "\x1B[2m", reset: "\x1B[0m" };
    SESSION_REPORT_GRACE_MS = 6e4;
    localDay = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    REMOVED_MARKER = "statusline-removed";
    self = fileURLToPath(import.meta.url);
    if (isMain(process.argv[1], self)) {
      main(process.argv.slice(2), self).catch(() => process.stdout.write(`yapa${SCRIPT_VERSION ? `@v${SCRIPT_VERSION}` : ""} \u25CB sync status unknown
`));
    }
  }
});

// packages/mcp/src/version.ts
var version_exports = {};
__export(version_exports, {
  YAPA_VERSION: () => YAPA_VERSION
});
var YAPA_VERSION;
var init_version = __esm({
  "packages/mcp/src/version.ts"() {
    "use strict";
    YAPA_VERSION = true ? "1.13.0" : fromPackage();
  }
});

// packages/mcp/src/cli/hooks.ts
var hooks_exports = {};
__export(hooks_exports, {
  attribution: () => attribution,
  bundledStatusLineScript: () => bundledStatusLineScript,
  freshenFromRemote: () => freshenFromRemote,
  postCompact: () => postCompact,
  prepareStatusLine: () => prepareStatusLine,
  presenceLines: () => presenceLines,
  reloadConfig: () => reloadConfig,
  sessionEnd: () => sessionEnd,
  sessionStart: () => sessionStart,
  statusLineScriptPath: () => statusLineScriptPath,
  stop: () => stop,
  syncDownLine: () => syncDownLine,
  updateLine: () => updateLine,
  userPromptSubmit: () => userPromptSubmit,
  userText: () => userText,
  waitingLines: () => waitingLines
});
import { existsSync as existsSync4, mkdirSync as mkdirSync13, readFileSync as readFileSync20, rmSync as rmSync8, writeFileSync as writeFileSync11 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname12, join as join17 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}
function context(event, lines) {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } });
}
function scopeLine(d) {
  if (!d.ambiguous) return `**Scope:** \`${d.collection}\`${scopeNotes(d)}`;
  return `**Scope:** AMBIGUOUS \u2014 both \`${d.ambiguous[0]}\` and \`${d.ambiguous[1]}\` exist for this folder. Ask the user which collection to use BEFORE storing anything. (Reads here default to \`${d.collection}\`.)`;
}
function attribution(metadata) {
  const who2 = metadata?.origin_user;
  return who2 && who2 !== getConfig().USERNAME ? `, by ${who2}` : "";
}
function withTimeout(work, ms) {
  return Promise.race([work, new Promise((resolve3) => setTimeout(() => resolve3(void 0), ms).unref())]);
}
async function freshenFromRemote(collection, opts = {}) {
  const config = getConfig();
  if (!isSyncConfigured(config)) return 0;
  if (!isSyncableCollection(collection)) return 0;
  try {
    if ((await getUnfollowedCollections()).has(collection)) return 0;
    const pendingBackfill = (await getPendingBackfills()).includes(collection);
    const followed = (await getSyncSubscriptions()).includes(collection) && !pendingBackfill;
    if (opts.gate && followed && !shouldPull(collection)) return 0;
    const since = followed ? Math.max(0, await getSyncPullTimestamp() - HOOK_PULL_OVERLAP_SECONDS) : 0;
    const stats = await withTimeout(resolveSyncUsername().then(() => pullCollection(collection, since)), config.HOOK_PULL_TIMEOUT_MS);
    if (!stats) {
      process.stderr.write(`[yapa-hook] remote pull for ${collection} timed out
`);
      return 0;
    }
    if (stats.errors === 0) {
      noteSyncOk();
      recordPull(collection);
      if (pendingBackfill) await clearPendingBackfill(collection);
    }
    if (!followed && stats.errors === 0) {
      const subs = await getSyncSubscriptions();
      if (!subs.includes(collection)) await updateSyncSubscriptions([...subs, collection]);
    }
    return stats.pulled + stats.updated;
  } catch (e) {
    process.stderr.write(`[yapa-hook] remote pull for ${collection} failed: ${e}
`);
    return 0;
  }
}
function syncDownLine(health = readSyncHealth()) {
  if (!health || !isSyncConfigured(getConfig())) return void 0;
  const since = health.since ? ` since ${new Date(health.since).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  switch (health.status) {
    case "signed_out":
      return `_YAPA sync is signed out${since}: writes stay on this machine until the user ${health.sign_in ? `signs in again (${health.sign_in})` : "runs `gcloud auth login`"} (sync resumes by itself, no restart)._`;
    case "unreachable":
      return `_YAPA sync service is unreachable${since}: writes stay on this machine and push when it is back._`;
    case "error":
      return `_YAPA sync is failing${since}${health.message ? ` (${health.message.slice(0, 160)})` : ""}: writes stay on this machine for now._`;
    default:
      return void 0;
  }
}
function statusLineScriptPath() {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join17(dirname12(health), "statusline.mjs") : void 0;
}
function bundledStatusLineScript() {
  const here = dirname12(fileURLToPath2(import.meta.url));
  return ["statusline.mjs", "statusline.js"].map((f) => join17(here, f)).find((p) => existsSync4(p));
}
function prepareStatusLine(from = bundledStatusLineScript(), settingsPath = defaultSettingsPath()) {
  const to = statusLineScriptPath();
  if (!to) return void 0;
  try {
    if (from) copyScript(from, to);
  } catch (e) {
    process.stderr.write(`[yapa-hook] status line script copy failed: ${e}
`);
  }
  refreshSyncHealthNames(isSyncConfigured(getConfig()));
  if (hasStatusLine(settingsPath, to)) return void 0;
  if (getConfig().STATUSLINE) {
    const added = join17(dirname12(to), "statusline-added");
    if (existsSync4(join17(dirname12(to), REMOVED_MARKER)) || existsSync4(added) || !existsSync4(to)) return void 0;
    try {
      installStatusLine(to, settingsPath);
      try {
        writeFileSync11(added, `${(/* @__PURE__ */ new Date()).toISOString()}
`);
      } catch {
      }
      return `_YAPA added its status line (version, remote, sync health) under the prompt in ${settingsPath}; mention it once. To remove it: \`node "${to}" --uninstall\`._`;
    } catch (e) {
      process.stderr.write(`[yapa-hook] status line install failed: ${e}
`);
      return void 0;
    }
  }
  if (!isSyncConfigured(getConfig())) return void 0;
  const marker = join17(dirname12(to), "statusline-hint");
  if (existsSync4(marker)) return void 0;
  try {
    writeFileSync11(marker, `${(/* @__PURE__ */ new Date()).toISOString()}
`);
  } catch {
    return void 0;
  }
  const how = process.env.CLAUDE_PLUGIN_ROOT ? "`/yapa:statusline`" : `\`node "${to}" --install\``;
  return `_Mention once to the user: they can show YAPA sync health under the prompt with ${how}._`;
}
function updateLine() {
  const state = noteInstalledVersion(YAPA_VERSION);
  if (!state?.latest || state.notified === state.latest) return void 0;
  markUpdateNotified(state.latest);
  const how = process.env.CLAUDE_PLUGIN_ROOT ? "`claude plugin marketplace update yapa && claude plugin update yapa@yapa`, then restart Claude Code" : "`git pull && npm install && npm run build` in the YAPA checkout, then restart Claude Code";
  return `_YAPA ${state.latest} is out (running ${YAPA_VERSION}). Tell the user once; to update: ${how}._`;
}
function stateDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join17(tmpdir2(), `yapa-hooks-${process.getuid?.() ?? "user"}`);
  const dir = join17(base, "sessions");
  mkdirSync13(dir, { recursive: true });
  return dir;
}
function stateFile2(sessionId2, kind) {
  return join17(stateDir(), `${sessionId2.replace(/[^A-Za-z0-9_-]/g, "_")}.${kind}`);
}
function readTurn(sessionId2) {
  try {
    return JSON.parse(readFileSync20(stateFile2(sessionId2, "turn"), "utf-8"));
  } catch {
    return void 0;
  }
}
function recordPrompt(sessionId2, prompt) {
  if (!sessionId2) return;
  try {
    const turn = (readTurn(sessionId2)?.turn ?? 0) + 1;
    writeFileSync11(stateFile2(sessionId2, "turn"), JSON.stringify({ prompt, turn }));
  } catch (e) {
    process.stderr.write(`[yapa-hook] could not buffer prompt: ${e}
`);
  }
}
function takeNotice(sessionId2) {
  if (!sessionId2) return void 0;
  const file = stateFile2(sessionId2, "notice");
  try {
    const notice = readFileSync20(file, "utf-8").trim();
    rmSync8(file, { force: true });
    return notice || void 0;
  } catch {
    return void 0;
  }
}
function leaseSessions(input2) {
  return [input2.session_id, currentSession()];
}
async function keepLeasesAlive(input2) {
  try {
    await withTimeout(heartbeatIfDue(leaseSessions(input2)), HEARTBEAT_BUDGET_MS);
  } catch (e) {
    process.stderr.write(`[yapa-hook] lease heartbeat failed (non-fatal): ${e}
`);
  }
}
function presenceLines(leases, now, mySessions, me) {
  if (!leases.length) return [];
  const mine = new Set(mySessions.filter(Boolean));
  const out = ["", "## Work in progress (leases)"];
  for (const l of leases.slice(0, 10)) {
    const who2 = l.holder.user === me ? mine.has(l.holder.session) ? "you (this session)" : `you (another session, ${l.holder.session})` : l.holder.user;
    const title = l.title ? ` ${l.title}` : "";
    out.push(`- **${l.key}**${title}: ${who2}, for ${relTime(Math.max(0, now - l.acquired_at))}, expires in ${relTime(Math.max(0, l.expires_at - now))}`);
  }
  if (leases.length > 10) out.push(`- _\u2026${leases.length - 10} more (\`lease\` action \`list\`)_`);
  return out;
}
async function presence(collection, input2) {
  try {
    const r = await withTimeout((async () => (await requireCoordination()).leaseList(collection))(), LEASE_LIST_BUDGET_MS);
    if (!r) return { lines: [] };
    const live = r.leases.filter((l) => !l.expired);
    return { lines: presenceLines(r.leases, r.now, leaseSessions(input2), getConfig().USERNAME), claims: new Map(live.map((l) => [l.key, l])) };
  } catch {
    return { lines: [] };
  }
}
function claimNoticeLines() {
  return takeClaimNotices().map((n) => `**YAPA claim:** ${n}`);
}
async function findCompactionCandidates() {
  const cols = await listCollections2().catch(() => []);
  const out = [];
  for (const c of cols) {
    const size = await collectionSize(c.name).catch(() => 0);
    if (size >= getConfig().COMPACTION_THRESHOLD) out.push(`${c.name} (${size})`);
  }
  return out;
}
async function waitingLines(user, budgetMs = 2e3, collection = "global") {
  try {
    const all = await Promise.race([
      waitingOn({ user }),
      new Promise((res) => setTimeout(() => res(void 0), budgetMs).unref())
    ]);
    if (!all) return [];
    const { waiting: w, hidden } = fenceWaiting(all, collection);
    const items = [...w.decisions, ...w.questions, ...w.actions, ...w.blocked];
    const mine = items.filter((i) => i.for.includes(user));
    const anyone = items.filter((i) => i.for.length === 0).length;
    if (!mine.length && !anyone && !hidden) return [];
    const out = ["", "## Waiting on you"];
    for (const i of mine.slice(0, 8)) out.push(waitingLine(i, { collection: true }));
    if (mine.length > 8) out.push(`- _\u2026${mine.length - 8} more (call \`waiting\`)_`);
    if (anyone) out.push(`- _${anyone} item(s) wait on anyone with the role (call \`waiting\`)_`);
    if (hidden) out.push(`- _${hidden} more in private collections, not listed in this shared scope (call \`waiting\` to see them)_`);
    out.push("Tell the user about these when relevant; record a choice with `memory_update` (status accepted), never only in chat.");
    return out;
  } catch (e) {
    process.stderr.write(`[yapa-hook] waiting failed: ${e}
`);
    return [];
  }
}
async function sessionStart(input2) {
  noteSessionStarting(input2.session_id);
  const detection = await detectCollection(input2.cwd);
  const collection = detection.collection;
  recordSessionScope(input2.session_id, collection);
  const pulled = await freshenFromRemote(collection);
  const lines = [];
  if (getConfig().HOOK_INJECT_RULES) lines.push(CLAUDE_CODE_RULES, "");
  lines.push("# YAPA Context", "", scopeLine(detection));
  if (pulled) lines.push(`_Pulled ${pulled} new or updated item(s) from the team sync._`);
  const down = syncDownLine();
  if (down) lines.push(down);
  const captureDown = captureDownLine();
  if (captureDown) lines.push(captureDown);
  const hint = prepareStatusLine();
  if (hint) lines.push(hint);
  const update = updateLine();
  if (update) lines.push(update);
  const notice = takeNotice(input2.session_id);
  if (notice) lines.push(`_${notice}_`);
  const [held2] = await Promise.all([presence(collection, input2), keepLeasesAlive(input2)]);
  lines.push(...claimNoticeLines());
  try {
    const tasks = await listTasks({ collection, includeComplete: false });
    if (tasks.length) {
      lines.push("", "## Open tasks");
      for (const t of tasks.slice(0, 10)) {
        const status = t.metadata.status ?? "open";
        const prio = t.metadata.priority ? `, ${t.metadata.priority}` : "";
        const claim = claimNote(t, held2.claims, leaseSessions(input2));
        lines.push(`- **${t.id}** [${status}${prio}${attribution(t.metadata)}${claim ? `; ${claim}` : ""}] ${t.title}`);
      }
      if (tasks.length > 10) lines.push(`- _\u2026${tasks.length - 10} more (call \`task_list\` for the full list)_`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] task_list failed: ${e}
`);
  }
  lines.push(...await waitingLines(getConfig().USERNAME, void 0, collection));
  lines.push(...held2.lines);
  try {
    const memories = await listMemories({ collection, limit: 5 });
    if (memories.length) {
      lines.push("", "## Top memories (by salience)");
      for (const r of memories) {
        const sal = r.metadata.salience?.toFixed(2) ?? "?";
        const snippet = r.content.length > 200 ? r.content.slice(0, 200) + "\u2026" : r.content;
        lines.push(`- **${r.id}** (salience ${sal}${attribution(r.metadata)}): ${snippet}`);
      }
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] memory list failed: ${e}
`);
  }
  try {
    const candidates = await findCompactionCandidates();
    if (candidates.length) {
      lines.push("", "## Compaction candidates");
      lines.push("These collections are above the size threshold. Consider calling `compaction_suggest` then `compaction_apply`:");
      for (const c of candidates) lines.push(`- ${c}`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] compaction check failed: ${e}
`);
  }
  if (input2.source !== "compact") {
    await withTimeout(consolidateStaleDrafts().catch(() => []), STALE_JOURNAL_BUDGET_MS);
  }
  lines.push(
    "",
    "_Hooks ran recall + task_list automatically. You do not need to repeat these unless you need a more specific query._"
  );
  context("SessionStart", lines);
}
function userText(prompt) {
  if (!prompt.includes("<task-notification") && !prompt.includes("[SYSTEM NOTIFICATION")) return prompt.trim();
  return prompt.replace(/<task-notification>[\s\S]*?(<\/task-notification>|$)/g, "").replace(/\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?(\n\s*\n|$)/g, "").replace(/<system-reminder>\s*<\/system-reminder>/g, "").trim();
}
async function userPromptSubmit(input2) {
  const raw = (input2.prompt ?? "").trim();
  const prompt = userText(raw);
  if (!prompt) {
    emit({});
    if (raw) await keepLeasesAlive(input2);
    return;
  }
  const detection = await detectCollection(input2.cwd);
  const collection = detection.collection;
  recordSessionScope(input2.session_id, collection);
  recordPrompt(input2.session_id, prompt);
  await Promise.all([freshenFromRemote(collection, { gate: true }), keepLeasesAlive(input2)]);
  const lines = ["# YAPA Recall", "", `${scopeLine(detection)}  **Query:** ${prompt.slice(0, 120)}${prompt.length > 120 ? "\u2026" : ""}`];
  const notice = takeNotice(input2.session_id);
  if (notice) lines.push(`_${notice}_`);
  const down = syncDownLine();
  if (down) lines.push(down);
  const claimNotices = claimNoticeLines();
  lines.push(...claimNotices);
  try {
    const recall = await recallMemory(prompt, { collection, nResults: 3, crossCollection: getConfig().CROSS_COLLECTION_RESULTS });
    if (recall.length === 0 && !notice && !down && !claimNotices.length) {
      emit({});
      return;
    }
    if (recall.length) lines.push("", "## Top matches");
    for (const r of recall) {
      const sal = r.metadata.salience?.toFixed(2) ?? "?";
      const dist = r.distance.toFixed(3);
      const snippet = r.content.length > 240 ? r.content.slice(0, 240) + "\u2026" : r.content;
      const where = r.collection && r.collection !== collection ? `, from \`${r.collection}\`` : "";
      lines.push(`- **${r.id}** (salience ${sal}, distance ${dist}${where}${attribution(r.metadata)}): ${snippet}`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] memory_recall failed: ${e}
`);
    emit({});
    return;
  }
  context("UserPromptSubmit", lines);
}
async function stop(input2) {
  emit({});
  await keepLeasesAlive(input2);
  const config = getConfig();
  if (!config.RESPONSE_CAPTURE || input2.stop_hook_active || !input2.session_id) return;
  const assistantText = (input2.last_assistant_message ?? "").trim();
  const turn = readTurn(input2.session_id);
  const userText2 = turn?.prompt ?? "";
  if (!assistantText || userText2.length + assistantText.length < config.CAPTURE_MIN_CHARS) return;
  if (config.CURATION_LLM_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY) {
    setConfig({ ...config, CURATION_LLM_PROVIDER: "claude-cli", CURATION_MODEL: config.CURATION_MODEL || "haiku" });
  }
  try {
    const { collection } = await detectCollection(input2.cwd);
    const result = await captureTurn(
      { collection, sessionId: input2.session_id, turn: turn?.turn ?? 0, userText: userText2, assistantText },
      {
        maxMemories: config.CAPTURE_MAX_MEMORIES,
        maxSalience: config.CAPTURE_MAX_SALIENCE,
        dedupeDistance: config.CAPTURE_DEDUPE_DISTANCE,
        // Typed captures belong to the task this session is on.
        taskIds: heldKeys(currentSession(input2.session_id) ?? input2.session_id, collection).filter((k) => !k.startsWith("cleanup:"))
      }
    );
    if (result.notice) writeFileSync11(stateFile2(input2.session_id, "notice"), result.notice);
  } catch (e) {
    process.stderr.write(`[yapa-hook] response capture failed (non-fatal): ${e}
`);
  }
}
async function postCompact(input2) {
  emit({});
  const summary = (input2.compact_summary ?? "").trim();
  if (!getConfig().CAPTURE_COMPACTION || !summary) return;
  try {
    const { collection } = await detectCollection(input2.cwd);
    await storeMemory(`# Conversation compaction summary

${summary}`, {
      collection,
      tags: ["compaction", "journal"],
      salience: 1.5,
      sector: "episodic",
      metadata: { source: "compaction", session_id: input2.session_id, trigger: input2.trigger }
    });
    recordCapture({ kind: "compaction" });
  } catch (e) {
    recordCapture({ kind: "compaction", error: e });
    process.stderr.write(`[yapa-hook] compaction capture failed (non-fatal): ${e}
`);
  }
}
async function sessionEnd(input2) {
  emit({});
  if (!input2.session_id) return;
  for (const kind of ["turn", "notice"]) {
    try {
      rmSync8(stateFile2(input2.session_id, kind), { force: true });
    } catch {
    }
  }
}
function reloadConfig() {
  setConfig(createConfig(process.env));
}
var HOOK_PULL_OVERLAP_SECONDS, STALE_JOURNAL_BUDGET_MS, LEASE_LIST_BUDGET_MS, HEARTBEAT_BUDGET_MS, relTime;
var init_hooks = __esm({
  "packages/mcp/src/cli/hooks.ts"() {
    "use strict";
    init_src();
    init_rules();
    init_statusline();
    init_version();
    HOOK_PULL_OVERLAP_SECONDS = 600;
    STALE_JOURNAL_BUDGET_MS = 2e3;
    LEASE_LIST_BUDGET_MS = 1500;
    HEARTBEAT_BUDGET_MS = 1500;
    relTime = (secs) => secs < 120 ? `${secs}s` : secs < 7200 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
  }
});

// packages/mcp/src/cli/install-hooks.ts
var install_hooks_exports = {};
__export(install_hooks_exports, {
  HOOK_EVENTS: () => HOOK_EVENTS,
  defaultSettingsPath: () => defaultSettingsPath2,
  installHooks: () => installHooks,
  mergeHooks: () => mergeHooks,
  removeHooks: () => removeHooks,
  selfCommand: () => selfCommand,
  uninstallHooks: () => uninstallHooks
});
import { mkdirSync as mkdirSync14, readFileSync as readFileSync21, writeFileSync as writeFileSync12 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname13, join as join18 } from "node:path";
function isYapaHook(h) {
  return typeof h?.command === "string" && /\bhook\s+[a-z-]+$/.test(h.command) && h.command.includes(MARKER);
}
function mergeHooks(settings, command) {
  const next = removeHooks(settings);
  next.hooks ??= {};
  for (const { event, sub, async, timeout } of HOOK_EVENTS) {
    const hook = { type: "command", command: `${command} hook ${sub}` };
    if (async) hook.async = true;
    if (timeout) hook.timeout = timeout;
    next.hooks[event] = [...next.hooks[event] ?? [], { hooks: [hook] }];
  }
  return next;
}
function removeHooks(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks) return next;
  for (const [event, groups] of Object.entries(next.hooks)) {
    const kept = (groups ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isYapaHook(h)) })).filter((g) => g.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}
function defaultSettingsPath2() {
  return join18(process.env.CLAUDE_CONFIG_DIR ?? join18(homedir4(), ".claude"), "settings.json");
}
function selfCommand() {
  return `node ${process.argv[1]}`;
}
function readSettings2(path3) {
  try {
    return JSON.parse(readFileSync21(path3, "utf-8"));
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Refusing to edit ${path3}: ${e?.message ?? e}`);
  }
}
function installHooks(path3 = defaultSettingsPath2(), command = selfCommand()) {
  const merged = mergeHooks(readSettings2(path3), command);
  mkdirSync14(dirname13(path3), { recursive: true });
  writeFileSync12(path3, JSON.stringify(merged, null, 2) + "\n");
  return path3;
}
function uninstallHooks(path3 = defaultSettingsPath2()) {
  writeFileSync12(path3, JSON.stringify(removeHooks(readSettings2(path3)), null, 2) + "\n");
  return path3;
}
var HOOK_EVENTS, MARKER;
var init_install_hooks = __esm({
  "packages/mcp/src/cli/install-hooks.ts"() {
    "use strict";
    HOOK_EVENTS = [
      { event: "SessionStart", sub: "session-start", timeout: 30 },
      { event: "UserPromptSubmit", sub: "user-prompt-submit", timeout: 15 },
      // Response capture calls an aux LLM; never make the user wait on it.
      { event: "Stop", sub: "stop", async: true },
      { event: "PostCompact", sub: "post-compact", async: true },
      { event: "SessionEnd", sub: "session-end" }
    ];
    MARKER = "yapa";
  }
});

// packages/mcp/src/coord.ts
var coord_exports = {};
__export(coord_exports, {
  EXIT: () => EXIT,
  counterNext: () => counterNext,
  currentSession: () => currentSession,
  defaultSession: () => defaultSession,
  describeLease: () => describeLease,
  leaseAcquire: () => leaseAcquire,
  leaseHeartbeat: () => leaseHeartbeat,
  leaseList: () => leaseList,
  leaseRelease: () => leaseRelease,
  nextTaskId: () => nextTaskId
});
function defaultSession() {
  return currentSession() ?? `${getDeviceId()}:${process.pid}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
}
function describeLease(l, now = Math.floor(Date.now() / 1e3)) {
  const state = l.expired ? `EXPIRED ${ago(now, l.expires_at)} ago` : `expires in ${ago(l.expires_at, now)}`;
  return `${l.key} held by ${l.holder.user} (session ${l.holder.session}${l.holder.device ? `, ${l.holder.device}` : ""}) since ${new Date(l.acquired_at * 1e3).toISOString()}, ${state}; scope ${l.scope.join(", ")}` + (l.title ? `; "${l.title}"` : "");
}
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    const err = e;
    if (isCoordinationUnavailable(e)) {
      return {
        exit: EXIT.unavailable,
        json: { ok: false, unavailable: true, reason: err.reason ?? "unreachable", message: err.message },
        text: `not shared: ${err.message} (fall back to local coordination and say the work is not shared)`
      };
    }
    const usage2 = err.status === 400 || err.status === 403 || err.status === 413;
    return { exit: usage2 ? EXIT.usage : EXIT.error, json: { ok: false, code: err.code, message: err.message }, text: `error: ${err.message}` };
  }
}
function leaseAcquire(a) {
  return run(async () => {
    const session = a.session ?? defaultSession();
    const r = await (await requireCoordination()).leaseAcquire({ ...a, session });
    if (!r.granted) {
      const lines = r.conflicts.map((c) => `CONFLICT ${a.key}: ${describeLease(c.lease)} (overlap: ${c.overlap.join(", ")})`);
      return { exit: EXIT.refused, json: { ok: false, ...r }, text: lines.join("\n") };
    }
    const prev = r.took_over_from;
    noteLeaseHeld(session, r.lease.ttl_seconds);
    const verb = r.renewed ? "renewed" : prev?.reclaim ? `took over from ${prev.session} (your other session)` : prev ? `took over (expired lease of ${prev.user} session ${prev.session}; say so in the task notes)` : "granted";
    const local2 = coordinatedLocally(a.collection);
    recordLastWrite(a.collection);
    return {
      exit: EXIT.ok,
      json: { ok: true, ...r, local: local2 },
      text: `${verb} ${a.key} to session ${session}${local2 ? " (this machine)" : ""}: scope ${r.lease.scope.join(", ")}, expires ${new Date(r.lease.expires_at * 1e3).toISOString()}`
    };
  });
}
function leaseHeartbeat(collection, session, keys) {
  return run(async () => {
    const s = session ?? defaultSession();
    const r = await (await requireCoordination()).leaseHeartbeat(collection, s, keys);
    if (r.renewed.length) noteLeaseHeld(s, Math.min(...r.renewed.map((l) => l.ttl_seconds)));
    const lost = r.lost.length ? `; LOST (taken over or released): ${r.lost.join(", ")}` : "";
    if (r.unreachable) {
      return {
        exit: EXIT.unavailable,
        json: { ok: false, unavailable: true, reason: "unreachable", message: r.unreachable, renewed: r.renewed, lost: r.lost },
        text: `renewed ${r.renewed.length} lease(s) on this machine for session ${s}${lost}; NOT renewed on the sync service: ${r.unreachable}`
      };
    }
    return { exit: EXIT.ok, json: { ok: true, ...r }, text: `renewed ${r.renewed.length} lease(s) for session ${s}${lost}` };
  });
}
function leaseRelease(collection, key, session, outcome) {
  return run(async () => {
    const s = session ?? defaultSession();
    const r = await (await requireCoordination()).leaseRelease(collection, key, s, outcome);
    if (r.released) {
      recordLastWrite(collection);
      return { exit: EXIT.ok, json: { ok: true, ...r }, text: `released ${key} (${outcome ?? "done"})` };
    }
    if (r.reason === "not_held") return { exit: EXIT.ok, json: { ok: true, ...r }, text: `${key} is not leased` };
    return { exit: EXIT.refused, json: { ok: false, ...r }, text: `${key} is not yours to release: ${describeLease(r.lease)}` };
  });
}
function leaseList(collection, includeExpired = false) {
  return run(async () => {
    const r = await (await requireCoordination()).leaseList(collection, includeExpired);
    const text = r.leases.length ? r.leases.map((l) => `- ${describeLease(l, r.now)}`).join("\n") : `no ${includeExpired ? "" : "live "}leases in ${collection}`;
    return { exit: EXIT.ok, json: { ok: true, ...r }, text };
  });
}
function counterNext(collection, name, floor) {
  return run(async () => {
    const value = await (await requireCoordination()).counterNext(collection, name, floor);
    recordLastWrite(collection);
    return { exit: EXIT.ok, json: { ok: true, value, local: coordinatedLocally(collection) }, text: String(value) };
  });
}
function nextTaskId(floor) {
  return run(async () => {
    const id = await (await requireCoordination()).nextTaskId(floor);
    return { exit: EXIT.ok, json: { ok: true, id }, text: id };
  });
}
var EXIT, ago;
var init_coord = __esm({
  "packages/mcp/src/coord.ts"() {
    "use strict";
    init_src();
    EXIT = { ok: 0, error: 1, usage: 2, refused: 3, unavailable: 4 };
    ago = (now, t) => {
      const s = Math.max(0, now - t);
      return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
    };
  }
});

// packages/mcp/src/cli/task.ts
var task_exports = {};
__export(task_exports, {
  TASK_USAGE: () => TASK_USAGE,
  runTask: () => runTask
});
import { readFileSync as readFileSync22 } from "node:fs";
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : void 0;
}
function int(v, name) {
  if (v === void 0) return void 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer`);
  return n;
}
function taskJson(t, claims) {
  const m = t.metadata;
  const lease = claims?.get(t.id);
  return {
    id: t.id,
    title: t.title,
    collection: t.collection,
    status: m.status,
    priority: m.priority,
    tags: Array.isArray(m.tags) ? m.tags : String(m.tags ?? "").split(",").filter(Boolean),
    depends_on: Array.isArray(m.depends_on) ? m.depends_on : String(m.depends_on ?? "").split(",").filter(Boolean),
    blocks: Array.isArray(m.blocks) ? m.blocks : String(m.blocks ?? "").split(",").filter(Boolean),
    claim_scope: Array.isArray(m.claim_scope) ? m.claim_scope : String(m.claim_scope ?? "").split(",").filter(Boolean),
    waits_on: Array.isArray(m.waits_on) ? m.waits_on : String(m.waits_on ?? "").split(",").filter(Boolean),
    memory_ids: Array.isArray(m.memory_ids) ? m.memory_ids : String(m.memory_ids ?? "").split(",").filter(Boolean),
    blocked_reason: m.blockedReason || m.blocked_reason || null,
    notes: m.notes ?? "",
    due_date: m.due_date || null,
    owner: m.origin_user ?? null,
    created_at: m.created_at ?? null,
    updated_at: m.updated_at ?? null,
    claim: lease ? { user: lease.holder.user, session: lease.holder.session, since: lease.acquired_at, expires_at: lease.expires_at } : null,
    claim_note: claimNote(t, claims) || null
  };
}
function claimExit(c) {
  if (c?.kind === "refused") return EXIT.refused;
  if (c?.kind === "unshared") return EXIT.unavailable;
  return EXIT.ok;
}
function claimJson(c) {
  if (!c) return null;
  const base = { kind: c.kind, id: c.id };
  switch (c.kind) {
    case "granted":
      return { ...base, session: c.session, renewed: c.renewed, lease: c.lease, took_over_from: c.tookOverFrom ?? null };
    case "refused":
      return { ...base, session: c.session, conflicts: c.conflicts };
    case "unshared":
      return { ...base, session: c.session, reason: c.reason };
    default:
      return base;
  }
}
async function runTask(sub, args) {
  try {
    return await dispatch(sub, args);
  } catch (e) {
    if (e instanceof ClaimBusyError) {
      return { exit: EXIT.unavailable, json: { ok: false, busy: true, error: e.message }, text: e.message };
    }
    if (e instanceof TaskClaimedError) {
      return { exit: EXIT.refused, json: { ok: false, refused: true, claim: claimJson(e.result) }, text: e.message };
    }
    const usage2 = e instanceof UsageError || e instanceof TypedMemoryError;
    const message2 = e instanceof Error ? e.message : String(e);
    return { exit: usage2 ? EXIT.usage : EXIT.error, json: { ok: false, error: message2 }, text: `yapa task ${sub ?? ""}: ${message2}` };
  }
}
async function dispatch(sub, args) {
  const positional2 = args.find((a) => !a.startsWith("--") && !isFlagValue(args, a));
  const session = flag(args, "--session");
  const claimOpts = {
    session,
    scope: list7(flag(args, "--scope")),
    ttlSeconds: int(flag(args, "--ttl"), "--ttl"),
    title: flag(args, "--title"),
    reclaim: args.includes("--reclaim") || void 0
  };
  switch (sub) {
    case "list": {
      const status = flag(args, "--status");
      if (status && !STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(", ")}`);
      const collection = flag(args, "--collection");
      const wantTags = list7(flag(args, "--tag")) ?? [];
      const tasks = (await listTasks({ collection, status, includeComplete: args.includes("--include-complete") })).filter((t) => {
        if (!wantTags.length) return true;
        const tags = Array.isArray(t.metadata.tags) ? t.metadata.tags : String(t.metadata.tags ?? "").split(",");
        return wantTags.every((x) => tags.includes(x));
      });
      const claims = collection ? await claimsFor(collection) : void 0;
      return { exit: EXIT.ok, json: { ok: true, tasks: tasks.map((t) => taskJson(t, claims)) }, text: `${tasks.length} task(s)` };
    }
    case "show": {
      if (!positional2) throw new UsageError("task id required");
      const t = await getTask(positional2);
      if (!t) return { exit: EXIT.error, json: { ok: false, error: "not_found" }, text: `${positional2} not found` };
      return { exit: EXIT.ok, json: { ok: true, task: taskJson(t, await claimsFor(t.collection)) }, text: `${t.id} [${t.metadata.status}] ${t.title}` };
    }
    case "next": {
      const collection = flag(args, "--collection");
      if (!collection) throw new UsageError("--collection is required");
      const r = await nextTasks({
        collection,
        tags: list7(flag(args, "--tag")),
        excludeTags: list7(flag(args, "--exclude-tag")),
        claim: args.includes("--claim"),
        autoOnly: args.includes("--auto-only"),
        includeCleanup: args.includes("--include-cleanup"),
        ...claimOpts
      });
      if (r.claimed) recordLastWrite(collection);
      const json = { ok: true, claims_known: r.claimsKnown, ready: r.ready, skipped: r.skipped, cleanup: r.cleanup, claimed: claimJson(r.claimed) };
      if (!args.includes("--claim")) {
        return { exit: EXIT.ok, json, text: r.ready.length ? `next: ${r.ready[0].id} ${r.ready[0].title} (${r.ready.length} ready)` : "nothing ready" };
      }
      if (!r.claimed) return { exit: EXIT.ok, json: { ...json, ok: true }, text: "nothing ready" };
      return { exit: claimExit(r.claimed), json, text: describeClaim(r.claimed) || `started ${r.claimed.id}` };
    }
    case "claim": {
      if (!positional2) throw new UsageError("task id required");
      if (positional2.startsWith("cleanup:")) {
        const collection = flag(args, "--collection");
        if (!collection) throw new UsageError("--collection is required for a cleanup key");
        const c = await claimKey(collection, positional2, claimOpts);
        return { exit: claimExit(c), json: { ok: c.kind !== "refused", id: positional2, session: claimSession(session), claim: claimJson(c) }, text: describeClaim(c) || `claimed ${positional2}` };
      }
      const r = await updateTask(positional2, { status: "in_progress" }, claimOpts);
      recordLastWrite((await getTask(r.id))?.collection);
      return {
        exit: claimExit(r.claim),
        json: { ok: true, id: r.id, session: claimSession(session), claim: claimJson(r.claim) },
        text: r.claim && describeClaim(r.claim) || `started ${r.id}`
      };
    }
    case "release": {
      if (!positional2) throw new UsageError("task id required");
      if (positional2.startsWith("cleanup:")) {
        const collection = flag(args, "--collection");
        if (!collection) throw new UsageError("--collection is required for a cleanup key");
        const rel = await releaseTaskClaim(positional2, collection, "done", session);
        return { exit: rel.kind === "unshared" ? EXIT.unavailable : EXIT.ok, json: { ok: true, id: positional2, release: rel }, text: `${positional2} released` };
      }
      const status = flag(args, "--status");
      if (!status || !["pending", "blocked", "complete"].includes(status)) throw new UsageError("--status must be pending, blocked or complete");
      const t = await getTask(positional2);
      if (!t) return { exit: EXIT.error, json: { ok: false, error: "not_found" }, text: `${positional2} not found` };
      const note = flag(args, "--note");
      const addTags = list7(flag(args, "--tag")) ?? [];
      const learned = jsonFile(flag(args, "--learned-file"), "array");
      const followUps = jsonFile(flag(args, "--follow-ups-file"), "array");
      const decisionNeeded = jsonFile(flag(args, "--decision-needed-file"), "object");
      const waitsOn = list7(flag(args, "--waits-on"));
      if (decisionNeeded && status !== "pending") throw new UsageError("--decision-needed-file goes with --status pending");
      validateLearned(learned);
      const listOf = (v) => Array.isArray(v) ? v : String(v ?? "").split(",").filter(Boolean);
      if (note || addTags.length || waitsOn?.length) {
        await withDocLock(t.collection, t.id, async () => {
          const now = await getTask(t.id) ?? t;
          const extra = {};
          if (note) extra.notes = now.metadata.notes ? `${now.metadata.notes}
${note}` : note;
          if (addTags.length) extra.tags = [.../* @__PURE__ */ new Set([...listOf(now.metadata.tags), ...addTags])];
          if (waitsOn?.length) extra.waits_on = [.../* @__PURE__ */ new Set([...listOf(now.metadata.waits_on), ...waitsOn])];
          await updateTask(t.id, extra, { session });
        });
      }
      let release;
      let recorded;
      let nudge;
      let decision;
      if (status === "complete") {
        const c = await completeTask(t.id, int(flag(args, "--duration"), "--duration"), { session }, { learned, follow_ups: followUps });
        release = c.release;
        recorded = c.recorded;
        nudge = c.nudge;
      } else {
        const reason = flag(args, "--reason");
        const fields = { ...reason ? { blockedReason: reason } : {} };
        if (decisionNeeded) {
          const d = await requestDecision(t.id, decisionNeeded, { session }, fields);
          release = d.release;
          decision = d.decision;
        } else {
          release = (await updateTask(t.id, { status, ...fields }, { session })).release;
        }
        if (learned?.length || followUps?.length) recorded = await recordForTask({ id: t.id, collection: t.collection }, { learned, follow_ups: followUps });
      }
      recordLastWrite(t.collection);
      const pushed = await pushDocsNow(t.collection, [t.id]).catch(() => void 0);
      const exit = release?.kind === "unshared" || pushed && pushed.errors > 0 ? EXIT.unavailable : EXIT.ok;
      const text = release?.kind === "released" ? `${t.id} -> ${status}; claim released` : release?.kind === "held_by_other" ? `${t.id} -> ${status}; note: ${release.lease.holder.user} (session ${release.lease.holder.session}) still holds a claim on it` : release?.kind === "unshared" ? `${t.id} -> ${status}; release not shared (${release.reason}); the claim lapses on its own` : `${t.id} -> ${status}`;
      const more = [
        decision ? `decision ${decision} recorded; the task waits on it` : "",
        recorded?.memories.length ? `recorded ${recorded.memories.join(", ")}` : "",
        recorded?.follow_ups.length ? `follow-ups ${recorded.follow_ups.join(", ")}` : "",
        nudge ?? ""
      ].filter(Boolean);
      return {
        exit,
        json: { ok: true, id: t.id, status, release: release ?? null, decision: decision ?? null, recorded: recorded ?? null, nudge: nudge ?? null },
        text: more.length ? `${text}
${more.join("\n")}` : text
      };
    }
    default:
      throw new UsageError(`unknown command
${TASK_USAGE}`);
  }
}
function jsonFile(path3, shape) {
  if (path3 === void 0) return void 0;
  let v;
  try {
    v = JSON.parse(readFileSync22(path3 === "-" ? 0 : path3, "utf8"));
  } catch (e) {
    throw new UsageError(`${path3}: ${e instanceof Error ? e.message : e}`);
  }
  if (shape === "array" ? !Array.isArray(v) : !v || typeof v !== "object" || Array.isArray(v)) {
    throw new UsageError(`${path3}: expected a JSON ${shape}`);
  }
  return v;
}
function isFlagValue(args, a) {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1].startsWith("--") && !["--claim", "--reclaim", "--include-complete", "--text", "--auto-only", "--include-cleanup"].includes(args[i - 1]);
}
var TASK_USAGE, list7, UsageError, STATUSES;
var init_task = __esm({
  "packages/mcp/src/cli/task.ts"() {
    "use strict";
    init_src();
    init_coord();
    TASK_USAGE = 'Usage: yapa task list    [--collection C] [--status S] [--tag a,b] [--include-complete]\n       yapa task next    --collection C [--tag a,b] [--exclude-tag a,b] [--auto-only] [--include-cleanup] [--claim [claim options]]\n       yapa task claim   ID|cleanup:KIND [--collection C] [--session S] [--scope a,b] [--ttl SECONDS] [--title T] [--reclaim]\n       yapa task release ID --status pending|blocked|complete [--reason R] [--note N] [--tag a,b] [--duration MIN]\n                         [--waits-on MEM,..] [--learned-file F] [--follow-ups-file F] [--decision-needed-file F] [--session S]\n       yapa task release cleanup:KIND --collection C [--session S]\n       yapa task show    ID\nclaim moves the task to in_progress and takes a lease on its id (shared collections); release sets the new\nstatus and releases it. A cleanup:KIND key (from next) is a lease only. --learned-file and --follow-ups-file\nhold a JSON array (learned: {content, kind, status, ...}; follow-ups: {title, priority, tags, notes});\n--decision-needed-file a JSON object {question, options, recommendation, owner, context} (the task then waits\non it, pending). "-" reads stdin. --session defaults to $YAPA_SESSION, then $CLAUDE_CODE_SESSION_ID, else this process.\nPrints one JSON object (--text: a short summary).\nExit: 0 done, 3 refused (held by someone else), 4 done locally but not shared, 2 bad arguments, 1 other error.\n';
    list7 = (v) => v === void 0 ? void 0 : v.split(",").map((x) => x.trim()).filter(Boolean);
    UsageError = class extends Error {
    };
    STATUSES = ["pending", "in_progress", "blocked", "complete"];
  }
});

// packages/mcp/src/cli/memory.ts
var memory_exports = {};
__export(memory_exports, {
  MEMORY_USAGE: () => MEMORY_USAGE,
  runMemory: () => runMemory,
  runWaiting: () => runWaiting
});
function flag2(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : void 0;
}
function flags(args, name) {
  const out = [];
  args.forEach((a, i) => {
    if (a === name && i + 1 < args.length) out.push(args[i + 1]);
  });
  return out;
}
function positional(args) {
  return args.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
}
async function readStdin2() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
async function input(args) {
  if (args.includes("--stdin-json")) {
    let parsed;
    try {
      parsed = JSON.parse(await readStdin2());
    } catch (e) {
      throw new UsageError2(`--stdin-json: ${e instanceof Error ? e.message : e}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError2("--stdin-json expects one JSON object");
    return parsed;
  }
  const out = {};
  const set = (k, v) => {
    if (v !== void 0 && !(Array.isArray(v) && !v.length)) out[k] = v;
  };
  set("kind", flag2(args, "--kind"));
  set("status", flag2(args, "--status"));
  set("owner", flag2(args, "--owner"));
  set("task_ids", csv(flag2(args, "--task-ids")));
  set("options", flags(args, "--option"));
  set("recommendation", flag2(args, "--recommendation"));
  set("disposition", flag2(args, "--disposition"));
  set("disposition_ids", csv(flag2(args, "--disposition-ids")));
  set("disposition_reason", flag2(args, "--disposition-reason"));
  set("exit_criteria", flag2(args, "--exit-criteria"));
  set("tags", csv(flag2(args, "--tags")));
  set("content", flag2(args, "--content"));
  set("note", flag2(args, "--note"));
  return out;
}
function split(i) {
  const { content, note, tags, ...typed } = i;
  return { content, note, tags, typed };
}
async function listWhole(args) {
  const collection = flag2(args, "--collection");
  const limitRaw = flag2(args, "--limit");
  const limit = limitRaw === void 0 ? 1e3 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) throw new UsageError2("--limit must be a positive integer");
  const rows = await listMemories({
    collection,
    kind: flag2(args, "--kind"),
    status: flag2(args, "--status"),
    owner: flag2(args, "--owner"),
    tags: csv(flag2(args, "--tag")),
    include_archived: args.includes("--include-archived"),
    limit: 1e5
  });
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const key = `${r.collection}\0${r.metadata.parent_id ?? r.id}`;
    groups.set(key, [...groups.get(key) ?? [], r]);
  }
  const out = [];
  for (const parts of groups.values()) {
    const first = parts[0];
    let chunks = parts;
    if (first.metadata.parent_id) {
      chunks = (await getDocumentsByFilter2(first.collection, { parent_id: first.metadata.parent_id }, 1e3).catch(() => parts)).map((d) => ({ ...d, collection: first.collection }));
      chunks.sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0));
    }
    const { chunk_index: _i, chunk_total: _t, parent_id: _p, ...metadata } = chunks[0].metadata;
    out.push({
      id: first.metadata.parent_id ?? first.id,
      collection: first.collection,
      content: chunks.map((c) => c.content).join(""),
      metadata
    });
  }
  out.sort((a, b) => Number(b.metadata.created_at ?? 0) - Number(a.metadata.created_at ?? 0));
  return out.slice(0, limit);
}
async function runMemory(sub, args) {
  try {
    switch (sub) {
      case "list": {
        const memories = await listWhole(args);
        return { exit: 0, json: { ok: true, memories }, text: `${memories.length} memor${memories.length === 1 ? "y" : "ies"}` };
      }
      case "put": {
        const collection = flag2(args, "--collection");
        const ref = flag2(args, "--ref");
        if (!collection || !ref) throw new UsageError2("--collection and --ref are required");
        const { content, tags, typed } = split(await input(args));
        if (!content?.trim()) throw new UsageError2('content is required (--content or "content" in --stdin-json)');
        const target = await resolveWriteCollection(collection);
        const r = await putExternal(target.collection, ref, { content, typed, tags });
        recordLastWrite(target.collection);
        return {
          exit: 0,
          json: { ok: true, ...r, ref, collection: target.collection, ...target.redirectedFrom ? { redirected_from: target.redirectedFrom } : {} },
          text: `${r.id} ${r.action}${target.redirectedFrom ? ` (${redirectNote(target)})` : ""}`
        };
      }
      case "update": {
        const id = positional(args);
        if (!id) throw new UsageError2("memory id required");
        const { content, note, tags, typed } = split(await input(args));
        const r = await updateMemory(id, { ...typed, ...content !== void 0 ? { content } : {}, ...note !== void 0 ? { note } : {}, ...tags ? { tags } : {} }, flag2(args, "--collection"));
        recordLastWrite(r.collection);
        return { exit: 0, json: { ok: true, id: r.id, collection: r.collection, metadata: r.metadata }, text: `updated ${r.id}` };
      }
      default:
        throw new UsageError2(`unknown command
${MEMORY_USAGE}`);
    }
  } catch (e) {
    return fail(`yapa memory ${sub ?? ""}`, e);
  }
}
async function runWaiting(args) {
  try {
    const collection = flag2(args, "--collection");
    const user = args.includes("--everyone") ? void 0 : flag2(args, "--for") ?? getConfig().USERNAME;
    const w = await waitingOn({ collection, user });
    return { exit: 0, json: { ok: true, user: user ?? null, ...w }, text: formatWaiting(w, { collection: !collection }) };
  } catch (e) {
    return fail("yapa waiting", e);
  }
}
function fail(what, e) {
  const usage2 = e instanceof UsageError2 || e instanceof TypedMemoryError;
  const message2 = e instanceof Error ? e.message : String(e);
  const code = e instanceof MemoryNotFoundError ? "not_found" : void 0;
  return { exit: usage2 ? 2 : 1, json: { ok: false, error: message2, ...code ? { code } : {} }, text: `${what}: ${message2}` };
}
var MEMORY_USAGE, UsageError2, csv, VALUE_FLAGS;
var init_memory = __esm({
  "packages/mcp/src/cli/memory.ts"() {
    "use strict";
    init_src();
    MEMORY_USAGE = "Usage: yapa memory list   [--collection C] [--kind K] [--status S] [--owner U] [--tag a,b] [--include-archived] [--limit N]\n       yapa memory put    --collection C --ref R [typed fields] (--content TEXT | --stdin-json)\n       yapa memory update ID [--collection C] [typed fields] [--note TEXT] [--stdin-json]\n       yapa waiting       [--collection C] [--for U | --everyone]\nTyped fields: --kind finding|decision|limitation|question|idea --status S --owner U --task-ids a,b\n  --option TEXT (repeat) --recommendation TEXT --disposition D --disposition-ids a,b --disposition-reason TEXT\n  --exit-criteria TEXT --tags a,b. --stdin-json reads the same fields (and content, note) as one JSON object.\nPrints one JSON object (--text: a short summary). Exit: 0 done, 2 bad arguments, 1 other error.\n";
    UsageError2 = class extends Error {
    };
    csv = (v) => v === void 0 ? void 0 : v.split(",").map((x) => x.trim()).filter(Boolean);
    VALUE_FLAGS = /* @__PURE__ */ new Set([
      "--collection",
      "--kind",
      "--status",
      "--owner",
      "--tag",
      "--limit",
      "--ref",
      "--content",
      "--note",
      "--task-ids",
      "--option",
      "--recommendation",
      "--disposition",
      "--disposition-ids",
      "--disposition-reason",
      "--exit-criteria",
      "--tags",
      "--for"
    ]);
  }
});

// packages/mcp/src/cli/capture.ts
var capture_exports = {};
__export(capture_exports, {
  CAPTURE_USAGE: () => CAPTURE_USAGE,
  runCapture: () => runCapture2
});
function when(ms, now) {
  if (!ms) return "never";
  const min = Math.round((now - ms) / 6e4);
  return min < 1 ? "just now" : min < 120 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}
function runCapture2(sub, args, now = Date.now()) {
  if (sub !== "status") return { exit: 2, json: { ok: false, error: CAPTURE_USAGE.trim() }, text: CAPTURE_USAGE.trim() };
  const i = args.indexOf("--days");
  const days = i >= 0 ? Number(args[i + 1]) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 14) return { exit: 2, json: { ok: false, error: "--days must be 1-14" }, text: "--days must be 1-14" };
  const file = captureHealthFile();
  const s = summarizeCapture(readCaptureHealth(file), now, days);
  const lines = [
    `Capture over the last ${days} day(s): ${s.turns} turn(s) judged, ${s.stored} stored, ${s.skipped} skipped as known, ${s.settled} settled`,
    `Failures: ${s.failed} extraction, ${s.store_failed} store, ${s.follow_through_failed} follow-through, ${s.compactions_failed} of ${s.compactions} compaction capture(s)`,
    `Last success: ${when(s.last_ok_at, now)}`,
    ...s.last_error ? [`Last error (${s.last_error.stage}, ${when(s.last_error.at, now)}): ${s.last_error.message}`] : [],
    ...s.failing ? ["Status: FAILING"] : [],
    ...file ? [] : ["(no health file: SYNC_HEALTH_FILE is off)"]
  ];
  return { exit: 0, json: { ok: true, file: file || null, ...s }, text: lines.join("\n") };
}
var CAPTURE_USAGE;
var init_capture2 = __esm({
  "packages/mcp/src/cli/capture.ts"() {
    "use strict";
    init_src();
    CAPTURE_USAGE = "Usage: yapa capture status [--days N] [--text]\n";
  }
});

// packages/mcp/src/cli/scope.ts
var scope_exports = {};
__export(scope_exports, {
  runScope: () => runScope,
  scopeCwd: () => scopeCwd
});
import { resolve as resolve2 } from "node:path";
async function runScope(args, cwdDefault = process.cwd()) {
  const at = args.indexOf("--cwd");
  const cwd = resolve2(at >= 0 && args[at + 1] ? args[at + 1] : cwdDefault);
  const d = await detectCollection(cwd);
  const localOnly = !isSyncableCollection(d.collection);
  return {
    json: {
      ok: true,
      cwd,
      collection: d.collection,
      local_only: localOnly,
      mapped: !!d.mapped,
      ...d.redirectedFrom ? { redirected_from: d.redirectedFrom } : {},
      ...d.ambiguous ? { ambiguous: d.ambiguous } : {}
    },
    text: `${d.collection}${localOnly ? " (local only)" : ""}`
  };
}
function scopeCwd(args, cwdDefault = process.cwd()) {
  const at = args.indexOf("--cwd");
  return resolve2(at >= 0 && args[at + 1] ? args[at + 1] : cwdDefault);
}
var init_scope2 = __esm({
  "packages/mcp/src/cli/scope.ts"() {
    "use strict";
    init_src();
  }
});

// packages/mcp/src/cli/index.ts
import { dirname as dirname14, join as join19 } from "node:path";

// packages/mcp/src/cli/env.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var PLUGIN_OPTION_PREFIX = "CLAUDE_PLUGIN_OPTION_";
function resolveHostEnv(env, claudeConfig, cwd) {
  const add = {};
  const offer = (key, value) => {
    if (typeof value !== "string" || value === "") return;
    if (env[key] !== void 0 || add[key] !== void 0) return;
    add[key] = value;
  };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(PLUGIN_OPTION_PREFIX)) {
      offer(`YAPA_${key.slice(PLUGIN_OPTION_PREFIX.length)}`, value);
    }
  }
  if (env.CLAUDE_PLUGIN_ROOT) {
    offer("YAPA_HOOK_INJECT_RULES", "true");
    if (env.CLAUDE_PLUGIN_DATA) offer("YAPA_MODEL_CACHE_DIR", join(env.CLAUDE_PLUGIN_DATA, "models"));
    return add;
  }
  const projectEnv = cwd ? claudeConfig?.projects?.[cwd]?.mcpServers?.yapa?.env : void 0;
  for (const block of [projectEnv, claudeConfig?.mcpServers?.yapa?.env]) {
    if (!block || typeof block !== "object") continue;
    for (const [key, value] of Object.entries(block)) offer(key, value);
  }
  return add;
}
function pluginSettingsEnv(env, settings) {
  const add = {};
  if (settings?.enabledPlugins?.["yapa@yapa"] !== true) return add;
  const options = settings?.pluginConfigs?.["yapa@yapa"]?.options;
  if (!options || typeof options !== "object") return add;
  for (const [key, value] of Object.entries(options)) {
    const name = `YAPA_${key.toUpperCase()}`;
    const v = typeof value === "boolean" || typeof value === "number" ? String(value) : value;
    if (typeof v === "string" && v !== "" && env[name] === void 0) add[name] = v;
  }
  return add;
}
function adoptCliEnv(cwd) {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    const add = pluginSettingsEnv(process.env, settings);
    if (Object.keys(add).length) {
      Object.assign(process.env, add);
      return;
    }
  } catch {
  }
  adoptHostEnv(cwd);
}
function adoptHostEnv(cwd) {
  let claudeConfig;
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? homedir();
    claudeConfig = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"));
  } catch {
    claudeConfig = void 0;
  }
  Object.assign(process.env, resolveHostEnv(process.env, claudeConfig, cwd));
}

// packages/mcp/src/cli/index.ts
var USAGE = "Usage: yapa hook <session-start|user-prompt-submit|stop|post-compact|session-end>\n         (reads Claude Code hook JSON from stdin)\n       yapa hooks install [--settings <path>]    add YAPA hooks to Claude Code settings\n       yapa hooks uninstall [--settings <path>]  remove them\n       yapa hooks print                          show the hooks block without writing it\n       yapa statusline install [--settings <path>]  show sync health in the Claude Code status line\n       yapa statusline uninstall [--settings <path>]  remove it (restores a status line it wrapped)\n       yapa statusline show                      print the status line segment now\n       yapa coord <command> [options]            leases and counters on the sync service (yapa coord help)\n       yapa task <command> [options]             list, pick, claim and release tasks (yapa task help)\n       yapa memory <command> [options]           list, put and update typed memories (yapa memory help)\n       yapa waiting [--for U | --everyone]       decisions, questions and steps waiting on a person\n       yapa capture status [--days N]            whether the per-turn capture is working (counts, failures, last error)\n       yapa scope [--cwd DIR] [--text]           the collection YAPA uses for a folder (collection_map, project_roots)\n";
var COORD_USAGE = "Usage: yapa coord acquire   --collection C --key K [--session S] [--scope a,b] [--ttl SECONDS] [--title T] [--reclaim]\n       yapa coord heartbeat [--collection C [--keys a,b]] [--session S]\n       yapa coord release   --collection C --key K [--session S] [--outcome done|blocked|pending]\n       yapa coord list      --collection C [--include-expired]\n       yapa coord counter-next --collection C --name N [--floor N]\n       yapa coord task-id   [--floor N]\n--session defaults to $YAPA_SESSION, then the Claude Code session ($CLAUDE_CODE_SESSION_ID). Prints one JSON object on stdout (--text: a short summary).\nShared collections are coordinated by the sync service; private-*, local-* and global (and every collection with sync off) by this machine.\nExit: 0 done, 3 refused (held or overlapping), 4 unavailable (the service for a shared collection; nothing shared: fall back locally),\n      2 bad arguments, 1 other error.\n";
function usage() {
  process.stderr.write(USAGE);
  process.exit(2);
}
async function readStdin3() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk2 of process.stdin) {
    chunks.push(chunk2);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
function exitAfterFlush(code) {
  return new Promise(() => {
    process.stdout.write("", () => process.exit(code));
  });
}
async function runHook(name) {
  const raw = await readStdin3();
  const input2 = raw.trim() ? JSON.parse(raw) : {};
  if (process.env.YAPA_HOOK_CHILD) {
    process.stdout.write("{}");
    return;
  }
  adoptHostEnv(input2.cwd);
  const hooks = await Promise.resolve().then(() => (init_hooks(), hooks_exports));
  switch (name) {
    case "session-start":
      return hooks.sessionStart(input2);
    case "user-prompt-submit":
      return hooks.userPromptSubmit(input2);
    case "stop":
      return hooks.stop(input2);
    case "post-compact":
      return hooks.postCompact(input2);
    case "session-end":
      return hooks.sessionEnd(input2);
    default:
      usage();
  }
}
async function runHooksCommand(action, args) {
  const { installHooks: installHooks2, uninstallHooks: uninstallHooks2, mergeHooks: mergeHooks2, selfCommand: selfCommand2 } = await Promise.resolve().then(() => (init_install_hooks(), install_hooks_exports));
  const at = args.indexOf("--settings");
  const path3 = at >= 0 ? args[at + 1] : void 0;
  switch (action) {
    case "install":
      process.stdout.write(`YAPA hooks installed in ${installHooks2(path3)}
`);
      return;
    case "uninstall":
      process.stdout.write(`YAPA hooks removed from ${uninstallHooks2(path3)}
`);
      return;
    case "print":
      process.stdout.write(JSON.stringify(mergeHooks2({}, selfCommand2()), null, 2) + "\n");
      return;
    default:
      usage();
  }
}
async function runStatusLineCommand(action, args) {
  adoptCliEnv(process.cwd());
  const sl = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
  const { statusLineScriptPath: statusLineScriptPath2, bundledStatusLineScript: bundledStatusLineScript2 } = await Promise.resolve().then(() => (init_hooks(), hooks_exports));
  const { getConfig: getConfig2 } = await Promise.resolve().then(() => (init_src(), src_exports));
  const path3 = flag3(args, "--settings");
  const script = statusLineScriptPath2();
  switch (action) {
    case "install": {
      const from = bundledStatusLineScript2();
      if (!script || !from) throw new Error("no status line script (YAPA_SYNC_HEALTH_FILE is off, or this build has none)");
      sl.copyScript(from, script);
      process.stdout.write(`Status line added to ${sl.installStatusLine(script, path3)} (runs ${script})
`);
      sl.setRemovedMarker(dirname14(script), false);
      return;
    }
    case "uninstall":
      process.stdout.write(`Status line removed from ${sl.uninstallStatusLine(path3, script)}
`);
      if (script) sl.setRemovedMarker(dirname14(script), true);
      return;
    case "show": {
      const { YAPA_VERSION: YAPA_VERSION2 } = await Promise.resolve().then(() => (init_version(), version_exports));
      const health = getConfig2().SYNC_HEALTH_FILE;
      const update = health ? sl.readUpdate(join19(dirname14(health), "update-check.json")) : void 0;
      process.stdout.write(sl.renderSegment(sl.readHealth(health), Date.now(), {
        color: !process.env.NO_COLOR,
        version: YAPA_VERSION2,
        remote: getConfig2().REMOTE_NAME || void 0,
        update,
        captureFailing: health ? sl.captureFailingAt(join19(dirname14(health), "capture-health.json"), Date.now()) : false
      }) + "\n");
      return;
    }
    default:
      usage();
  }
}
function flag3(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : void 0;
}
function list8(v) {
  return v === void 0 ? void 0 : v.split(",").map((x) => x.trim()).filter(Boolean);
}
function int2(v, name) {
  if (v === void 0) return void 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}
async function runCoord(sub, args) {
  if (!sub || sub === "help" || args.includes("--help")) {
    process.stderr.write(COORD_USAGE);
    return sub ? 0 : 2;
  }
  adoptCliEnv(process.cwd());
  const coord = await Promise.resolve().then(() => (init_coord(), coord_exports));
  const collection = flag3(args, "--collection");
  const need = (v, name) => {
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  let r;
  try {
    const session = coord.currentSession(flag3(args, "--session"));
    if (!session && ["acquire", "heartbeat", "release"].includes(sub)) {
      throw new Error("--session is required outside Claude Code (or set YAPA_SESSION)");
    }
    switch (sub) {
      case "acquire":
        r = await coord.leaseAcquire({
          collection: need(collection, "--collection"),
          key: need(flag3(args, "--key"), "--key"),
          session,
          scope: list8(flag3(args, "--scope")),
          ttlSeconds: int2(flag3(args, "--ttl"), "--ttl"),
          title: flag3(args, "--title"),
          ...args.includes("--reclaim") ? { reclaim: true } : {}
        });
        break;
      case "heartbeat":
        r = await coord.leaseHeartbeat(collection, session, list8(flag3(args, "--keys")));
        break;
      case "release":
        r = await coord.leaseRelease(need(collection, "--collection"), need(flag3(args, "--key"), "--key"), session, flag3(args, "--outcome"));
        break;
      case "list":
        r = await coord.leaseList(need(collection, "--collection"), args.includes("--include-expired"));
        break;
      case "counter-next":
        r = await coord.counterNext(need(collection, "--collection"), need(flag3(args, "--name"), "--name"), int2(flag3(args, "--floor"), "--floor"));
        break;
      case "task-id":
        r = await coord.nextTaskId(int2(flag3(args, "--floor"), "--floor"));
        break;
      default:
        process.stderr.write(COORD_USAGE);
        return 2;
    }
  } catch (e) {
    process.stderr.write(`yapa coord ${sub}: ${e instanceof Error ? e.message : e}
`);
    return 2;
  }
  process.stdout.write((args.includes("--text") ? r.text : JSON.stringify(r.json)) + "\n");
  return r.exit;
}
async function main2() {
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === "coord") {
    await exitAfterFlush(await runCoord(sub, rest));
  }
  if (command === "task") {
    if (!sub || sub === "help" || rest.includes("--help")) {
      const { TASK_USAGE: TASK_USAGE2 } = await Promise.resolve().then(() => (init_task(), task_exports));
      process.stderr.write(TASK_USAGE2);
      process.exit(sub ? 0 : 2);
    }
    adoptCliEnv(process.cwd());
    const { runTask: runTask2 } = await Promise.resolve().then(() => (init_task(), task_exports));
    const r = await runTask2(sub, rest);
    process.stdout.write((rest.includes("--text") ? r.text : JSON.stringify(r.json)) + "\n");
    await exitAfterFlush(r.exit);
  }
  if (command === "memory" || command === "waiting") {
    if (command === "memory" && (!sub || sub === "help" || rest.includes("--help"))) {
      const { MEMORY_USAGE: MEMORY_USAGE2 } = await Promise.resolve().then(() => (init_memory(), memory_exports));
      process.stderr.write(MEMORY_USAGE2);
      process.exit(sub ? 0 : 2);
    }
    adoptCliEnv(process.cwd());
    const m = await Promise.resolve().then(() => (init_memory(), memory_exports));
    const args = command === "waiting" ? [sub, ...rest].filter((a) => a !== void 0) : rest;
    const r = command === "waiting" ? await m.runWaiting(args) : await m.runMemory(sub, rest);
    process.stdout.write((args.includes("--text") ? r.text : JSON.stringify(r.json)) + "\n");
    await exitAfterFlush(r.exit);
  }
  if (command === "capture") {
    adoptCliEnv(process.cwd());
    const { runCapture: runCapture3 } = await Promise.resolve().then(() => (init_capture2(), capture_exports));
    const r = runCapture3(sub, rest);
    process.stdout.write((rest.includes("--text") ? r.text : JSON.stringify(r.json)) + "\n");
    await exitAfterFlush(r.exit);
  }
  if (command === "scope") {
    const args = [sub, ...rest].filter((a) => a !== void 0);
    const { runScope: runScope2, scopeCwd: scopeCwd2 } = await Promise.resolve().then(() => (init_scope2(), scope_exports));
    adoptCliEnv(scopeCwd2(args));
    const r = await runScope2(args);
    process.stdout.write((args.includes("--text") ? r.text : JSON.stringify(r.json)) + "\n");
    await exitAfterFlush(0);
  }
  if (command === "hooks") {
    await runHooksCommand(sub, rest);
    return;
  }
  if (command === "statusline") {
    try {
      await runStatusLineCommand(sub, rest);
    } catch (e) {
      process.stderr.write(`yapa statusline ${sub}: ${e instanceof Error ? e.message : e}
`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (command !== "hook" || !sub) usage();
  try {
    await runHook(sub);
    await exitAfterFlush(0);
  } catch (e) {
    process.stderr.write(`[yapa] hook ${sub} failed: ${e}
`);
    process.stdout.write("{}");
    await exitAfterFlush(0);
  }
}
main2();
