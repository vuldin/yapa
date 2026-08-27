# YAPA Training Pipeline (gated ML-ops subsystem)

YAPA's default tool surface is memory & task management (23 tools). On top of
that sits an optional **ML-ops pipeline** — 18 additional tools that turn
curated memories into (a) a versioned system-prompt companion and (b) a
fine-tuned adapter. These are *operator workflows*: deliberate, occasional,
and mostly batch-oriented, so the tools are **hidden by default** and appear
only when explicitly enabled.

## Enabling the tools

- **DSH plugin:** set `trainingPipeline: true` in the plugin's cordis row
  `config:` or the `yapa:` section of `~/.dsh/settings.yaml` (hot-reloaded —
  the tool catalog updates without a restart).
- **MCP server:** set `YAPA_TRAINING_PIPELINE=true` in the server env.

## How the pipeline fits together

```
memories ──► (1) classify ──► (2) route to buckets ──► (3a) system-prompt companion
             curation_*         bucket_*               (memories baked into the prompt,
                                                        removed from RAG while active)
                                                  └──► (3b) training manifest
                                                        ──► (4) synthesize examples
                                                            ──► (5) fine-tune job
                                                                ──► (6) eval + verify
                                                                    ──► (7) promote adapter
                                                                        (memories leave RAG)
```

1. **Classify** (`curation_*`) — an LLM scores every memory on three
   independent dimensions: `trainable` (is this good training data?),
   `durability` (will it still be true in months?), `generalizability` (is it
   a pattern or a one-off?). Scores persist on the memory's metadata.
2. **Route** (`bucket_*`) — threshold rules map scored memories to buckets:
   `system-prompt` (high durability/generalizability — inject into the prompt)
   or `training` (high trainability — feed a fine-tune). Routing writes
   versioned artifacts under `YAPA_ARTIFACTS_DIR`.
3. **System-prompt companion** (`system_prompt_*`) — the routed memories are
   written as a versioned companion document. Activating a version marks its
   memories `promoted_to: 'system-prompt'` so they leave RAG (they're in the
   prompt instead); deactivating rolls them back. Under DSH, promoted
   memories render as a live prompt section (`promotedSection`, on by
   default) instead of a file.
4. **Synthesize** (`training_dataset_preview`) — each training-bucket memory
   becomes 1–3 standalone chat-format examples (OpenAI JSONL), teaching
   *patterns and judgment*, not point-in-time facts. Emits a preview JSONL
   plus a SHA-256 reference; a holdout split is reserved for eval.
5. **Train** (`training_*`) — submits the dataset to the configured backend
   (Fireworks by default: `YAPA_TRAINING_BACKEND`, `YAPA_TRAINING_BASE_MODEL`,
   default `qwen3-coder-30b-a3b-instruct`). `training_trigger` is double-gated:
   it requires `confirm: true` AND the preview's SHA-256 ref, so you can only
   train exactly what you previewed. Runs register in the adapter registry.
6. **Eval + verify** (`eval_*`) — an LLM judge scores the trained adapter on
   the holdout (`eval_run`, `eval_compare`), and per-memory verification
   (`eval_verify`) checks the adapter actually reproduces each memory's
   content.
7. **Promote** (`adapter_promote` / `adapter_demote`) — a verified adapter's
   memories move from `selected_for` to `promoted_to` (hidden from RAG — the
   model now *knows* them). Demote rolls back.

## The 18 gated tools

| Group | Tools |
|---|---|
| Curation (scoring) | `curation_now`, `curation_status`, `curation_preview` |
| Bucket routing | `bucket_route_preview`, `bucket_route_now`, `bucket_status` |
| System-prompt companion | `system_prompt_activate`, `system_prompt_deactivate` |
| Training | `training_dataset_preview`, `training_trigger`, `training_status`, `training_get`, `training_cancel` |
| Eval | `eval_run`, `eval_compare`, `eval_verify` |
| Adapter promotion | `adapter_promote`, `adapter_demote` |

(Under DSH these are the `yapa_`-prefixed names, e.g. `yapa_training_trigger`.)

## LLM routes

Every auxiliary LLM step (classifier, synthesis, judge, and — under DSH — the
response-capture extractor/resolver) goes through one seam:

