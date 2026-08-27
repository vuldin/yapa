import {
  getConfig,
  recallMemory,
  listMemories,
  listTasks,
  listCollections,
  collectionSize,
} from '@yapa/core';

interface BaseHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface SessionStartInput extends BaseHookInput {
  source?: 'startup' | 'resume' | 'clear';
}

interface UserPromptSubmitInput extends BaseHookInput {
  prompt?: string;
}

interface StopInput extends BaseHookInput {
  stop_hook_active?: boolean;
}

interface SessionEndInput extends BaseHookInput {
  reason?: string;
}

const PROJECTS_ROOT = '/home/josh/redpanda/projects';

/**
 * Folder names under PROJECTS_ROOT that are customers (→ `customer-{name}`).
 * Everything else defaults to `project-{name}`. (The dsh plugin exposes this
 * as the `customers` config knob; this CLI is a per-install artifact.)
 */
const CUSTOMER_SEGMENTS: string[] = [];

/**
 * Outcome of scope inference: the collection to use, plus the two candidates
 * when BOTH `customer-` and `project-` exist for the folder — genuinely
 * ambiguous, so the emitted context tells the agent to ask the user.
 */
interface CollectionDetection {
  collection: string;
  ambiguous?: [string, string];
}

/**
 * Infer the active collection from cwd: only `customer-` existing → customer-;
 * only `project-` → project-; both → ambiguous (reads default to project-);
 * neither → CUSTOMER_SEGMENTS decides, else project- (the common case).
 * Anything outside PROJECTS_ROOT → global.
 */
async function detectCollection(cwd: string | undefined): Promise<CollectionDetection> {
  if (!cwd) return { collection: 'global' };
  if (!cwd.startsWith(PROJECTS_ROOT)) return { collection: 'global' };

  const relative = cwd.slice(PROJECTS_ROOT.length).replace(/^\/+/, '');
  if (!relative) return { collection: 'global' };

  const segment = relative.split('/')[0];
  if (!segment || segment.startsWith('.')) return { collection: 'global' };

  const existing = (await listCollections().catch(() => [])).map(c => c.name);
  const hasCustomer = existing.includes(`customer-${segment}`);
  const hasProject = existing.includes(`project-${segment}`);
  if (hasCustomer && hasProject) {
    return { collection: `project-${segment}`, ambiguous: [`project-${segment}`, `customer-${segment}`] };
  }
  if (hasCustomer) return { collection: `customer-${segment}` };
  if (hasProject) return { collection: `project-${segment}` };
  if (CUSTOMER_SEGMENTS.includes(segment)) return { collection: `customer-${segment}` };
  return { collection: `project-${segment}` };
}

/** The `**Scope:**` line for emitted context, flagging ambiguity if present. */
function scopeLine(d: CollectionDetection): string {
  if (!d.ambiguous) return `**Scope:** \`${d.collection}\``;
  return `**Scope:** AMBIGUOUS — both \`${d.ambiguous[0]}\` and \`${d.ambiguous[1]}\` exist for this folder. Ask the user which collection to use BEFORE storing anything. (Reads here default to \`${d.collection}\`.)`;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload));
}

async function findCompactionCandidates(): Promise<string[]> {
  const cols = await listCollections().catch(() => []);
  const out: string[] = [];
  for (const c of cols) {
    const size = await collectionSize(c.name).catch(() => 0);
    if (size >= getConfig().COMPACTION_THRESHOLD) out.push(`${c.name} (${size})`);
  }
  return out;
}

export async function sessionStart(input: SessionStartInput): Promise<void> {
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;

  const lines: string[] = ['# YAPA Context', '', scopeLine(detection)];

  try {
    const tasks = await listTasks({ collection, includeComplete: false });
    if (tasks.length) {
      lines.push('', '## Open tasks');
      for (const t of tasks.slice(0, 10)) {
        const status = t.metadata.status ?? 'open';
        const prio = t.metadata.priority ? `, ${t.metadata.priority}` : '';
        lines.push(`- **${t.id}** [${status}${prio}] ${t.title}`);
      }
      if (tasks.length > 10) lines.push(`- _…${tasks.length - 10} more (call \`task_list\` for the full list)_`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] task_list failed: ${e}\n`);
  }

  try {
    const memories = await listMemories({ collection, limit: 5 });
    if (memories.length) {
      lines.push('', '## Top memories (by salience)');
      for (const r of memories) {
        const sal = r.metadata.salience?.toFixed(2) ?? '?';
        const snippet = r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content;
        lines.push(`- **${r.id}** (salience ${sal}): ${snippet}`);
      }
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] memory list failed: ${e}\n`);
  }

  try {
    const candidates = await findCompactionCandidates();
    if (candidates.length) {
      lines.push('', '## Compaction candidates');
      lines.push('These collections are above the size threshold. Consider calling `compaction_suggest` then `compaction_apply`:');
      for (const c of candidates) lines.push(`- ${c}`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] compaction check failed: ${e}\n`);
  }

  lines.push(
    '',
    '_Hooks ran recall + task_list automatically. You do not need to repeat these unless you need a more specific query._',
  );

  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  });
}

export async function userPromptSubmit(input: UserPromptSubmitInput): Promise<void> {
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;
  const prompt = (input.prompt ?? '').trim();

  if (!prompt) {
    emit({});
    return;
  }

  const lines: string[] = ['# YAPA Recall', '', `${scopeLine(detection)}  **Query:** ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`];

  try {
    const recall = await recallMemory(prompt, { collection, nResults: 3 });
    if (recall.length === 0) {
      emit({});
      return;
    }
    lines.push('', '## Top matches');
    for (const r of recall) {
      const sal = r.metadata.salience?.toFixed(2) ?? '?';
      const dist = r.distance.toFixed(3);
      const snippet = r.content.length > 240 ? r.content.slice(0, 240) + '…' : r.content;
      lines.push(`- **${r.id}** (salience ${sal}, distance ${dist}): ${snippet}`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] memory_recall failed: ${e}\n`);
    emit({});
    return;
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: lines.join('\n'),
    },
  });
}

export async function stop(_input: StopInput): Promise<void> {
  // Stop hooks don't accept hookSpecificOutput.additionalContext, and emitting
  // `systemMessage` on every turn is too noisy. The CLAUDE.md rules already
  // direct the agent to call journal_append / memory_store / task_create as
  // findings appear, so this hook stays silent.
  emit({});
}

export async function sessionEnd(input: SessionEndInput): Promise<void> {
  const sid = input.session_id;
  if (!sid) {
    emit({});
    return;
  }
  process.stderr.write(`[yapa-hook] SessionEnd for ${sid} (reason: ${input.reason ?? 'unknown'}). Pending journal drafts will be surfaced at next session start.\n`);
  emit({});
}
