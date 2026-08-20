# Installing the YAPA DeepSeek Harness plugin

YAPA runs natively inside DSH as a cordis plugin (`@yapa/dsh-plugin`). Memory
recall and open tasks are injected into every prompt automatically — no hooks,
no CLAUDE.md/AGENTS.md block, no MCP subprocess.

## Prerequisites

- DSH 0.1.0-rc.7+ (`dsh --version`)
- ChromaDB v2 running locally (default `http://localhost:8000`):
  - Docker: `docker run -d --name chromadb --restart unless-stopped -p 8000:8000 -v chromadb_data:/data chromadb/chroma`
  - pip: `pip install chromadb && chroma run --host 0.0.0.0 --port 8000`
- This repository built: `npm install && npm run build`

## Install into a profile

From the profile you use (`web` shown here; substitute `tui`/`headless` as needed):

```sh
# 1. Add the package to the profile (forwards to pnpm in the profile dir).
#    From a local checkout:
dsh plugin --profile web add link:/absolute/path/to/yapa/packages/dsh
#    (once published: dsh plugin --profile web add @yapa/dsh-plugin)

# 2. Register the plugin row in ~/.dsh/profiles/web/cordis.patch.yml:
```

```yaml
- insert:
    - id: yapa
      name: '@yapa/dsh-plugin'
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
memories), `promotedSection` (system-prompt-bucket memories render as a live
prompt section), `standupSkill` (registers the `yapa-standup` skill),
`auxProvider`/`auxModel` (route for curation/synthesis/judge LLM calls;
defaults to the harness's configured default model).

### Local dev note (no pnpm)

`dsh plugin add` forwards to pnpm; if pnpm is unavailable, symlink the
packages directly instead:

```sh
mkdir -p ~/.dsh/profiles/web/node_modules/@yapa
ln -sfn /absolute/path/to/yapa/packages/dsh  ~/.dsh/profiles/web/node_modules/@yapa/dsh-plugin
ln -sfn /absolute/path/to/yapa/packages/core ~/.dsh/profiles/web/node_modules/@yapa/core
```

## Verify

In any session:

- `yapa_status` — ChromaDB connectivity, embedding provider, sync state.
- Store something: `yapa_memory_store` → start a **new** session → ask about
  the topic → the recalled memory appears in the injected context.
- `yapa_task_create` with a due date → `yapa_task_list` shows it across
  sessions.

## Uninstall

```sh
dsh plugin --profile web remove @yapa/dsh-plugin
```

…then delete the `yapa` row from `~/.dsh/profiles/web/cordis.patch.yml`.
ChromaDB collections (memories and tasks) are preserved; delete them with
`yapa_collection_delete` first if you want a clean removal.

## Coexistence note

Do not load BOTH this plugin and the MCP server (`yapa-mcp` via DSH's
`mcp-client`, tools named `mcp__yapa__*`) into the same profile — memory
writes would double-register. Pick one: the plugin for DSH-native use, the
MCP server for Claude Code / Cursor / OpenCode.
