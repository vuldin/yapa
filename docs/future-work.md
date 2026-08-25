# YAPA × DSH — Future Work & Investigation Record

What we learned about DSH while building the plugin, what we shipped on top of
it, what is blocked upstream, and what could come next. Written so nobody has
to re-derive the seams. Dates refer to the 2026-08 investigation; DSH
0.1.0-rc.7/rc.8 packages.

## Part 1 — The DSH extension map (as discovered)

Facts verified against the installed packages (`~/.npm/_npx/.../@deepseek-ai/*`
type surfaces and bundles):

| Seam | API | What yapa uses it for |
|---|---|---|
| Tool registry | `ctx.tools.register(defineTool({...}))` (`dsh-tools`) | All 46 tools. Structured outputs are **mandatory** (`output.schema` + pure `render()`); `presentCall`/`presentResult` drive GUI cards; `isConcurrencySafe`, `timeoutMs` feed the scheduler. Code mode (`run_code`) compatibility comes free. |
| Tool policy | `tools/pre-execute` / `tools/post-execute` / `tools/result` (waterfall/emit) | Approval gate (pre), schedule bridge + promoted-section refresh (result). |
| Prompt sections | `ctx.systemPrompt.section({name, order, text\|fn})` | Rules (order 190), promoted memories (order 50). `-100` identity, `0` persona, `100–199` tool guidance. Section text fns are **synchronous** — dynamic content needs a cache. |
| Prompt assembly | `system-prompt/assemble` waterfall (async, mutable assembly) | **Not** usable for per-prompt recall: the loop assembles before appending `user/message`. (Learned by acceptance-test failure.) |
| Turn seam | `agent/pre-step` waterfall: `{agent, messages, turn, step, signal}` after inbox claim | The correct recall/injection point. Splice after the last claimed message (pattern from `dsh-agent-instructions`). |
| Sessions | `session/created`, `session/event`, `session/disposed`, `session/flush`; `session.header.cwd`; `session.id` | Journal keying, scope detection, compaction capture, injector state cleanup. |
| Injected messages | `createUserMessage({content, source: {kind:'plugin', plugin:'yapa', form:'recall'}})` | `form: 'recall'` exists in the ContextFormed vocabulary — UIs can render it specially. |
| Skills | `ctx.skills.register({name, description, whenToUse?, content, source, provider})` | `yapa-standup`. Programmatic (runtime) skills need no filesystem. |
| Settings | `ctx.settings.register(ns, schema, {base, applies})` → `SettingsScope.get/watch/update/replace` | `yapa:` namespace in `$DSH_HOME/settings.yaml`, hot-reloaded; cordis row config = composition `base`; env = lowest layer. |
| LLM routes | `ctx.llm.stream({provider, model, messages, system?, temperature, maxTokens, signal})` | Aux calls (curation/judge/synthesis) via `setHostLLMCaller` in core. Route: `auxProvider`/`auxModel` → `agent-default-model` settings value. |
| Approval | `tools/pre-execute → {kind:'ask'}`; policy `ask`\|`never`; `effectiveApprovalPolicy(session.events)` | Gate only under `ask`; `never` = user opted out of prompts; headless with no answerer fails closed. |
| Background work | `ctx.interval` (cordis-plugin-timer, effect-scoped); `ctx.jobs` (`dsh-jobs-local`) | Decay/sync timers. Jobs (agent-visible, GUI-listed) are available for sync cycles if desired. |
| Goals | `dsh-goal` + `tool-goal` + `/goal` | One persisted same-session objective with autonomous continuation rounds. Distinct from yapa tasks (durable, cross-session, passive). |
| Todos | `todo_write` (`dsh-tool-todo`) | Session-scoped ephemeral checklist; session-log-owned. |
| Schedule | `schedule_create` tools on root agents; session-log-owned durable reminders | Due-task bridging target. |
| Compaction | `ctx.compaction` (`dsh-compaction`); events `compaction/start` / `compaction/summary` / `compaction/end` | `compaction/summary` carries the distilled summary → captured as a memory. |
| Storage hub | `ctx.storage` backend registry + `dsh-storage-domain` (zod domains); shipped backend: JSON files under `$DSH_HOME/storages` | **Not used** for memories: the hub has only a `kv` facet (no vectors), and core must stay harness-neutral. yapa's local store predates a hypothetical `vector` facet. |
| Session query | `ctx.sessionQuery` exact reads + optional SQLite full-text (`node:sqlite`, `dsh-session-query-sqlite`) | Prior art for embedded databases; also the "search past transcripts" complement to memory recall. |
| Plugin install | `dsh plugin --profile <p> add <pkg>` (pnpm) + `cordis.patch.yml` insert row; `--patch` overlays | pnpm-less symlink workaround documented in install.md. Inventory UI label = module specifier (`moduleShortName` strips only `cordis:`/`cordis-plugin-`/`dsh-` prefixes) — hence the package name `yapa`. |

