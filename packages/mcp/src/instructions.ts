import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const INSTRUCTIONS_BLOCK = `
## YAPA — Memory & Task Assistant

You have access to YAPA memory and task tools via MCP. Follow these rules:

### ChromaDB Prerequisite
Before using any YAPA tool, verify ChromaDB is reachable:
1. Run: \`curl -sf http://localhost:8000/api/v2/heartbeat\`
2. If it succeeds, ChromaDB is running — proceed normally.
3. If it fails, tell the user:
   > "YAPA needs ChromaDB to store memories and tasks, but it doesn't appear to be running locally. How would you like to install it?"
   Then offer these options (Docker is recommended):
   - **Docker (recommended):** \`docker run -d --name chromadb --restart unless-stopped -p 8000:8000 -v chromadb_data:/data chromadb/chroma\`
   - **pip:** \`pip install chromadb && chroma run --host 0.0.0.0 --port 8000\`
   - **NixOS service:** add \`services.chromadb.enable = true;\` to your NixOS config
4. After the user installs and starts ChromaDB, re-check the heartbeat before continuing.
5. Do NOT silently swallow connection errors from YAPA tools — if ChromaDB goes down mid-session, notify the user immediately.

### ChromaDB Version Requirement (v2+ Required)
YAPA requires **ChromaDB version 2** (0.x.x series, e.g., 0.4.0, 0.5.0 or higher).

**Check version:** \`curl http://localhost:8000/api/v2/version\`
**Required format:** Version should start with "0." (e.g., "0.4.0")

**If ChromaDB v1 is detected:**
YAPA will refuse to start with an error message. You must upgrade ChromaDB.

**Upgrade instructions:**
- **Docker:** \`docker pull chromadb/chroma:latest && docker restart chromadb\`
- **pip:** \`pip install --upgrade chromadb && chroma run --host 0.0.0.0 --port 8000\`
- **NixOS:** Update chromadb package to latest version and restart the service

**Troubleshooting:**
If tasks or memories are not found after migration, ensure metadata has correct 'type' field:
- Tasks: metadata.type = "task"
- Memories: metadata.type = "memory"
Multiple filters require ChromaDB v2 format using $and operators.

### Per-Prompt Routine (run on EVERY user message)
Run these steps in order, in parallel where possible, before drafting your response:

1. **Detect scope** — infer the project/customer from the prompt + cwd. Pick the
   collection (\`customer-{name}\`, \`project-{name}\`, or \`global\`). If genuinely
   ambiguous, ask the user once and remember the answer for the session.
2. **Recall** — call \`memory_recall\` against the detected collection with a
   semantic query derived from the prompt.
3. **Task check** — call \`task_list\` filtered to the detected collection at
   session start AND whenever the detected scope changes. Skip on subsequent
   prompts within the same scope (rely on in-conversation state instead).
4. **Ensure a task exists for the active work** — call \`task_create\` in the
   detected collection BEFORE starting work when the prompt implies multi-step
   work, work that will take time, or work that will outlive the current turn
   (investigations, code changes, bug fixes, meeting prep, ongoing initiatives).
   Skip for one-shot questions, lookups, or single-turn answers.

### Auto-Capture During Work
Capture as soon as the trigger fires — do NOT batch to the end of the session.

**Triggers that create a memory (salience >= 2.0):**
- A bug's root cause is identified
- A configuration value, env var, endpoint, or credential location is learned
- The user states a preference, decision, or correction
- A non-obvious technical fact about the codebase/customer/cluster is discovered
- A solution that took non-trivial effort to find (likely to recur)
- A meeting or Slack thread surfaces a decision or commitment

**Triggers that create a task (in addition to any memory):**
- A follow-up action is identified ("we should also...", "TODO", "next time...")
- The user asks for something that can't be finished this turn
- A blocker is discovered (also: \`task_update\` the parent task to "blocked")
- An action item shows up in a customer meeting or Slack thread

**Contradiction check:** \`memory_store\` returns a \`potential_conflicts\` field
listing near-duplicate memories in the same collection. Read it — if a conflict
exists, decide supersede (re-store with \`supersedes: "<old ID>"\` — archives the
old memory, recoverable via include_archived) or coexist (proceed as-is) BEFORE
moving on. Reserve \`memory_forget\` for memories that should never have existed.

**Do not store:** ephemeral conversation state, obvious code patterns, anything
already captured in git history or in an existing memory.

### End-of-Session Journal
- During the session, call \`journal_append\` with a one-line note whenever a
  meaningful step completes (decision made, finding confirmed, task closed).
- Before the session ends — or when prompted by the SessionEnd hook — call
  \`journal_consolidate\` to merge the drafts into a single memory tagged
  \`journal\`. The next session's recall will surface it.

### Task Management Lifecycle
- On completion: \`task_complete\`
- On blocker: \`task_update\` with status \`blocked\` and a note explaining the block
- On scope change: \`task_update\` to amend the description rather than creating
  a duplicate
- Session start: covered by Per-Prompt Routine step 3

### Periodic Compaction
- When YAPA emits a "compaction candidate" reminder at session start, call
  \`compaction_suggest\` for the named collection, write a rolling summary of
  each group, and submit it via \`compaction_apply\`. Originals get archived
  (filtered from recall by default).

### Collection Inference
- Infer the appropriate collection from conversation context:
  - Customer name mentioned → \`customer-{name}\`
  - Project-specific work → \`project-{name}\` or \`customer-{name}\`
  - General/cross-cutting knowledge → \`global\`
  - Private/personal data → \`private-{name}\` or \`local-{name}\` (these do NOT sync to remote)
- **Before creating a new collection**, ask the user to confirm the collection name. Suggest a name based on context. Remind the user that \`private-\` or \`local-\` prefixed collections won't sync to the shared remote database.
- When unsure which collection to use, ask the user
- Use \`collection_list\` to check what collections exist before creating new ones
- Always pass the inferred collection explicitly on memory/task tool calls

### Uninstall
If the user says "uninstall yapa":
1. Use AskUserQuestion to ask "Do you want to keep your ChromaDB collections (memories and tasks)?" with exactly two options: "Yes" (first), "No". Do not ask this as plain text.
2. Call the \`uninstall\` MCP tool with \`delete_collections: true\` if the user answered "No", or \`delete_collections: false\` if "Yes".
3. Execute every step the tool returns without asking anything else.
`.trim();

