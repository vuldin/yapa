import { recallMemory } from '../memory/recall.js';
import { listMemories } from '../memory/list.js';
import { listTasks } from '../tasks/list.js';
import { listCollections } from '../chroma.js';
import { COMPACTION_THRESHOLD } from '../config.js';
import { collectionSize } from '../memory/compact.js';

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
 * Infer the active collection from cwd. Returns the most specific collection
 * that exists, falling back through customer-{name} → project-{name} → global.
 */
async function detectCollection(cwd: string | undefined): Promise<string> {
  if (!cwd) return 'global';
  if (!cwd.startsWith(PROJECTS_ROOT)) return 'global';

  const relative = cwd.slice(PROJECTS_ROOT.length).replace(/^\/+/, '');
  if (!relative) return 'global';

  const segment = relative.split('/')[0];
  if (!segment || segment.startsWith('.')) return 'global';

  const existing = (await listCollections().catch(() => [])).map(c => c.name);
  if (existing.includes(`customer-${segment}`)) return `customer-${segment}`;
  if (existing.includes(`project-${segment}`)) return `project-${segment}`;
  return `customer-${segment}`;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload));
}

async function findCompactionCandidates(): Promise<string[]> {
  const cols = await listCollections().catch(() => []);
  const out: string[] = [];
  for (const c of cols) {
    const size = await collectionSize(c.name).catch(() => 0);
    if (size >= COMPACTION_THRESHOLD) out.push(`${c.name} (${size})`);
  }
  return out;
}

export async function sessionStart(input: SessionStartInput): Promise<void> {
  const collection = await detectCollection(input.cwd);

  const lines: string[] = ['# YAPA Context', '', `**Scope:** \`${collection}\``];

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
  const collection = await detectCollection(input.cwd);
  const prompt = (input.prompt ?? '').trim();

  if (!prompt) {
    emit({});
    return;
  }

  const lines: string[] = ['# YAPA Recall', '', `**Scope:** \`${collection}\`  **Query:** ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`];

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
