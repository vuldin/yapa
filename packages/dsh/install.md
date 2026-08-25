# Installing the YAPA DeepSeek Harness plugin

YAPA runs natively inside DSH as a cordis plugin (`yapa`). Memory
recall and open tasks are injected into every prompt automatically — no hooks,
no CLAUDE.md/AGENTS.md block, no MCP subprocess.

## Prerequisites

- DSH 0.1.0-rc.7+ (`dsh --version`)
- This repository built: `npm install && npm run build`
- **Storage, one of:**
  - **Embedded (default-free option)** — set `storage: local` in the config
    row below; nothing else to install. Documents + vectors live in
    `~/.local/share/yapa/store` (override with `localStorePath`).
  - **ChromaDB v2** (default; needed for remote sync today):
    - Docker: `docker run -d --name chromadb --restart unless-stopped -p 8000:8000 -v chromadb_data:/data chromadb/chroma`
    - pip: `pip install chromadb && chroma run --host 0.0.0.0 --port 8000`
    - uv: `uvx --from chromadb chroma run --host 127.0.0.1 --port 8000 --path ~/.local/share/yapa/chroma`

Migrating an existing ChromaDB install to the embedded store: set
`storage: local`, keep ChromaDB running, then call `yapa_storage_import`
with `confirm: true`.

## Install into a profile

From the profile you use (`web` shown here; substitute `tui`/`headless` as needed):

```sh
# 1. Add the package to the profile (forwards to pnpm in the profile dir).
#    From a local checkout:
dsh plugin --profile web add link:/absolute/path/to/yapa/packages/dsh
#    (once published: dsh plugin --profile web add yapa)

# 2. Register the plugin row in ~/.dsh/profiles/web/cordis.patch.yml:
```

```yaml
- insert:
    - id: yapa
      name: 'yapa'
      config:
        username: YOUR_USERNAME            # used for task ID prefixes
        # chromaUrl: http://localhost:8000 # default
        # projectRoots: [/home/you/projects]  # cwd → collection detection
        # syncEnabled: false
        # syncDatabaseUrl: postgres://…    # optional remote sync
```

Restart DSH. You should see the `yapa_*` tools in the tool list and a
"YAPA — Memory & Task Assistant" rules section in the system prompt.

## Configuration

Three layers, lowest to highest precedence:

1. **Environment** — the historic `YAPA_*` variables still work
   (e.g. `YAPA_CHROMA_URL`), resolved first.
2. **The cordis row `config:`** (above) — deployment defaults.
3. **`~/.dsh/settings.yaml` under `yapa:`** — user overrides, hot-reloaded
   (change `syncIntervalMs`, `chromaUrl`, etc. without a restart).

Plugin-only knobs (layer 2/3 only): `projectRoots`, `injectRecall`,
`injectTasks`, `recallResults`, `maxContextBytes`, `autoJournalConsolidate`,
`decayOnStartup`, `scheduleBridge` (due-dated tasks become `schedule_create`
reminders), `captureCompaction` (harness compaction summaries are stored as
memories), `captureResponses` (every completed turn is judged by the aux-LLM
extractor and durable findings are auto-stored, deduplicated, tagged
`auto-capture`, salience-capped — see `captureMinChars`, `captureMaxMemories`,
`captureMaxSalience`, `captureDedupeDistance`), `promotedSection`
(system-prompt-bucket memories render as a live prompt section),
`standupSkill` (registers the `yapa-standup` skill),
`auxProvider`/`auxModel` (route for curation/synthesis/judge/extractor LLM
calls; defaults to the harness's configured default model — point it at a
cheap model if you want response capture to cost less).

### Local dev note (no pnpm)

`dsh plugin add` forwards to pnpm; if pnpm is unavailable, symlink the
packages directly instead:

```sh
mkdir -p ~/.dsh/profiles/web/node_modules/@yapa
ln -sfn /absolute/path/to/yapa/packages/dsh  ~/.dsh/profiles/web/node_modules/yapa
ln -sfn /absolute/path/to/yapa/packages/core ~/.dsh/profiles/web/node_modules/@yapa/core
```

## Verify

In any session:

- `yapa_status` — storage backend (embedded store path or ChromaDB health),
  embedding provider, sync state.
- Store something: `yapa_memory_store` → start a **new** session → ask about
  the topic → the recalled memory appears in the injected context.
- `yapa_task_create` with a due date → it also becomes a `schedule_create`
  reminder (`scheduleBridge`).
- Response capture (`captureResponses`): have a substantive exchange (a real
  finding or decision), then check `yapa_memory_list` — a new memory tagged
  `auto-capture` with `source: auto-capture` metadata appears within seconds
  of the turn ending; the next prompt's injected context notes it. Near-
  duplicates of existing memories are skipped, not double-stored.
- Destructive calls (`yapa_collection_delete`, `yapa_memory_forget`,
  `yapa_task_delete`, training/promotion tools, `yapa_storage_import`) trigger
  the harness approval prompt in ask-policy sessions (`approvalGate`, default
  on; under `DSH_PERMISSION_MODE=danger-full-access` no prompts are shown and
  calls proceed — the `confirm: true` params remain as a second gate where
  money is spent).

## Uninstall

```sh
dsh plugin --profile web remove yapa
```

…then delete the `yapa` row from `~/.dsh/profiles/web/cordis.patch.yml`.
Collections (memories and tasks) are preserved — in `~/.local/share/yapa/store`
(local store) or ChromaDB, per your `storage` setting; delete them with
`yapa_collection_delete` first if you want a clean removal.

## Deferred (upstream-limited)

- **GUI settings card.** The Plugins → "Plugin configuration" tab can host a
  card for yapa's settings namespace (which is registered and hot-reloads via
  `settings.yaml`), but the card needs a browser bundle built in DSH's
  lazy-CJS factory format whose build preset (`packages/client/tsdown.client.ts`)
  is not published — an external plugin must reproduce that build. Until then,
  edit `~/.dsh/settings.yaml` (`yapa:` section) directly; changes apply live.
- **Session-log traceability markers.** Recording yapa mutations as log-only
  session events (e.g. `yapa/mutation`) requires a custom event type, and DSH's
  persistence read path refuses logs with unregistered event types unless they
  carry `ignorable: true` — which `Session.append` cannot currently set
  (upstream note: "a registration surface for them is deferred until such a
  consumer exists"). Adding markers before that surface lands would break
  session resume, so this waits for upstream.

## Coexistence note

Do not load BOTH this plugin and the MCP server (`yapa-mcp` via DSH's
`mcp-client`, tools named `mcp__yapa__*`) into the same profile — memory
writes would double-register. Pick one: the plugin for DSH-native use, the
MCP server for Claude Code / Cursor / OpenCode.