- **DSH plugin:** the harness's model registry via `ctx.llm` — plugin config
  `auxProvider`/`auxModel`, falling back to the harness default model. No
  separate API keys.
- **MCP server:** `YAPA_CURATION_LLM_PROVIDER` + provider key
  (`YAPA_ANTHROPIC_API_KEY`, `YAPA_FIREWORKS_API_KEY`, …). Model overrides:
  `YAPA_CURATION_MODEL` (classifier and judge), `YAPA_TRAINING_SYNTHESIS_MODEL`
  (example synthesis; falls back to the curation model).

The training *job* itself always needs the training backend's credentials
(`YAPA_FIREWORKS_API_KEY` for the default Fireworks backend) regardless of
frontend.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `YAPA_TRAINING_PIPELINE` | Expose the 18 ML-ops tools (DSH plugin: `trainingPipeline: true`) | `false` |
| `YAPA_CURATION_ENABLED` | Enable the background classifier (weekly timer) | `false` |
| `YAPA_CURATION_INTERVAL_MS` | Background curation interval in ms | `604800000` (7 days) |
| `YAPA_CURATION_LLM_PROVIDER` | `fireworks` \| `openai` \| `anthropic` \| `ollama` (MCP; DSH uses the aux route) | `anthropic` |
| `YAPA_CURATION_MODEL` | Override the default model for the chosen provider | _(provider default)_ |
| `YAPA_CURATION_BATCH_SIZE` | Memories per classifier call | `20` |
| `YAPA_ARTIFACTS_DIR` | Where bucket artifacts are written | `~/.yapa/artifacts` |
| `YAPA_SYSTEM_PROMPT_TRAINABLE_MIN` | Min trainable score for system-prompt bucket | `0.5` |
| `YAPA_SYSTEM_PROMPT_DURABILITY_MIN` | Min durability score for system-prompt bucket | `0.7` |
| `YAPA_SYSTEM_PROMPT_GENERALIZABILITY_MIN` | Min generalizability score for system-prompt bucket | `0.5` |
| `YAPA_TRAINING_TRAINABLE_MIN` | Min trainable score for training bucket | `0.7` |
| `YAPA_TRAINING_DURABILITY_MIN` | Min durability score for training bucket | `0.8` |
| `YAPA_TRAINING_GENERALIZABILITY_MIN` | Min generalizability score for training bucket | `0.7` |
| `YAPA_TRAINING_BACKEND` | Training backend — currently `fireworks` | `fireworks` |
| `YAPA_TRAINING_BASE_MODEL` | Base model to fine-tune | `accounts/fireworks/models/qwen3-coder-30b-a3b-instruct` |
| `YAPA_TRAINING_FIRECTL_PATH` | Path to the `firectl` executable | `firectl` |
| `YAPA_TRAINING_SYNTHESIS_MODEL` | Model used to synthesize chat-format training examples from memories | _(falls back to curation model)_ |
| `YAPA_VERIFICATION_ENABLED` | Opt-in gate for per-memory verification (incurs adapter inference cost) | `false` |
| `YAPA_EVAL_HOLDOUT_FRACTION` | Fraction of manifest reserved as holdout for aggregate eval | `0.15` |
| `YAPA_EVAL_HOLDOUT_MIN` | Minimum number of memories in the holdout regardless of fraction | `3` |
| `YAPA_INFERENCE_BASE_URL` | OpenAI-compatible endpoint used to query trained adapters | `https://api.fireworks.ai/inference/v1` |

## Suggested order of operations

1. `curation_now` — score everything unclassified (runs on a weekly interval
   automatically when `YAPA_CURATION_ENABLED=true`).
2. `bucket_route_preview` → `bucket_route_now` — see what would route where,
   then write the artifacts.
3. `system_prompt_activate` — if a companion version looks right.
4. `training_dataset_preview` → inspect the JSONL → `training_trigger`.
5. `training_status` / `training_get` until the run completes.
6. `eval_run` (and `eval_verify` for spot checks) → `adapter_promote` if it
   passes.
7. Anything wrong: `training_cancel`, `system_prompt_deactivate`, or
   `adapter_demote` — every stage has a rollback.
