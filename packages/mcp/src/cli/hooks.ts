import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getConfig,
  setConfig,
  createConfig,
  recallMemory,
  listMemories,
  listTasks,
  listCollections,
  collectionSize,
  detectCollection,
  pullCollection,
  getSyncPullTimestamp,
  isSyncConfigured,
  resolveSyncUsername,
  captureTurn,
  storeMemory,
  consolidateStaleDrafts,
  type CollectionDetection,
  isSyncableCollection,
} from '@yapa/core';

import { CLAUDE_CODE_RULES } from '../rules.js';

interface BaseHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface SessionStartInput extends BaseHookInput {
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
}

interface UserPromptSubmitInput extends BaseHookInput {
  prompt?: string;
}

interface StopInput extends BaseHookInput {
  stop_hook_active?: boolean;
  /** Final assistant response text for the turn (Claude Code supplies it). */
  last_assistant_message?: string;
}

interface PostCompactInput extends BaseHookInput {
  trigger?: 'manual' | 'auto';
  compact_summary?: string;
}

interface SessionEndInput extends BaseHookInput {
  reason?: string;
}

/** Re-read the remote this many seconds before the last pull (clock skew, mid-pull pushes). */
const HOOK_PULL_OVERLAP_SECONDS = 600;
/** Budget for the session-start fallback that rolls up crashed sessions' journal drafts. */
const STALE_JOURNAL_BUDGET_MS = 2000;

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload));
}

function context(event: string, lines: string[]): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } });
}

/** The `**Scope:**` line for emitted context, flagging ambiguity if present. */
function scopeLine(d: CollectionDetection): string {
  if (!d.ambiguous) return `**Scope:** \`${d.collection}\``;
  return `**Scope:** AMBIGUOUS — both \`${d.ambiguous[0]}\` and \`${d.ambiguous[1]}\` exist for this folder. Ask the user which collection to use BEFORE storing anything. (Reads here default to \`${d.collection}\`.)`;
}

/** ", by <user>" for items a teammate wrote; empty for your own. ("from" is reserved for collections.) */
export function attribution(metadata: Record<string, any>): string {
  const who = metadata?.origin_user;
  return who && who !== getConfig().USERNAME ? `, by ${who}` : '';
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([work, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms).unref())]);
}

/**
 * Pull teammates' latest writes for just the active collection before recall,
 * so a memory pushed seconds ago shows up on this prompt instead of after the
 * MCP server's next interval pull. Bounded and fail-open: a slow or
 * unreachable remote only costs HOOK_PULL_TIMEOUT_MS.
 */
export async function freshenFromRemote(collection: string): Promise<number> {
  const config = getConfig();
  if (!isSyncConfigured(config)) return 0;
  // global/private-*/local-* never sync: skip the sign-in and the request.
  if (!isSyncableCollection(collection)) return 0;
  try {
    const since = Math.max(0, (await getSyncPullTimestamp()) - HOOK_PULL_OVERLAP_SECONDS);
    // The service's username (Google account) drives "by <user>" attribution.
    const stats = await withTimeout(resolveSyncUsername().then(() => pullCollection(collection, since)), config.HOOK_PULL_TIMEOUT_MS);
    if (!stats) {
      process.stderr.write(`[yapa-hook] remote pull for ${collection} timed out\n`);
      return 0;
    }
    return stats.pulled + stats.updated;
  } catch (e) {
    process.stderr.write(`[yapa-hook] remote pull for ${collection} failed: ${e}\n`);
    return 0;
  }
}

// --- Per-session hook state (turn buffer, capture notices) -----------------

/** Hook processes are short-lived; per-session state lives in small files. */
function stateDir(): string {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), `yapa-hooks-${process.getuid?.() ?? 'user'}`);
  const dir = join(base, 'sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile(sessionId: string, kind: 'turn' | 'notice'): string {
  return join(stateDir(), `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.${kind}`);
}

interface TurnState {
  prompt: string;
  turn: number;
}

function readTurn(sessionId: string): TurnState | undefined {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId, 'turn'), 'utf-8'));
  } catch {
    return undefined;
  }
}

function recordPrompt(sessionId: string | undefined, prompt: string): void {
  if (!sessionId) return;
  try {
    const turn = (readTurn(sessionId)?.turn ?? 0) + 1;
    writeFileSync(stateFile(sessionId, 'turn'), JSON.stringify({ prompt, turn } satisfies TurnState));
  } catch (e) {
    process.stderr.write(`[yapa-hook] could not buffer prompt: ${e}\n`);
  }
}

/** Take (and clear) the capture notice the last Stop hook left for this session. */
function takeNotice(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const file = stateFile(sessionId, 'notice');
  try {
    const notice = readFileSync(file, 'utf-8').trim();
    rmSync(file, { force: true });
    return notice || undefined;
  } catch {
    return undefined;
  }
}

