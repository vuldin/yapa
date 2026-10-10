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

// packages/core/src/config.ts
import { homedir as homedir2, userInfo } from "os";
import { join as pathJoin } from "path";
function list(value) {
  return value.split(/[,:]/).map((v) => v.trim()).filter(Boolean);
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
    SYNC_ID_TOKEN_CACHE: /* @__PURE__ */ ((v) => v === "off" ? "" : v)(get(env, "SYNC_ID_TOKEN_CACHE", pathJoin(homedir2(), ".local", "share", "yapa", "id-token"))),
    SYNC_HTTP_TIMEOUT_MS: parseInt(get(env, "SYNC_HTTP_TIMEOUT_MS", "15000"), 10),
    SYNC_DATABASE_URL: get(env, "SYNC_DATABASE_URL", ""),
    SYNC_INTERVAL_MS: parseInt(get(env, "SYNC_INTERVAL_MS", "300000"), 10),
    // 5 minutes
    SYNC_SIMILARITY_THRESHOLD: parseFloat(get(env, "SYNC_SIMILARITY_THRESHOLD", "0.95")),
    DEVICE_ID: get(env, "DEVICE_ID", ""),
    DEVICE_ID_PATH: get(env, "DEVICE_ID_PATH", pathJoin(homedir2(), ".local", "share", "yapa", "device-id")),
    SYNC_PULL_OVERLAP_SECONDS: parseInt(get(env, "SYNC_PULL_OVERLAP_SECONDS", "120"), 10),
    SYNC_PUSH_DEBOUNCE_MS: parseInt(get(env, "SYNC_PUSH_DEBOUNCE_MS", "2000"), 10),
    SYNC_CA_CERT: get(env, "SYNC_CA_CERT", ""),
    HOOK_PULL_TIMEOUT_MS: parseInt(get(env, "HOOK_PULL_TIMEOUT_MS", "4000"), 10),
    HOOK_INJECT_RULES: get(env, "HOOK_INJECT_RULES", "false") === "true",
    RESPONSE_CAPTURE: get(env, "RESPONSE_CAPTURE", "false") === "true",
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
var SALIENCE_START, SALIENCE_BOOST_ON_ACCESS, SALIENCE_FLOOR, SALIENCE_MAX, CHUNK_SIZE, CHUNK_OVERLAP, active;
var init_config = __esm({
  "packages/core/src/config.ts"() {
    "use strict";
    SALIENCE_START = 1;
    SALIENCE_BOOST_ON_ACCESS = 0.1;
    SALIENCE_FLOOR = 0.05;
    SALIENCE_MAX = 5;
    CHUNK_SIZE = 2e3;
    CHUNK_OVERLAP = 200;
  }
});

// packages/core/src/metadata-adapter.ts
function toChroma(metadata) {
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === void 0) {
      continue;
    } else if (Array.isArray(value)) {
      result[key] = value.join(",");
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
  const arrayFields = ["tags", "depends_on", "blocks", "related_ids"];
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

// packages/core/src/embeddings.ts
async function getLocalPipeline() {
  if (!localPipeline) {
    const { pipeline, env } = await import("@huggingface/transformers");
    if (getConfig().MODEL_CACHE_DIR) env.cacheDir = getConfig().MODEL_CACHE_DIR;
    localPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  }
  return localPipeline;
}
async function embedLocal(text) {
  const pipe = await getLocalPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
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
async function fetchOpenAICompatible(url, apiKey, model, input) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input })
  });
  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.data.map((d) => d.embedding);
}
async function fetchVoyage(model, input) {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getConfig().VOYAGE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, input })
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
var localPipeline, MEMO_MAX, memo;
var init_embeddings = __esm({
  "packages/core/src/embeddings.ts"() {
    "use strict";
    init_config();
    localPipeline = null;
    MEMO_MAX = 64;
    memo = /* @__PURE__ */ new Map();
  }
});

// packages/core/src/chroma.ts
function apiBase() {
  return `${getConfig().CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database`;
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
async function chromaFetch(path, init) {
  const response = await fetch(`${apiBase()}${path}`, {
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
      deleteDocument: (col, id) => deleteDocument(col, id),
      findAndDeleteDocument: (id) => findAndDeleteDocument(id)
    };
  }
});

