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
   - **Docker (recommended):** \`docker run -d --name chromadb -p 8000:8000 -v chromadb_data:/chroma/chroma chromadb/chroma\`
   - **pip:** \`pip install chromadb && chroma run --host 0.0.0.0 --port 8000\`
   - **NixOS service:** add \`services.chromadb.enable = true;\` to your NixOS config
4. After the user installs and starts ChromaDB, re-check the heartbeat before continuing.
5. Do NOT silently swallow connection errors from YAPA tools — if ChromaDB goes down mid-session, notify the user immediately.

### Auto-Query (every response)
- Before responding to any question or starting any task, call \`memory_recall\`
  with a semantic query derived from the user's message
- Check if existing memories contain solutions, context, or prior decisions relevant
  to the current work

### Selective Auto-Store
Store memories automatically (salience >= 2.0) when you encounter:
- Bug fixes and their root causes
- User preferences and decisions
- Configuration values and environment details
- Key technical facts about the codebase
- Solutions to problems that may recur
Do NOT store: ephemeral conversation details, obvious code patterns,
information already in git history

### Task Management
- When new work is identified, call \`task_create\`
- When work completes, call \`task_complete\`
- When blocked, call \`task_update\` with status "blocked"
- At session start, call \`task_list\` to review current state

### Collection Inference
- Infer the appropriate collection from conversation context:
  - Customer name mentioned → \`customer-{name}\`
  - Project-specific work → \`project-{name}\` or \`customer-{name}\`
  - General/cross-cutting knowledge → \`global\`
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