## Part 2 — Shipped as a result of the investigation

Always-on pre-step injection; rules + promoted-memories prompt sections;
settings namespace with hot reload; LLM bridge; schedule bridge; compaction
capture; approval gate; programmatic standup skill; per-session journals with
dispose-time consolidation; effect-scoped decay/sync timers; embedded local
store (cosine contract, embedding-model partition, batch flush, mtime
freshness); Chroma→local importer.

## Part 3 — Blocked upstream (revisit when DSH changes)

1. **GUI settings card** for the `yapa` namespace. The Plugins → configuration
   tab supports third-party cards, but the browser bundle must be built in the
   lazy-CJS factory format whose preset (`packages/client/tsdown.client.ts`) is
   not published. `settings.yaml` editing + hot reload covers the need today.
2. **Session-log traceability markers** (`yapa/mutation` log-only events).
   `Session.append` cannot set `ignorable: true`, and the persistence read path
   refuses logs containing unregistered types on resume. Upstream defers a
   plugin-event registration surface "until such a consumer exists" — yapa is
   that consumer; proposing it upstream would unblock this.
3. **`vector` facet on the storage hub.** Only `kv` exists. A facet proposal
   (embed-agnostic: `upsert(vector, record)`, `query(vector, k, filter)`)
   would let yapa's local store become a hub backend others could reuse.

## Part 4 — Ideas not yet built (no blockers, just roadmap)

**Near-term, high value**
- **Memory → skill graduation.** The system-prompt bucket promotes memories
  into the prompt; a natural next bucket promotes a cluster of related
  memories into a generated *skill* (`ctx.skills.register`), i.e. learned,
  model-invocable workflows. The curation scores (trainable etc.) already
  identify candidates.
- **Goal ↔ task lifecycle link.** `yapa_task_create` with intent "work this
  now" could optionally arm a DSH goal; goal completion could complete the
  linked task. The two systems are complementary (driver vs record).
- **Memory → source-conversation links.** Store the producing session id /
  event seq on memories (the injector knows both), then `yapa_memory_recall`
  can offer "open the conversation this came from" via `sessionQuery`.
- **Decay sweep batching is done; sync needs a live-pgvector run** against
  the local store (unit-covered via a mocked Postgres seam only).
- **Store lockfile** if multi-writer same-instant races ever bite (mtime
  freshness covers everything but the last millisecond).

**Medium**
- **ANN option for large corpora** behind the same `VectorStore` port:
  `sqlite-vec` on `node:sqlite` (follows DSH's own precedent) or pure-JS HNSW.
  Brute force is the right default at the single-user design point.
- **Sync redesign over change sets.** With both ends record-oriented (local
  store + Postgres), the embedding-dedup push/pull could simplify to
  domain-style change-set merge. `private-`/`local-` exclusion could move from
  instruction-text convention into the store layer itself.
- **Compaction-capture enrichment.** Today we store the harness summary
  verbatim; an aux-LLM pass could additionally extract *decisions and open
  loops* as higher-salience semantic memories.
- **`/standup` slash command** alongside the skill; **journal recap section**
  at session start (last session's journal memory in the first injection).

**Exploratory**
- **Per-scope tool restriction**: restrict yapa tools in delegated subagent
  scopes (read-only recall for workers, writes for roots) using
  `ctx.tools.restrict` on agent scopes.
- **Eval presets through harness routes**: per-purpose model routes
  (cheap classifier vs strong judge) once DSH exposes purpose-based routing
  beyond `purpose: 'compaction' | 'session-title'`.
- **Training defaults from the harness**: base-model selection from the
  deployment's configured routes instead of `YAPA_TRAINING_BASE_MODEL`.

## Part 5 — Known open items from the pre-DSH review (still applicable)

From REVIEW_NOTES.md, carried into the monorepo untouched: curation/bucket
scans paginate at 500/2000 then filter client-side (silent cliff past N);
`findDocByManifestId` is O(M×C×2000); `EVAL_MIN_IMPROVEMENT` and
`VERIFICATION_ATTEMPTS_MAX` remain unwired (the latter's stray re-export was
removed during the Phase 0 codemod); router "already routed" check is a
`startsWith`; no integration tests for eval/verification/promotion
orchestrators. None of these block daily use; all are good first issues.
