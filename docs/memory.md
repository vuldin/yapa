# Memory: salience, chunking, conflicts, journals and compaction

## Salience

Not all memories are equally important. YAPA scores each memory by salience (0.05 floor to 5.0 max), boosts it when it's actually used, and decays it with wall-clock time. Salience also weights retrieval ranking, so higher-salience memories surface ahead of lower-salience ones at similar vector distance. Nothing is deleted — low-salience memories just surface less often.

- **Decay** is time-based: `salience × rate^days` since the memory was last decayed (`decayed_at`), with `rate` = 0.98/day for episodic memories (half-life ~34 days) and √0.98 for semantic facts (~69 days). Sweeps run at most once per 24h (checked hourly), and re-running one decays nothing extra, so the curve doesn't depend on how often you open a session.
- **Boosts** (+0.1) happen only when a recall hit is relevant (cosine distance < `YAPA_SALIENCE_BOOST_MAX_DISTANCE`, default 0.5) — merely being surfaced by the per-prompt hook doesn't count — and at most `YAPA_SALIENCE_MAX_BOOSTS_PER_DAY` (3) times per memory per day.
- **Ranking**: `cosine distance − 0.15 × normalized salience`, so salience breaks ties between similarly relevant memories rather than overriding relevance.
- Salience is per machine: boosts and decay reflect each user's own usage and don't sync.

## Chunking

Long content is split into 2000-character chunks with 200-character overlap, each independently searchable. Meeting notes, documentation, lengthy explanations — all stored and retrievable.

## Contradiction detection

`memory_store` runs a similarity check against the destination collection
before each write. Memories within `YAPA_CONTRADICTION_DISTANCE_THRESHOLD`
(default `0.25`, normalized cosine) are returned as `potential_conflicts`. The
agent decides:

- **Supersede** — re-store with `supersedes: "<conflicting ID>"`: the old
  memory is **archived** (`archived: true` + a `superseded_by` link) instead
  of hard-deleted — filtered from `memory_recall`/`memory_list` by default,
  recoverable anytime with `include_archived: true`.
- **Coexist** — leave the older memory in place; the new one is already stored.

`memory_forget` (hard delete) is reserved for memories that should never have
existed.

**Under DSH**, contradiction handling is also automatic: the response-capture
pipeline routes every auto-captured candidate with near neighbors through a
conservative LLM resolver (skip / add / supersede), and a daily **janitor
sweep** resolves duplicate pairs already in the store (`yapa_janitor_now` /
`janitor_now` runs it on demand). The resolver only supersedes when a fact
clearly changed; when unsure it keeps both.

Tunables:

| Env var | Default | Meaning |
|---------|---------|---------|
| `YAPA_CONTRADICTION_DISTANCE_THRESHOLD` | `0.25` | Distance under which two memories are considered conflicting |
| `YAPA_CONTRADICTION_MAX_RESULTS` | `3` | Max conflicts surfaced per write |

## End-of-session journal

Two tools record what happened during a session so the next session has continuity:

- `journal_append({ entry, collection? })` — append a one-line note. Drafts are scoped to the current MCP server process via a per-process `SESSION_ID`.
- `journal_consolidate({ collection?, summary? })` — roll the session's drafts into a single memory tagged `journal` at salience 1.5, then delete the drafts. If no `summary` is provided, the drafts are concatenated chronologically.

Consolidation also happens automatically: the MCP server rolls up its session's drafts when it shuts down (one server process per Claude Code session), and the `SessionStart` hook rolls up drafts older than a day left behind by sessions that crashed.

## Periodic compaction

When a collection grows past `YAPA_COMPACTION_THRESHOLD` non-archived memories
(default `50`), the SessionStart hook flags it as a compaction candidate. The
agent then:

1. Calls `compaction_suggest({ collection })` — returns groups of ≥`YAPA_COMPACTION_MIN_GROUP_SIZE` similar memories (similarity gated by `YAPA_COMPACTION_SIMILARITY_DISTANCE`, default `0.30`).
2. For each group, drafts a one-paragraph rolling summary.
3. Calls `compaction_apply({ collection, member_ids, summary })` — writes the summary at salience 2.0 with tag `compacted`, then marks each member with `archived: true` and `compacted_into: <summary-id>`.

`memory_recall` and `memory_list` filter `archived: true` out by default. Pass `include_archived: true` to inspect them.

Tunables:

| Env var | Default | Meaning |
|---------|---------|---------|
| `YAPA_COMPACTION_THRESHOLD` | `50` | Collection size at which compaction is suggested |
| `YAPA_COMPACTION_MIN_GROUP_SIZE` | `3` | Minimum members a compaction group must have |
| `YAPA_COMPACTION_SIMILARITY_DISTANCE` | `0.30` | Distance under which two memories belong to the same group |

## Embedding providers

Embeddings always run **in-process** — no storage backend embeds server-side,
and the default needs no server and no API key. (The default provider is named
`chromadb` for historical reasons: it is the quantized all-MiniLM-L6-v2 ONNX
model run by `@huggingface/transformers` — the same model the earlier
`chromadb-default-embed` package used, so existing vectors stay valid — and has
nothing to do with running a ChromaDB *server*.) Set `YAPA_MODEL_CACHE_DIR` to
keep the downloaded weights somewhere persistent (the plugin uses its data dir).

ChromaDB collections created before YAPA pinned cosine space use the server
default (squared L2). YAPA reads each collection's space and converts those
distances to cosine, so thresholds behave the same on old and new collections.

| Provider | Model | Dimensions | Config |
|----------|-------|------------|--------|
| In-process MiniLM (default) | all-MiniLM-L6-v2 | 384 | Zero-config |
| Fireworks | nomic-embed-text-v1 | 768 | `YAPA_EMBEDDING_PROVIDER=fireworks` |
| OpenAI | text-embedding-3-small | 768 | `YAPA_EMBEDDING_PROVIDER=openai` |
| Voyage AI | voyage-3-lite | 512 | `YAPA_EMBEDDING_PROVIDER=voyage` |
| Ollama | nomic-embed-text | 768 | `YAPA_EMBEDDING_PROVIDER=ollama` |

To use a non-default provider, add the relevant env vars to your MCP host config's `env` block (or the plugin's cordis `config:` under DSH). See `.env.example` for all options.

Note: the embedding provider and the **storage backend** are independent
choices — the in-process embedder pairs with both the embedded local store
(the default for the Claude Code and DSH plugins) and a ChromaDB server (the default for a server registered by hand without `YAPA_STORAGE`).