// --- Hooks -------------------------------------------------------------------

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
  const pulled = await freshenFromRemote(collection);

  const lines: string[] = [];
  if (getConfig().HOOK_INJECT_RULES) lines.push(CLAUDE_CODE_RULES, '');
  lines.push('# YAPA Context', '', scopeLine(detection));
  if (pulled) lines.push(`_Pulled ${pulled} new or updated item(s) from the team sync._`);
  const notice = takeNotice(input.session_id);
  if (notice) lines.push(`_${notice}_`);

  try {
    const tasks = await listTasks({ collection, includeComplete: false });
    if (tasks.length) {
      lines.push('', '## Open tasks');
      for (const t of tasks.slice(0, 10)) {
        const status = t.metadata.status ?? 'open';
        const prio = t.metadata.priority ? `, ${t.metadata.priority}` : '';
        lines.push(`- **${t.id}** [${status}${prio}${attribution(t.metadata)}] ${t.title}`);
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
        lines.push(`- **${r.id}** (salience ${sal}${attribution(r.metadata)}): ${snippet}`);
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

  // Sessions that died without their MCP server consolidating (crash, kill):
  // roll up their day-old drafts. Bounded so startup never stalls on it.
  if (input.source !== 'compact') {
    await withTimeout(consolidateStaleDrafts().catch(() => []), STALE_JOURNAL_BUDGET_MS);
  }

  lines.push(
    '',
    '_Hooks ran recall + task_list automatically. You do not need to repeat these unless you need a more specific query._',
  );
  context('SessionStart', lines);
}

export async function userPromptSubmit(input: UserPromptSubmitInput): Promise<void> {
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;
  const prompt = (input.prompt ?? '').trim();

  if (!prompt) {
    emit({});
    return;
  }
  recordPrompt(input.session_id, prompt);
  await freshenFromRemote(collection);

  const lines: string[] = ['# YAPA Recall', '', `${scopeLine(detection)}  **Query:** ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`];
  const notice = takeNotice(input.session_id);
  if (notice) lines.push(`_${notice}_`);

  try {
    const recall = await recallMemory(prompt, { collection, nResults: 3, crossCollection: getConfig().CROSS_COLLECTION_RESULTS });
    if (recall.length === 0 && !notice) {
      emit({});
      return;
    }
    if (recall.length) lines.push('', '## Top matches');
    for (const r of recall) {
      const sal = r.metadata.salience?.toFixed(2) ?? '?';
      const dist = r.distance.toFixed(3);
      const snippet = r.content.length > 240 ? r.content.slice(0, 240) + '…' : r.content;
      const where = r.collection && r.collection !== collection ? `, from \`${r.collection}\`` : '';
      lines.push(`- **${r.id}** (salience ${sal}, distance ${dist}${where}${attribution(r.metadata)}): ${snippet}`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] memory_recall failed: ${e}\n`);
    emit({});
    return;
  }

  context('UserPromptSubmit', lines);
}

/**
 * Response capture (opt-in: YAPA_RESPONSE_CAPTURE=true). Runs as an async
 * Stop hook: judges the finished turn (buffered prompt + Claude Code's
 * `last_assistant_message`) with the aux LLM and stores durable findings. The
 * outcome surfaces as a one-line notice on the next prompt's context.
 */
export async function stop(input: StopInput): Promise<void> {
  emit({}); // never blocks or alters the stop; all work below is best-effort
  const config = getConfig();
  if (!config.RESPONSE_CAPTURE || input.stop_hook_active || !input.session_id) return;

  const assistantText = (input.last_assistant_message ?? '').trim();
  const turn = readTurn(input.session_id);
  const userText = turn?.prompt ?? '';
  if (!assistantText || userText.length + assistantText.length < config.CAPTURE_MIN_CHARS) return;

  // Subscription users have no API key: route the aux call through `claude -p`.
  if (config.CURATION_LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    setConfig({ ...config, CURATION_LLM_PROVIDER: 'claude-cli', CURATION_MODEL: config.CURATION_MODEL || 'haiku' });
  }

  try {
    const { collection } = await detectCollection(input.cwd);
    const result = await captureTurn(
      { collection, sessionId: input.session_id, turn: turn?.turn ?? 0, userText, assistantText },
      { maxMemories: config.CAPTURE_MAX_MEMORIES, maxSalience: config.CAPTURE_MAX_SALIENCE, dedupeDistance: config.CAPTURE_DEDUPE_DISTANCE },
    );
    if (result.notice) writeFileSync(stateFile(input.session_id, 'notice'), result.notice);
  } catch (e) {
    process.stderr.write(`[yapa-hook] response capture failed (non-fatal): ${e}\n`);
  }
}

/**
 * Context compaction already distilled the conversation; keep that summary
 * as an episodic memory so it outlives the context window.
 */
export async function postCompact(input: PostCompactInput): Promise<void> {
  emit({});
  const summary = (input.compact_summary ?? '').trim();
  if (!getConfig().CAPTURE_COMPACTION || !summary) return;
  try {
    const { collection } = await detectCollection(input.cwd);
    await storeMemory(`# Conversation compaction summary\n\n${summary}`, {
      collection,
      tags: ['compaction', 'journal'],
      salience: 1.5,
      sector: 'episodic',
      metadata: { source: 'compaction', session_id: input.session_id, trigger: input.trigger },
    });
  } catch (e) {
    process.stderr.write(`[yapa-hook] compaction capture failed (non-fatal): ${e}\n`);
  }
}

export async function sessionEnd(input: SessionEndInput): Promise<void> {
  emit({});
  // Journal consolidation and the final sync push happen in the MCP server's
  // own shutdown (it owns the journal session id); here we only drop this
  // session's hook state.
  if (!input.session_id) return;
  for (const kind of ['turn', 'notice'] as const) {
    try { rmSync(stateFile(input.session_id, kind), { force: true }); } catch { /* ignore */ }
  }
}

/** Test hook: re-resolve config from the current env. */
export function reloadConfig(): void {
  setConfig(createConfig(process.env));
}