// packages/core/src/store/local-adapter.ts
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
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
  const writeChains = /* @__PURE__ */ new Map();
  const fileFor = (name) => join2(rootDir, `${encodeURIComponent(name)}.json`);
  async function readFromDisk(name) {
    try {
      const parsed = JSON.parse(await readFile(fileFor(name), "utf-8"));
      if (parsed.version !== 1) throw new Error(`unsupported version ${parsed.version}`);
      cache.set(name, parsed);
      cacheMtimes.set(name, (await stat(fileFor(name))).mtimeMs);
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
  async function load(name) {
    const cached2 = cache.get(name);
    if (!cached2) return readFromDisk(name);
    try {
      const st = await stat(fileFor(name));
      if (st.mtimeMs > (cacheMtimes.get(name) ?? 0)) return readFromDisk(name);
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
  async function loadOrCreate(name) {
    return await load(name) ?? {
      version: 1,
      name,
      created: (/* @__PURE__ */ new Date()).toISOString(),
      docs: {}
    };
  }
  function persist(cf) {
    const prev = writeChains.get(cf.name) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(rootDir, { recursive: true });
      const tmp = `${fileFor(cf.name)}.tmp`;
      await writeFile(tmp, JSON.stringify(cf));
      await rename(tmp, fileFor(cf.name));
      cacheMtimes.set(cf.name, (await stat(fileFor(cf.name))).mtimeMs);
    });
    writeChains.set(cf.name, next.catch(() => {
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
      if (await load(name)) throw new Error(`Collection "${name}" already exists`);
      const cf = await loadOrCreate(name);
      cache.set(name, cf);
      await persist(cf);
    },
    async deleteCollection(name) {
      cache.delete(name);
      writeChains.delete(name);
      await rm(fileFor(name), { force: true });
    },
    async getCollectionCount(name) {
      const cf = await load(name);
      return cf ? Object.keys(cf.docs).length : 0;
    },
    async getOrCreateCollection(name) {
      if (!await load(name)) {
        const cf = await loadOrCreate(name);
        cache.set(name, cf);
        await persist(cf);
      }
      return name;
    },
    async addDocument(collection, id, content, metadata) {
      const cf = await loadOrCreate(collection);
      cache.set(collection, cf);
      const embedding = await generateEmbedding(content);
      cf.docs[id] = {
        content,
        metadata: toChroma(metadata),
        embedding,
        embedding_model: embedderId()
      };
      await persist(cf);
    },
    async addDocumentsBatch(collection, documents) {
      const cf = await loadOrCreate(collection);
      cache.set(collection, cf);
      for (const d of documents) {
        cf.docs[d.id] = {
          content: d.content,
          metadata: toChroma(d.metadata),
          embedding: await generateEmbedding(d.content),
          embedding_model: embedderId()
        };
      }
      await persist(cf);
    },
    async queryDocuments(collection, queryText, nResults = 5, filter) {
      const cf = await load(collection);
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
        const cf = await load(name);
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
      const cf = await load(collection);
      if (!cf) return [];
      const out = [];
      for (const id of Object.keys(cf.docs)) {
        if (out.length >= limit) break;
        if (matchesFilter(cf.docs[id].metadata, filter)) out.push(toResult(cf, id));
      }
      return out;
    },
    async getDocumentsByIds(collection, ids) {
      const cf = await load(collection);
      if (!cf) return [];
      return ids.filter((id) => cf.docs[id]).map((id) => toResult(cf, id));
    },
    async updateDocument(collection, id, metadata) {
      const cf = await load(collection);
      if (!cf?.docs[id]) throw new Error(`Document "${id}" not found in collection "${collection}"`);
      cf.docs[id].metadata = toChroma(metadata);
      await persist(cf);
    },
    async updateDocumentsBatch(collection, entries) {
      if (entries.length === 0) return;
      const cf = await load(collection);
      if (!cf) throw new Error(`Collection "${collection}" not found`);
      let changed = 0;
      for (const e of entries) {
        if (!cf.docs[e.id]) continue;
        cf.docs[e.id].metadata = toChroma(e.metadata);
        changed++;
      }
      if (changed > 0) await persist(cf);
    },
    async deleteDocument(collection, id) {
      const cf = await load(collection);
      if (!cf) return;
      if (delete cf.docs[id]) await persist(cf);
    },
    async findAndDeleteDocument(id) {
      for (const name of await collectionNames()) {
        const cf = await load(name);
        if (cf?.docs[id]) {
          delete cf.docs[id];
          await persist(cf);
          return name;
        }
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
function getStore() {
  if (!active2) {
    active2 = getConfig().STORAGE === "local" ? createLocalStore(getConfig().LOCAL_STORE_PATH) : chromaStore;
  }
  return active2;
}
var active2, listCollections2, getOrCreateCollection2, addDocument2, addDocumentsBatch2, queryDocuments2, queryAllCollections2, getDocumentsByFilter2, getDocumentsByIds2, updateDocument2, deleteDocument2;
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
    getOrCreateCollection2 = (name) => getStore().getOrCreateCollection(name);
    addDocument2 = (collection, id, content, metadata) => getStore().addDocument(collection, id, content, metadata);
    addDocumentsBatch2 = (collection, documents) => getStore().addDocumentsBatch(collection, documents);
    queryDocuments2 = (collection, queryText, nResults, filter) => getStore().queryDocuments(collection, queryText, nResults, filter);
    queryAllCollections2 = (queryText, nResults, filter) => getStore().queryAllCollections(queryText, nResults, filter);
    getDocumentsByFilter2 = (collection, filter, limit) => getStore().getDocumentsByFilter(collection, filter, limit);
    getDocumentsByIds2 = (collection, ids) => getStore().getDocumentsByIds(collection, ids);
    updateDocument2 = (collection, id, metadata) => getStore().updateDocument(collection, id, metadata);
    deleteDocument2 = (collection, id) => getStore().deleteDocument(collection, id);
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

// packages/core/src/scope.ts
async function detectCollection(cwd, roots = getConfig().PROJECT_ROOTS, customers = getConfig().CUSTOMERS) {
  if (!cwd) return { collection: "global" };
  for (const rawRoot of roots) {
    const root = rawRoot.replace(/\/+$/, "");
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    const relative = cwd.slice(root.length).replace(/^\/+/, "");
    const segment = relative.split("/")[0];
    if (!segment || segment.startsWith(".")) return { collection: "global" };
    const existing = (await listCollections2().catch(() => [])).map((c) => c.name);
    const hasCustomer = existing.includes(`customer-${segment}`);
    const hasProject = existing.includes(`project-${segment}`);
    if (hasCustomer && hasProject) {
      return {
        collection: `project-${segment}`,
        ambiguous: [`project-${segment}`, `customer-${segment}`]
      };
    }
    if (hasCustomer) return { collection: `customer-${segment}` };
    if (hasProject) return { collection: `project-${segment}` };
    if (customers.includes(segment)) return { collection: `customer-${segment}` };
    return { collection: `project-${segment}` };
  }
  return { collection: "global" };
}
var init_scope = __esm({
  "packages/core/src/scope.ts"() {
    "use strict";
    init_config();
    init_store();
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
    await updateDocument2(collection, oldId, archivedMetadata(existing[0].metadata, { superseded_by: newId }));
  } catch (e) {
    process.stderr.write(`[yapa] store: failed to archive superseded ${oldId}: ${e}
`);
  }
}
async function storeMemory(content, options = {}) {
  const collection = options.collection ?? "global";
  await getOrCreateCollection2(collection);
  const potential_conflicts = await detectConflicts(collection, content);
  const now = Math.floor(Date.now() / 1e3);
  const sector = options.sector ?? detectSector(content);
  const salience = options.salience ?? SALIENCE_START;
  const chunks = chunkText(content);
  if (chunks.length === 1) {
    const id = `mem-${getConfig().USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata = {
      ...options.metadata ?? {},
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
    return { ids: [id], potential_conflicts };
  }
  const baseId = `mem-${getConfig().USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const docs = chunks.map((chunk2) => {
    const chunkMeta = {
      ...options.metadata ?? {},
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
async function recallMemory(query, options = {}) {
  const nResults = options.nResults ?? 5;
  const includePromoted = options.include_promoted ?? false;
  const filter = { type: "memory" };
  let results;
  if (options.collection) {
    const docs = await queryDocuments2(options.collection, query, nResults, filter);
    results = docs.map((d) => ({ ...d, collection: options.collection }));
    const extra = options.crossCollection ?? 0;
    if (extra > 0) {
      const maxDistance = getConfig().CROSS_COLLECTION_MAX_DISTANCE;
      const others = (await queryAllCollections2(query, nResults + extra * 4, filter).catch(() => [])).filter((r) => r.collection !== options.collection && r.distance < maxDistance && r.metadata.archived !== true).slice(0, extra);
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
      updateDocument2(r.collection, r.id, { ...r.metadata, ...boosted }).catch(() => {
      });
    }
  }
  return results;
}
var init_recall = __esm({
  "packages/core/src/memory/recall.ts"() {
    "use strict";
    init_store();
    init_config();
    init_lifecycle();
    init_filters();
  }
});

// packages/core/src/sync/deletes.ts
async function getLocalTombstones() {
  try {
    const results = await getDocumentsByFilter2("global", { type: "sync_tombstones" }, 1);
    const raw = results[0]?.metadata.ids;
    return new Set(typeof raw === "string" ? raw.split(",").filter(Boolean) : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
var init_deletes = __esm({
  "packages/core/src/sync/deletes.ts"() {
    "use strict";
    init_store();
  }
});

// packages/core/src/memory/forget.ts
var init_forget = __esm({
  "packages/core/src/memory/forget.ts"() {
    "use strict";
    init_config();
    init_store();
    init_deletes();
  }
});

// packages/core/src/memory/list.ts
async function listMemories(options = {}) {
  const limit = options.limit ?? 50;
  const includePromoted = options.include_promoted ?? false;
  const filter = { type: "memory" };
  if (options.sector) filter.sector = options.sector;
  const collectionNames = options.collection ? [options.collection] : (await listCollections2()).map((c) => c.name);
  const allResults = [];
  for (const name of collectionNames) {
    try {
      const docs = await getDocumentsByFilter2(name, filter, limit);
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

// packages/core/src/memory/decay.ts
var init_decay = __esm({
  "packages/core/src/memory/decay.ts"() {
    "use strict";
    init_store();
    init_lifecycle();
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
var init_compact = __esm({
  "packages/core/src/memory/compact.ts"() {
    "use strict";
    init_config();
    init_archive();
    init_store();
    init_store2();
  }
});

// packages/core/src/memory/journal.ts
import { randomBytes } from "crypto";
async function listSessionDrafts(collection, sessionId) {
  const col = collection ?? "global";
  const sid = sessionId ?? SESSION_ID;
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
async function journalConsolidate(input = {}) {
  const col = input.collection ?? "global";
  const sid = input.sessionId ?? SESSION_ID;
  const drafts = await listSessionDrafts(col, sid);
  if (drafts.length === 0) return null;
  const body = input.summary ? input.summary : drafts.map((d) => `- ${d.entry}`).join("\n");
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
    SESSION_ID = process.env.YAPA_SESSION_ID ?? `${Date.now()}-${randomBytes(4).toString("hex")}`;
    DRAFT_TYPE = "journal_draft";
  }
});

// packages/core/src/sync/device.ts
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function getDeviceId() {
  const config = getConfig();
  if (config.DEVICE_ID) return config.DEVICE_ID;
  if (cached?.path === config.DEVICE_ID_PATH) return cached.id;
  const path = config.DEVICE_ID_PATH;
  let id;
  try {
    id = readFileSync2(path, "utf-8").trim();
  } catch {
    id = "";
  }
  if (!id) {
    id = randomUUID();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${id}
`, { flag: "wx" });
    } catch {
      try {
        id = readFileSync2(path, "utf-8").trim() || id;
      } catch {
      }
    }
  }
  cached = { path, id };
  return id;
}
var cached;
var init_device = __esm({
  "packages/core/src/sync/device.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/sync/http-backend.ts
var http_backend_exports = {};
__export(http_backend_exports, {
  HttpBackend: () => HttpBackend,
  IdTokenProvider: () => IdTokenProvider,
  ServiceError: () => ServiceError,
  decodeJwtPayload: () => decodeJwtPayload,
  redactTokens: () => redactTokens
});
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, rmSync, renameSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
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
function runTokenCommand(cmd) {
  return new Promise((resolve, reject) => {
    const done = (err, stdout, stderr) => {
      if (err) {
        const detail = redactTokens(String(stderr || err.message).trim().split("\n").filter(Boolean).slice(-2).join(" ")).slice(0, 300);
        reject(new Error(`could not get a Google ID token from \`${cmd || "gcloud auth print-identity-token"}\`: ${detail}. Run \`gcloud auth login\` (or fix YAPA_SYNC_ID_TOKEN_CMD).`));
        return;
      }
      resolve(String(stdout));
    };
    const opts = { timeout: TOKEN_CMD_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 };
    if (cmd) exec(cmd, opts, done);
    else execFile("gcloud", ["auth", "print-identity-token"], { ...opts, shell: process.platform === "win32" }, done);
  });
}
function explain(status, code, message) {
  switch (code) {
    case "unauthenticated":
      return "the sync service rejected the sign-in (401). Run `gcloud auth login` (or check YAPA_SYNC_ID_TOKEN_CMD).";
    case "not_member":
      return "your Google account is not mapped to a YAPA user; ask a YAPA admin to add you.";
    case "user_inactive":
      return "your YAPA user is disabled; ask a YAPA admin.";
    case "rate_limited":
      return `rate limited by the sync service (${message}); sync retries next cycle.`;
    case "unavailable":
      return "the sync service is temporarily unavailable; local changes stay unsynced and retry next cycle.";
    case "cloud_run_forbidden":
      return "Cloud Run refused the request (403): your Google account has no access to the sync service (roles/run.invoker). Ask a YAPA admin, then `gcloud auth login` with that account.";
    case "cloud_run_unauthenticated":
      return "Cloud Run rejected the ID token (401). Run `gcloud auth login`.";
    default:
      return `sync service error ${status} ${code}: ${message}`;
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
var REFRESH_MARGIN_MS, OPAQUE_TOKEN_TTL_MS, TOKEN_CMD_TIMEOUT_MS, MAX_UPSERT_DOCS, MAX_UPSERT_BODY_BYTES, MAX_DELETE_IDS, MAX_LOOKUP_IDS, MAX_RELATED_IDS, PULL_PAGE_LIMIT, PERMANENT_ITEM_ERRORS, IdTokenProvider, ServiceError, HttpBackend;
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
      "not_owner"
    ]);
    IdTokenProvider = class {
      constructor(cmd = "", now = Date.now, cachePath = "") {
        this.now = now;
        this.cachePath = cachePath;
        this.run = typeof cmd === "function" ? cmd : () => runTokenCommand(cmd);
      }
      now;
      cachePath;
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
        if (this.cachePath) rmSync(this.cachePath, { force: true });
      }
      validity(token, now) {
        const exp = Number(decodeJwtPayload(token)?.exp);
        if (!Number.isFinite(exp) || exp <= 0) return now + OPAQUE_TOKEN_TTL_MS;
        const life = exp * 1e3 - now;
        return now + (life > 2 * REFRESH_MARGIN_MS ? life - REFRESH_MARGIN_MS : Math.max(0, life / 2));
      }
      /** Adopt a still-valid token cached by an earlier process (JWTs with `exp` only). */
      loadCached() {
        if (!this.cachePath) return false;
        try {
          const token = readFileSync3(this.cachePath, "utf-8").trim();
          if (!token || !Number.isFinite(Number(decodeJwtPayload(token)?.exp))) return false;
          const until = this.validity(token, this.now());
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
          mkdirSync2(dirname2(this.cachePath), { recursive: true, mode: 448 });
          const tmp = `${this.cachePath}.${process.pid}.tmp`;
          writeFileSync2(tmp, token, { mode: 384 });
          renameSync(tmp, this.cachePath);
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
      constructor(message, status, code, requestId, details = {}) {
        super(message);
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
    HttpBackend = class {
      kind = "service";
      capabilities = { deletionsFeed: true };
      target;
      tokens;
      timeoutMs;
      device;
      meCache;
      constructor(opts = {}) {
        const config = getConfig();
        this.target = (opts.baseUrl ?? config.SYNC_SERVICE_URL).replace(/\/+$/, "");
        if (!/^https?:\/\//.test(this.target)) throw new Error(`sync service URL must start with https:// (got "${this.target}")`);
        this.tokens = opts.tokens ?? new IdTokenProvider(config.SYNC_ID_TOKEN_CMD, Date.now, config.SYNC_ID_TOKEN_CACHE);
        this.timeoutMs = opts.timeoutMs ?? config.SYNC_HTTP_TIMEOUT_MS;
        this.device = opts.device ?? getDeviceId;
      }
      fail(err) {
        noteSyncError(err);
        throw err;
      }
      async request(method, path, opts = {}) {
        const url = `${this.target}${path}`;
        const idemKey = opts.idempotent ? randomUUID2() : void 0;
        const body = opts.body === void 0 ? void 0 : JSON.stringify(opts.body);
        for (let attempt = 0; ; attempt++) {
          let token;
          try {
            token = await this.tokens.get();
          } catch (e) {
            return this.fail(new ServiceError(e instanceof Error ? e.message : String(e), 0, "token_command"));
          }
          const headers = {
            authorization: `Bearer ${token}`,
            "x-yapa-id-token": token,
            "x-yapa-device": this.device(),
            accept: "application/json"
          };
          if (body !== void 0) headers["content-type"] = "application/json";
          if (idemKey) headers["idempotency-key"] = idemKey;
          let res;
          try {
            res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
          } catch (e) {
            const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : redactTokens(String(e?.cause?.message ?? e?.message ?? e));
            return this.fail(new ServiceError(`sync service unreachable (${new URL(this.target).host}): ${why}`, 0, "unreachable"));
          }
          const text = await res.text().catch(() => "");
          let json;
          try {
            json = text ? JSON.parse(text) : void 0;
          } catch {
            json = void 0;
          }
          if (res.ok) return json;
          if (res.status === 404 && opts.allow404) return void 0;
          const apiErr = json?.error;
          const code = apiErr?.code ?? (res.status === 401 ? "cloud_run_unauthenticated" : res.status === 403 ? "cloud_run_forbidden" : `http_${res.status}`);
          if (res.status === 401 && attempt === 0) {
            this.tokens.invalidate();
            continue;
          }
          const message = redactTokens(String(apiErr?.message ?? res.statusText ?? "")).slice(0, 300);
          const details = { ...apiErr?.details ?? {} };
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) details.retry_after = Number(retryAfter);
          return this.fail(new ServiceError(explain(res.status, code, message), res.status, code, apiErr?.request_id, details));
        }
      }
      /** GET /v1/me, cached per process until the token is re-minted. */
      async me(refresh = false) {
        if (!this.meCache || refresh || this.meCache.generation !== this.tokens.generation) {
          const r = await this.request("GET", "/v1/me");
          this.meCache = { username: r.username, email: r.email, generation: this.tokens.generation };
        }
        return { username: this.meCache.username, email: this.meCache.email };
      }
      identity() {
        return this.me();
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
          deletions: r.deletions ?? [],
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
        const note = syncUsernameNote();
        if (note) process.stderr.write(`[yapa-sync] ${note}
`);
      }
      async maintain() {
      }
      async describe() {
        const lines = ["Backend: YAPA sync service", `Service: ${this.target}`];
        try {
          const me = await this.me(true);
          applyServerUsername(me.username);
          lines.push(`Signed in as: ${me.username} (${me.email})`);
          const note = syncUsernameNote();
          if (note) lines.push(note);
          lines.push("Connection: healthy");
        } catch (e) {
          lines.push(`Connection: error - ${e instanceof Error ? e.message : e}`);
        }
        return lines;
      }
      async close() {
        this.tokens.invalidate();
        this.meCache = void 0;
      }
    };
  }
});

// packages/core/src/sync/postgres.ts
import { readFileSync as readFileSync4 } from "node:fs";
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
      return { connectionString: databaseUrl, ssl: { ca: readFileSync4(caCertPath, "utf-8"), rejectUnauthorized: true, checkServerIdentity: () => void 0 }, tls: "verify-ca" };
    }
    return { connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, tls: "unverified" };
  }
  const sslmode = url.searchParams.get("sslmode");
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(k);
  const connectionString = url.toString();
  const verified = () => ({
    connectionString,
    ssl: { ca: readFileSync4(caCertPath, "utf-8"), rejectUnauthorized: true, checkServerIdentity: () => void 0 },
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
  const local = hostParam ? hostParam.startsWith("/") || LOCAL_HOSTS.has(hostParam) : LOCAL_HOSTS.has(url.hostname);
  if (local) return { connectionString, ssl: false, tls: "off" };
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
function buildRemoteDocsSinceQuery(collection, sinceTimestamp, self, opts = {}) {
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
    userParam = param(self.user);
    const deviceParam = param(self.device);
    text += `
       AND COALESCE(metadata->>'origin_device', '') <> ${deviceParam}
       AND NOT (origin_user = ${userParam} AND metadata->>'origin_device' IS NULL)`;
  }
  if (opts.onlyOwnRows) text += `
       AND origin_user = ${userParam ?? param(self.user)}`;
  text += `
     ORDER BY synced_at ASC`;
  return { text, values };
}
async function getRemoteDocsSince(collection, sinceTimestamp, self, opts = {}) {
  const p = getPool();
  const query = buildRemoteDocsSinceQuery(collection, sinceTimestamp, self, opts);
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

// packages/core/src/sync/backend.ts
function syncBackendKind(config = getConfig()) {
  if (config.SYNC_SERVICE_URL) return "service";
  if (config.SYNC_DATABASE_URL) return "postgres";
  return void 0;
}
function isSyncConfigured(config = getConfig()) {
  return config.SYNC_ENABLED && syncBackendKind(config) !== void 0;
}
function keyOf(config) {
  return JSON.stringify([config.SYNC_SERVICE_URL, config.SYNC_ID_TOKEN_CMD, config.SYNC_DATABASE_URL, config.SYNC_CA_CERT, config.SYNC_HTTP_TIMEOUT_MS]);
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
  const backend = kind === "service" ? new (await Promise.resolve().then(() => (init_http_backend(), http_backend_exports))).HttpBackend() : new (await Promise.resolve().then(() => (init_postgres_backend(), postgres_backend_exports))).PostgresBackend();
  active3 = { key, backend };
  return backend;
}
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
function noteSyncError(e) {
  lastError = { message: e instanceof Error ? e.message : String(e), at: Date.now() };
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
    "token_command"
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
function syncUsernameNote() {
  if (!serverUsername || !configuredUsername || configuredUsername === serverUsername) return void 0;
  return `Username: using '${serverUsername}' from your Google account (the username option '${configuredUsername}' is informational with the sync service)`;
}
var override, active3, lastError, serverUsername, configuredUsername;
var init_backend = __esm({
  "packages/core/src/sync/backend.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/tasks/create.ts
var init_create = __esm({
  "packages/core/src/tasks/create.ts"() {
    "use strict";
    init_config();
    init_store();
    init_backend();
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
      const tasks = await getDocumentsByFilter2(name, where, 100);
      for (const task of tasks) {
        if (!filters.includeComplete && task.metadata.status === "complete") continue;
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
  return allTasks.sort((a, b) => {
    const pA = PRIORITY_ORDER[a.metadata.priority] ?? 0;
    const pB = PRIORITY_ORDER[b.metadata.priority] ?? 0;
    if (pB !== pA) return pB - pA;
    return (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0);
  });
}
var PRIORITY_ORDER;
var init_list2 = __esm({
  "packages/core/src/tasks/list.ts"() {
    "use strict";
    init_store();
    PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };
  }
});

// packages/core/src/tasks/update.ts
var init_update = __esm({
  "packages/core/src/tasks/update.ts"() {
    "use strict";
    init_config();
    init_store();
    init_create();
  }
});

// packages/core/src/tasks/search.ts
var init_search = __esm({
  "packages/core/src/tasks/search.ts"() {
    "use strict";
    init_store();
  }
});

// packages/core/src/tasks/delete.ts
var init_delete = __esm({
  "packages/core/src/tasks/delete.ts"() {
    "use strict";
    init_forget();
  }
});

// packages/core/src/tasks/dependencies.ts
var init_dependencies = __esm({
  "packages/core/src/tasks/dependencies.ts"() {
    "use strict";
    init_update();
  }
});

// packages/core/src/tasks/dates.ts
var init_dates = __esm({
  "packages/core/src/tasks/dates.ts"() {
    "use strict";
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
var SYNC_SUBSCRIPTIONS_ID;
var init_sentinel = __esm({
  "packages/core/src/sync/sentinel.ts"() {
    "use strict";
    init_store();
    SYNC_SUBSCRIPTIONS_ID = "__sync_subscriptions__";
  }
});

// packages/core/src/sync/syncable.ts
function isSyncableCollection(name) {
  return name !== "global" && !name.startsWith("private-") && !name.startsWith("local-");
}
var init_syncable = __esm({
  "packages/core/src/sync/syncable.ts"() {
    "use strict";
  }
});

// packages/core/src/collections/manage.ts
var init_manage = __esm({
  "packages/core/src/collections/manage.ts"() {
    "use strict";
    init_config();
    init_deletes();
    init_sentinel();
    init_store();
    init_syncable();
  }
});

// packages/core/src/curation/provider.ts
import { spawn } from "node:child_process";
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
  return new Promise((resolve, reject) => {
    const child = spawn("claude", buildClaudeCliArgs(model, system), {
      env: { ...process.env, [HOOK_CHILD_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
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
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
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
var init_prompts = __esm({
  "packages/core/src/curation/prompts.ts"() {
    "use strict";
  }
});

// packages/core/src/curation/classifier.ts
var init_classifier = __esm({
  "packages/core/src/curation/classifier.ts"() {
    "use strict";
    init_provider();
    init_prompts();
  }
});

// packages/core/src/curation/index.ts
var init_curation = __esm({
  "packages/core/src/curation/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_classifier();
  }
});

// packages/core/src/curation/extractor.ts
function buildExtractorUserPrompt(input) {
  const lines = [
    `Scope/collection: ${input.collection}`,
    "",
    "[USER MESSAGE]",
    input.userText.trim() || "(none \u2014 injected or continuation turn)",
    "",
    "[ASSISTANT RESPONSE]",
    input.assistantText.trim()
  ];
  return lines.join("\n");
}
async function extractMemories(input, options = {}) {
  if (!input.assistantText.trim()) return [];
  const caller = options.call ?? callCurationLLM;
  const raw = await caller({
    messages: [
      { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
      { role: "user", content: buildExtractorUserPrompt(input) }
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
  const parsed = extractJsonArray(raw);
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
    results.push({
      content: content.trim(),
      tags,
      sector: entry.sector === "episodic" ? "episodic" : "semantic",
      salience: clampSalience(entry.salience),
      rationale: typeof entry.rationale === "string" ? entry.rationale : ""
    });
  }
  return results;
}
function clampSalience(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(3, n));
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
  throw new Error(`Could not extract JSON array from extractor response: ${raw.slice(0, 200)}`);
}
var EXTRACTOR_PROMPT_VERSION, EXTRACTOR_SYSTEM_PROMPT;
var init_extractor = __esm({
  "packages/core/src/curation/extractor.ts"() {
    "use strict";
    init_provider();
    EXTRACTOR_PROMPT_VERSION = "v1";
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

OUTPUT FORMAT
Return valid JSON only. No commentary. No markdown fences. A JSON array of candidates:
[
  {
    "content": "<the self-contained memory text>",
    "tags": ["<tag>"],
    "sector": "semantic" | "episodic",
    "salience": <number 1.0-3.0>,
    "rationale": "<one short sentence: why this is durable>"
  }
]
If nothing qualifies, return exactly: []`;
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
var init_janitor = __esm({
  "packages/core/src/curation/janitor.ts"() {
    "use strict";
    init_archive();
    init_config();
    init_store();
    init_store2();
    init_resolver();
  }
});

// packages/core/src/curation/capture.ts
async function captureTurn(input, options, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const { collection, sessionId, turn } = input;
  const candidates = await d.extractMemories(
    {
      collection,
      userText: input.userText.slice(0, MAX_EXTRACT_CHARS),
      assistantText: input.assistantText.slice(0, MAX_EXTRACT_CHARS)
    },
    { maxMemories: options.maxMemories }
  );
  if (!candidates.length) return { stored: 0, skipped: 0, superseded: 0 };
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
      if (decision.action === "supersede" && decision.targetId) {
        supersedes = decision.targetId;
        content = decision.mergedContent ?? candidate.content;
        resolverRationale = decision.rationale;
      }
    }
    await d.storeMemory(content, {
      collection,
      tags: [.../* @__PURE__ */ new Set([...candidate.tags, "auto-capture"])],
      salience: Math.min(candidate.salience, options.maxSalience),
      sector: candidate.sector,
      supersedes,
      metadata: {
        source: "auto-capture",
        session_id: sessionId,
        turn,
        extractor_prompt_version: EXTRACTOR_PROMPT_VERSION,
        rationale: candidate.rationale,
        ...resolverRationale !== void 0 && {
          resolver_prompt_version: RESOLVER_PROMPT_VERSION,
          resolver_rationale: resolverRationale
        }
      }
    });
    stored++;
    if (supersedes) superseded++;
  }
  let notice;
  if (stored > 0 || skipped > 0) {
    notice = `Auto-captured ${stored} ${stored === 1 ? "memory" : "memories"} from last turn` + (superseded ? `, ${superseded} superseding stale ${superseded === 1 ? "memory" : "memories"}` : "") + (skipped ? ` (${skipped} skipped as already known)` : "") + ` \u2192 \`${collection}\``;
    d.log(`${notice} [session ${sessionId}, turn ${turn}]`);
  }
  return { stored, skipped, superseded, notice };
}
var MAX_EXTRACT_CHARS, defaultDeps;
var init_capture = __esm({
  "packages/core/src/curation/capture.ts"() {
    "use strict";
    init_store();
    init_store2();
    init_extractor();
    init_resolver();
    MAX_EXTRACT_CHARS = 12e3;
    defaultDeps = {
      extractMemories,
      queryDocuments: queryDocuments2,
      resolveConflict,
      storeMemory,
      log: (msg) => process.stderr.write(`[yapa] ${msg}
`)
    };
  }
});

// packages/core/src/buckets/artifacts.ts
var init_artifacts = __esm({
  "packages/core/src/buckets/artifacts.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/buckets/router.ts
var init_router = __esm({
  "packages/core/src/buckets/router.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/buckets/system-prompt.ts
var init_system_prompt = __esm({
  "packages/core/src/buckets/system-prompt.ts"() {
    "use strict";
    init_artifacts();
  }
});

// packages/core/src/buckets/training-manifest.ts
var init_training_manifest = __esm({
  "packages/core/src/buckets/training-manifest.ts"() {
    "use strict";
    init_artifacts();
  }
});

// packages/core/src/buckets/index.ts
var init_buckets = __esm({
  "packages/core/src/buckets/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_artifacts();
    init_router();
    init_system_prompt();
    init_training_manifest();
  }
});

// packages/core/src/sync/push.ts
var init_push = __esm({
  "packages/core/src/sync/push.ts"() {
    "use strict";
    init_config();
    init_store();
    init_embeddings();
    init_backend();
    init_deletes();
    init_sentinel();
    init_device();
    init_syncable();
  }
});

// packages/core/src/sync/pull.ts
function emptyPullStats() {
  return { pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, keptDirty: 0, errors: 0 };
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
  const [existing] = await getDocumentsByIds2(collectionName, [del.id]).catch(() => []);
  if (!existing) return;
  if (existing.metadata.is_synced === false) {
    stats.keptDirty++;
    process.stderr.write(`[yapa-sync] ${del.id} was deleted remotely by ${del.deleted_by}, but this copy has unpushed edits: kept (it will be pushed again)
`);
    return;
  }
  await deleteDocument2(collectionName, del.id);
  stats.deleted++;
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
  const local = (await getDocumentsByFilter2(collectionName, {}, 1e5)).filter((d) => !d.id.startsWith("__") && d.metadata.type !== "journal_draft" && d.metadata.is_synced !== false);
  if (local.length === 0) return;
  const remote = await backend.collectionsByIds(local.map((d) => d.id));
  for (const doc of local) {
    const now = remote.get(doc.id);
    if (!now || now === collectionName || followed.has(now)) continue;
    await deleteDocument2(collectionName, doc.id);
    stats.moved++;
  }
}
async function applyRemoteDoc(backend, collectionName, remoteDoc, stats) {
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
    const localDirty = existing.metadata.is_synced === false;
    const localUpdated = toUnixSeconds(existing.metadata.updated_at ?? existing.metadata.created_at);
    if (!localDirty && toUnixSeconds(remoteDoc.updated_at) > localUpdated) {
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
        const localDoc = similarLocal[0];
        const localRelated = Array.isArray(localDoc.metadata.related_ids) ? localDoc.metadata.related_ids : [];
        if (!localRelated.includes(remoteDoc.id)) {
          localRelated.push(remoteDoc.id);
          await updateDocument2(collectionName, localDoc.id, { ...localDoc.metadata, related_ids: localRelated });
        }
        await backend.addRelatedIds(remoteDoc.id, [localDoc.id]).catch((e) => {
          process.stderr.write(`[yapa-sync] Link error for ${remoteDoc.id}: ${e}
`);
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
    init_config();
    init_store();
    init_backend();
    init_sentinel();
    init_deletes();
    init_syncable();
    MAX_PULL_PAGES = 200;
  }
});

// packages/core/src/sync/index.ts
var init_sync = __esm({
  "packages/core/src/sync/index.ts"() {
    "use strict";
    init_config();
    init_push();
    init_pull();
    init_backend();
  }
});

// packages/core/src/training/fireworks.ts
var init_fireworks = __esm({
  "packages/core/src/training/fireworks.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/training/registry.ts
var init_registry = __esm({
  "packages/core/src/training/registry.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/training/synthesis.ts
var init_synthesis = __esm({
  "packages/core/src/training/synthesis.ts"() {
    "use strict";
    init_config();
    init_provider();
  }
});

// packages/core/src/training/index.ts
var init_training = __esm({
  "packages/core/src/training/index.ts"() {
    "use strict";
    init_config();
    init_store();
    init_artifacts();
    init_fireworks();
    init_registry();
    init_synthesis();
  }
});

// packages/core/src/training/backend.ts
var init_backend2 = __esm({
  "packages/core/src/training/backend.ts"() {
    "use strict";
  }
});

// packages/core/src/training/inference.ts
var init_inference = __esm({
  "packages/core/src/training/inference.ts"() {
    "use strict";
    init_config();
  }
});

// packages/core/src/training/judge.ts
var init_judge = __esm({
  "packages/core/src/training/judge.ts"() {
    "use strict";
    init_provider();
  }
});

// packages/core/src/training/holdout.ts
var init_holdout = __esm({
  "packages/core/src/training/holdout.ts"() {
    "use strict";
    init_config();
    init_synthesis();
  }
});

// packages/core/src/training/eval.ts
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
var init_promotion = __esm({
  "packages/core/src/training/promotion.ts"() {
    "use strict";
    init_store();
    init_registry();
  }
});

// packages/core/src/training/verification.ts
var init_verification = __esm({
  "packages/core/src/training/verification.ts"() {
    "use strict";
    init_config();
    init_artifacts();
    init_store();
    init_inference();
    init_judge();
    init_synthesis();
  }
});

// packages/core/src/index.ts
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
    init_http_backend();
    init_postgres_backend();
    init_pull();
    init_syncable();
    init_push();
    init_deletes();
    init_sentinel();
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
The injected \`**Scope:**\` line names the active collection (\`customer-{name}\`, \`project-{name}\`, or \`global\`). If it is flagged AMBIGUOUS, ask the user which collection to use BEFORE storing anything. Always pass the collection explicitly when storing. Recall searches the active collection plus a few strongly relevant hits from other customers/projects (labeled \`from <collection>\`): when troubleshooting, check whether another account already hit the same issue, and say where an answer came from. Before creating a new collection, confirm the name with the user (\`collection_list\` shows what exists). \`private-*\`, \`local-*\` and \`global\` collections never sync (\`global\` is personal; team-wide knowledge goes in a shared collection).

### Capture as you go (do not batch to the end)
Call \`memory_store\` (salience >= 2.0) when: a bug's root cause is identified; a config value, env var, endpoint, or credential location is learned; the user states a preference, decision, or correction; a non-obvious technical fact is discovered; a solution took real effort; a decision or commitment surfaces.
\`memory_store\` returns \`potential_conflicts\`: decide supersede (re-store with \`supersedes: "<old id>"\`) or coexist before moving on. Reserve \`memory_forget\` for memories that should never have existed (forgetting a teammate's memory only removes it for you).
Do not store ephemeral conversation state, obvious code patterns, or anything already in git history or an existing memory.

### Tasks
Call \`task_create\` in the active collection BEFORE starting multi-step or long-lived work, when a follow-up is identified, or when something can't finish this turn. On completion \`task_complete\` (pass \`duration\` for hands-on effort when known); on a blocker \`task_update\` with status \`blocked\` and a reason; on scope change amend the task instead of duplicating it. Items marked "by <user>" were written by a teammate (for their tasks, coordinate before changing them); "from <collection>" marks a hit from another customer or project.

### Journal
Call \`journal_append\` with a one-line note when a meaningful step completes. Drafts are consolidated into a \`journal\` memory automatically when the session ends.

### Memory compaction
When the injected context lists a "compaction candidate", call \`compaction_suggest\` for it, write a rolling summary per group, and submit with \`compaction_apply\`.

### Storage errors
If a yapa tool fails with a storage or sync error, do not swallow it: tell the user, and use \`sync\` (action \`status\`) to diagnose remote problems.
`;
  }
});

// packages/mcp/src/cli/hooks.ts
var hooks_exports = {};
__export(hooks_exports, {
  attribution: () => attribution,
  freshenFromRemote: () => freshenFromRemote,
  postCompact: () => postCompact,
  reloadConfig: () => reloadConfig,
  sessionEnd: () => sessionEnd,
  sessionStart: () => sessionStart,
  stop: () => stop,
  userPromptSubmit: () => userPromptSubmit
});
import { mkdirSync as mkdirSync3, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}
function context(event, lines) {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } });
}
function scopeLine(d) {
  if (!d.ambiguous) return `**Scope:** \`${d.collection}\``;
  return `**Scope:** AMBIGUOUS \u2014 both \`${d.ambiguous[0]}\` and \`${d.ambiguous[1]}\` exist for this folder. Ask the user which collection to use BEFORE storing anything. (Reads here default to \`${d.collection}\`.)`;
}
function attribution(metadata) {
  const who = metadata?.origin_user;
  return who && who !== getConfig().USERNAME ? `, by ${who}` : "";
}
function withTimeout(work, ms) {
  return Promise.race([work, new Promise((resolve) => setTimeout(() => resolve(void 0), ms).unref())]);
}
async function freshenFromRemote(collection) {
  const config = getConfig();
  if (!isSyncConfigured(config)) return 0;
  if (!isSyncableCollection(collection)) return 0;
  try {
    const followed = (await getSyncSubscriptions()).includes(collection);
    const since = followed ? Math.max(0, await getSyncPullTimestamp() - HOOK_PULL_OVERLAP_SECONDS) : 0;
    const stats = await withTimeout(resolveSyncUsername().then(() => pullCollection(collection, since)), config.HOOK_PULL_TIMEOUT_MS);
    if (!stats) {
      process.stderr.write(`[yapa-hook] remote pull for ${collection} timed out
`);
      return 0;
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
function stateDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join3(tmpdir(), `yapa-hooks-${process.getuid?.() ?? "user"}`);
  const dir = join3(base, "sessions");
  mkdirSync3(dir, { recursive: true });
  return dir;
}
function stateFile(sessionId, kind) {
  return join3(stateDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.${kind}`);
}
function readTurn(sessionId) {
  try {
    return JSON.parse(readFileSync5(stateFile(sessionId, "turn"), "utf-8"));
  } catch {
    return void 0;
  }
}
function recordPrompt(sessionId, prompt) {
  if (!sessionId) return;
  try {
    const turn = (readTurn(sessionId)?.turn ?? 0) + 1;
    writeFileSync3(stateFile(sessionId, "turn"), JSON.stringify({ prompt, turn }));
  } catch (e) {
    process.stderr.write(`[yapa-hook] could not buffer prompt: ${e}
`);
  }
}
function takeNotice(sessionId) {
  if (!sessionId) return void 0;
  const file = stateFile(sessionId, "notice");
  try {
    const notice = readFileSync5(file, "utf-8").trim();
    rmSync2(file, { force: true });
    return notice || void 0;
  } catch {
    return void 0;
  }
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
async function sessionStart(input) {
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;
  const pulled = await freshenFromRemote(collection);
  const lines = [];
  if (getConfig().HOOK_INJECT_RULES) lines.push(CLAUDE_CODE_RULES, "");
  lines.push("# YAPA Context", "", scopeLine(detection));
  if (pulled) lines.push(`_Pulled ${pulled} new or updated item(s) from the team sync._`);
  const notice = takeNotice(input.session_id);
  if (notice) lines.push(`_${notice}_`);
  try {
    const tasks = await listTasks({ collection, includeComplete: false });
    if (tasks.length) {
      lines.push("", "## Open tasks");
      for (const t of tasks.slice(0, 10)) {
        const status = t.metadata.status ?? "open";
        const prio = t.metadata.priority ? `, ${t.metadata.priority}` : "";
        lines.push(`- **${t.id}** [${status}${prio}${attribution(t.metadata)}] ${t.title}`);
      }
      if (tasks.length > 10) lines.push(`- _\u2026${tasks.length - 10} more (call \`task_list\` for the full list)_`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] task_list failed: ${e}
`);
  }
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
  if (input.source !== "compact") {
    await withTimeout(consolidateStaleDrafts().catch(() => []), STALE_JOURNAL_BUDGET_MS);
  }
  lines.push(
    "",
    "_Hooks ran recall + task_list automatically. You do not need to repeat these unless you need a more specific query._"
  );
  context("SessionStart", lines);
}
async function userPromptSubmit(input) {
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) {
    emit({});
    return;
  }
  recordPrompt(input.session_id, prompt);
  await freshenFromRemote(collection);
  const lines = ["# YAPA Recall", "", `${scopeLine(detection)}  **Query:** ${prompt.slice(0, 120)}${prompt.length > 120 ? "\u2026" : ""}`];
  const notice = takeNotice(input.session_id);
  if (notice) lines.push(`_${notice}_`);
  try {
    const recall = await recallMemory(prompt, { collection, nResults: 3, crossCollection: getConfig().CROSS_COLLECTION_RESULTS });
    if (recall.length === 0 && !notice) {
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
async function stop(input) {
  emit({});
  const config = getConfig();
  if (!config.RESPONSE_CAPTURE || input.stop_hook_active || !input.session_id) return;
  const assistantText = (input.last_assistant_message ?? "").trim();
  const turn = readTurn(input.session_id);
  const userText = turn?.prompt ?? "";
  if (!assistantText || userText.length + assistantText.length < config.CAPTURE_MIN_CHARS) return;
  if (config.CURATION_LLM_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY) {
    setConfig({ ...config, CURATION_LLM_PROVIDER: "claude-cli", CURATION_MODEL: config.CURATION_MODEL || "haiku" });
  }
  try {
    const { collection } = await detectCollection(input.cwd);
    const result = await captureTurn(
      { collection, sessionId: input.session_id, turn: turn?.turn ?? 0, userText, assistantText },
      { maxMemories: config.CAPTURE_MAX_MEMORIES, maxSalience: config.CAPTURE_MAX_SALIENCE, dedupeDistance: config.CAPTURE_DEDUPE_DISTANCE }
    );
    if (result.notice) writeFileSync3(stateFile(input.session_id, "notice"), result.notice);
  } catch (e) {
    process.stderr.write(`[yapa-hook] response capture failed (non-fatal): ${e}
`);
  }
}
async function postCompact(input) {
  emit({});
  const summary = (input.compact_summary ?? "").trim();
  if (!getConfig().CAPTURE_COMPACTION || !summary) return;
  try {
    const { collection } = await detectCollection(input.cwd);
    await storeMemory(`# Conversation compaction summary

${summary}`, {
      collection,
      tags: ["compaction", "journal"],
      salience: 1.5,
      sector: "episodic",
      metadata: { source: "compaction", session_id: input.session_id, trigger: input.trigger }
    });
  } catch (e) {
    process.stderr.write(`[yapa-hook] compaction capture failed (non-fatal): ${e}
`);
  }
}
async function sessionEnd(input) {
  emit({});
  if (!input.session_id) return;
  for (const kind of ["turn", "notice"]) {
    try {
      rmSync2(stateFile(input.session_id, kind), { force: true });
    } catch {
    }
  }
}
function reloadConfig() {
  setConfig(createConfig(process.env));
}
var HOOK_PULL_OVERLAP_SECONDS, STALE_JOURNAL_BUDGET_MS;
var init_hooks = __esm({
  "packages/mcp/src/cli/hooks.ts"() {
    "use strict";
    init_src();
    init_rules();
    HOOK_PULL_OVERLAP_SECONDS = 600;
    STALE_JOURNAL_BUDGET_MS = 2e3;
  }
});

// packages/mcp/src/cli/install-hooks.ts
var install_hooks_exports = {};
__export(install_hooks_exports, {
  HOOK_EVENTS: () => HOOK_EVENTS,
  defaultSettingsPath: () => defaultSettingsPath,
  installHooks: () => installHooks,
  mergeHooks: () => mergeHooks,
  removeHooks: () => removeHooks,
  selfCommand: () => selfCommand,
  uninstallHooks: () => uninstallHooks
});
import { mkdirSync as mkdirSync4, readFileSync as readFileSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";
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
function defaultSettingsPath() {
  return join4(process.env.CLAUDE_CONFIG_DIR ?? join4(homedir3(), ".claude"), "settings.json");
}
function selfCommand() {
  return `node ${process.argv[1]}`;
}
function readSettings(path) {
  try {
    return JSON.parse(readFileSync6(path, "utf-8"));
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Refusing to edit ${path}: ${e?.message ?? e}`);
  }
}
function installHooks(path = defaultSettingsPath(), command = selfCommand()) {
  const merged = mergeHooks(readSettings(path), command);
  mkdirSync4(dirname3(path), { recursive: true });
  writeFileSync4(path, JSON.stringify(merged, null, 2) + "\n");
  return path;
}
function uninstallHooks(path = defaultSettingsPath()) {
  writeFileSync4(path, JSON.stringify(removeHooks(readSettings(path)), null, 2) + "\n");
  return path;
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
var USAGE = "Usage: yapa hook <session-start|user-prompt-submit|stop|post-compact|session-end>\n         (reads Claude Code hook JSON from stdin)\n       yapa hooks install [--settings <path>]    add YAPA hooks to Claude Code settings\n       yapa hooks uninstall [--settings <path>]  remove them\n       yapa hooks print                          show the hooks block without writing it\n";
function usage() {
  process.stderr.write(USAGE);
  process.exit(2);
}
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk2 of process.stdin) {
    chunks.push(chunk2);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
async function runHook(name) {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  if (process.env.YAPA_HOOK_CHILD) {
    process.stdout.write("{}");
    return;
  }
  adoptHostEnv(input.cwd);
  const hooks = await Promise.resolve().then(() => (init_hooks(), hooks_exports));
  switch (name) {
    case "session-start":
      return hooks.sessionStart(input);
    case "user-prompt-submit":
      return hooks.userPromptSubmit(input);
    case "stop":
      return hooks.stop(input);
    case "post-compact":
      return hooks.postCompact(input);
    case "session-end":
      return hooks.sessionEnd(input);
    default:
      usage();
  }
}
async function runHooksCommand(action, args) {
  const { installHooks: installHooks2, uninstallHooks: uninstallHooks2, mergeHooks: mergeHooks2, selfCommand: selfCommand2 } = await Promise.resolve().then(() => (init_install_hooks(), install_hooks_exports));
  const at = args.indexOf("--settings");
  const path = at >= 0 ? args[at + 1] : void 0;
  switch (action) {
    case "install":
      process.stdout.write(`YAPA hooks installed in ${installHooks2(path)}
`);
      return;
    case "uninstall":
      process.stdout.write(`YAPA hooks removed from ${uninstallHooks2(path)}
`);
      return;
    case "print":
      process.stdout.write(JSON.stringify(mergeHooks2({}, selfCommand2()), null, 2) + "\n");
      return;
    default:
      usage();
  }
}
async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  if (command === "hooks") {
    await runHooksCommand(sub, rest);
    return;
  }
  if (command !== "hook" || !sub) usage();
  try {
    await runHook(sub);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[yapa] hook ${sub} failed: ${e}
`);
    process.stdout.write("{}");
    process.exit(0);
  }
}
main();