export type InstructionTarget = 'claude' | 'opencode' | 'auto';
export type InstructionScope = 'project' | 'global';

interface SetupResult {
  target: string;
  file: string;
  action: 'created' | 'appended' | 'skipped';
  instructions: string;
}

function resolveTarget(cwd: string, target: InstructionTarget): 'claude' | 'opencode' {
  if (target !== 'auto') return target;
  if (existsSync(join(cwd, '.claude'))) return 'claude';
  if (existsSync(join(cwd, '.opencode'))) return 'opencode';
  return 'claude';
}

function resolveFilePath(resolvedTarget: 'claude' | 'opencode', scope: InstructionScope, cwd: string): string {
  if (scope === 'global') {
    if (resolvedTarget === 'claude') {
      return join(homedir(), '.claude', 'CLAUDE.md');
    } else {
      return join(homedir(), '.config', 'opencode', 'AGENTS.md');
    }
  }
  // project scope
  return resolvedTarget === 'claude'
    ? join(cwd, 'CLAUDE.md')
    : join(cwd, 'AGENTS.md');
}

/**
 * Write behavioral instructions to the correct file.
 * @param cwd Working directory to check for .claude/ or .opencode/
 * @param target Override target detection
 * @param scope 'project' (cwd) or 'global' (home directory)
 */
export function setupInstructions(
  cwd: string,
  target: InstructionTarget = 'auto',
  scope: InstructionScope = 'project',
): SetupResult {
  const resolvedTarget = resolveTarget(cwd, target);
  const filePath = resolveFilePath(resolvedTarget, scope, cwd);

  // Ensure parent directory exists for global scope
  if (scope === 'global') {
    const dir = join(filePath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Check if instructions already present
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing.includes('YAPA — Memory & Task Assistant')) {
      return {
        target: resolvedTarget,
        file: filePath,
        action: 'skipped',
        instructions: INSTRUCTIONS_BLOCK,
      };
    }

    appendFileSync(filePath, '\n\n' + INSTRUCTIONS_BLOCK + '\n');
    return {
      target: resolvedTarget,
      file: filePath,
      action: 'appended',
      instructions: INSTRUCTIONS_BLOCK,
    };
  }

  writeFileSync(filePath, INSTRUCTIONS_BLOCK + '\n');
  return {
    target: resolvedTarget,
    file: filePath,
    action: 'created',
    instructions: INSTRUCTIONS_BLOCK,
  };
}
