import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getConfig,
  setConfig,
  createConfig,
  recallMemory,
  listMemories,
  isSessionSummary,
  listTasks,
  listCollections,
  collectionSize,
  captureDownLine,
  recordCapture,
  staleFindings,
  detectCollection,
  scopeNotes,
  pullCollection,
  getSyncPullTimestamp,
  getSyncSubscriptions,
  addSyncSubscriptions,
  updateSyncSubscriptions,
  getUnfollowedCollections,
  getPendingBackfills,
  clearPendingBackfill,
  isSyncConfigured,
  resolveSyncUsername,
  captureTurn,
  storeMemory,
  consolidateStaleDrafts,
  type CollectionDetection,
  isSyncableCollection,
  currentSession,
  claimNote,
  takeClaimNotices,
  heartbeatIfDue,
  requireCoordination,
  type Lease,
  noteSyncOk,
  readSyncHealth,
  type SyncHealth,
  waitingOn,
  waitingLine,
  includesUser,
  fenceWaiting,
  heldKeys,
  noteInstalledVersion,
  markUpdateNotified,
  noteSessionStarting,
  recordSessionScope,
  refreshSyncHealthNames,
  shouldPull,
  recordPull,
} from '@yapa/core';

import { CLAUDE_CODE_RULES } from '../rules.js';
import { copyScript, defaultSettingsPath, hasStatusLine, installStatusLine, REMOVED_MARKER } from './statusline.js';
import { YAPA_VERSION } from '../version.js';

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
/** Budgets for lease presence (session start) and the automatic heartbeat (prompt path). */
const LEASE_LIST_BUDGET_MS = 1500;
const HEARTBEAT_BUDGET_MS = 1500;

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload));
}

function context(event: string, lines: string[]): void {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } });
}

/** The `**Scope:**` line for emitted context, flagging ambiguity if present. */
function scopeLine(d: CollectionDetection): string {
  if (!d.ambiguous) return `**Scope:** \`${d.collection}\`${scopeNotes(d)}`;
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
export async function freshenFromRemote(collection: string, opts: { gate?: boolean } = {}): Promise<number> {
  const config = getConfig();
  if (!isSyncConfigured(config)) return 0;
  // global/private-*/local-* never sync: skip the sign-in and the request.
  if (!isSyncableCollection(collection)) return 0;
  try {
    // Merged away or left on this machine: teammates' rows must not bring it back.
    if ((await getUnfollowedCollections()).has(collection)) return 0;
    // First visit to a shared collection (a teammate's project folder, or one
    // named in the prompt): pull its whole history, then follow it so the
    // background sync keeps it current. Subscribe only after the backfill
    // finished, so a pull cut off by the timeout simply retries next prompt.
    // Followed again after leaving it: pull its whole history like a first visit.
    const pendingBackfill = (await getPendingBackfills()).includes(collection);
    const followed = (await getSyncSubscriptions()).includes(collection) && !pendingBackfill;
    // Another session (or the shared cycle) pulled it moments ago: nothing new
    // worth a request. A first visit (backfill) is never skipped.
    if (opts.gate && followed && !shouldPull(collection)) return 0;
    const since = followed ? Math.max(0, (await getSyncPullTimestamp()) - HOOK_PULL_OVERLAP_SECONDS) : 0;
    // The service's username (Google account) drives "by <user>" attribution.
    const stats = await withTimeout(resolveSyncUsername().then(() => pullCollection(collection, since)), config.HOOK_PULL_TIMEOUT_MS);
    if (!stats) {
      process.stderr.write(`[yapa-hook] remote pull for ${collection} timed out\n`);
      return 0;
    }
    if (stats.errors === 0) {
      noteSyncOk();
      recordPull(collection);
      if (pendingBackfill) await clearPendingBackfill(collection);
    }
    if (!followed && stats.errors === 0) {
      await addSyncSubscriptions([collection]);
    }
    return stats.pulled + stats.updated;
  } catch (e) {
    process.stderr.write(`[yapa-hook] remote pull for ${collection} failed: ${e}\n`);
    return 0;
  }
}

// --- Sync health (status line) -----------------------------------------------

/**
 * One context line while sync is down, so Claude knows writes are not
 * reaching teammates (and why) instead of claiming they are shared.
 */
export function syncDownLine(health: SyncHealth | undefined = readSyncHealth()): string | undefined {
  if (!health || !isSyncConfigured(getConfig())) return undefined;
  const since = health.since ? ` since ${new Date(health.since).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  switch (health.status) {
    case 'signed_out':
      return `_YAPA sync is signed out${since}: writes stay on this machine until the user ${health.sign_in ? `signs in again (${health.sign_in})` : 'runs `gcloud auth login`'} (sync resumes by itself, no restart)._`;
    case 'unreachable':
      return `_YAPA sync service is unreachable${since}: writes stay on this machine and push when it is back._`;
    case 'error':
      return `_YAPA sync is failing${since}${health.message ? ` (${health.message.slice(0, 160)})` : ''}: writes stay on this machine for now._`;
    default:
      return undefined;
  }
}

/** Where the status line script lives: beside the health file, outside the versioned plugin folder. */
export function statusLineScriptPath(): string | undefined {
  const health = getConfig().SYNC_HEALTH_FILE;
  return health ? join(dirname(health), 'statusline.mjs') : undefined;
}

/** The script shipped with this build (plugin: dist/statusline.mjs; npm build: dist/cli/statusline.js). */
export function bundledStatusLineScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return ['statusline.mjs', 'statusline.js'].map(f => join(here, f)).find(p => existsSync(p));
}

/**
 * Keep the stable copy current (plugin updates reach the status line). With
 * the option `statusline` on (the default), add YAPA's status line to the
 * user's Claude Code settings, wrapping one they already have, unless they
 * removed it before. With it off, the first time on this device with sync on
 * but no status line, return a hint line telling Claude how to add one.
 */
export function prepareStatusLine(
  from: string | undefined = bundledStatusLineScript(),
  settingsPath: string = defaultSettingsPath(),
): string | undefined {
  const to = statusLineScriptPath();
  if (!to) return undefined;
  try {
    if (from) copyScript(from, to);
  } catch (e) {
    process.stderr.write(`[yapa-hook] status line script copy failed: ${e}\n`);
  }
  refreshSyncHealthNames(isSyncConfigured(getConfig()));
  if (hasStatusLine(settingsPath, to)) return undefined;
  if (getConfig().STATUSLINE) {
    // Added once before and gone now: the user removed it (by hand or with
    // --uninstall), so leave it removed. /yapa:statusline adds it back.
    const added = join(dirname(to), 'statusline-added');
    if (existsSync(join(dirname(to), REMOVED_MARKER)) || existsSync(added) || !existsSync(to)) return undefined;
    try {
      installStatusLine(to, settingsPath);
      try {
        writeFileSync(added, `${new Date().toISOString()}\n`);
      } catch {
        // without the marker a hand removal is undone next session; --uninstall still sticks
      }
      return `_YAPA added its status line (version, remote, sync health) under the prompt in ${settingsPath}; mention it once. To remove it: \`node "${to}" --uninstall\`._`;
    } catch (e) {
      process.stderr.write(`[yapa-hook] status line install failed: ${e}\n`);
      return undefined;
    }
  }
  if (!isSyncConfigured(getConfig())) return undefined;
  const marker = join(dirname(to), 'statusline-hint');
  if (existsSync(marker)) return undefined;
  try {
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch {
    return undefined; // could not remember it: better silent than repeated
  }
  const how = process.env.CLAUDE_PLUGIN_ROOT ? '`/yapa:statusline`' : `\`node "${to}" --install\``;
  return `_Mention once to the user: they can show YAPA sync health under the prompt with ${how}._`;
}

/**
 * Record the version running now (the status line shows it, and an update
 * note clears itself once installed), and the first session after a newer
 * release is seen, tell Claude how the user updates.
 */
export function updateLine(): string | undefined {
  const state = noteInstalledVersion(YAPA_VERSION);
  if (!state?.latest || state.notified === state.latest) return undefined;
  markUpdateNotified(state.latest);
  const how = process.env.CLAUDE_PLUGIN_ROOT
    ? '`claude plugin marketplace update yapa && claude plugin update yapa@yapa`, then restart Claude Code'
    : '`git pull && npm install && npm run build` in the YAPA checkout, then restart Claude Code';
  return `_YAPA ${state.latest} is out (running ${YAPA_VERSION}). Tell the user once; to update: ${how}._`;
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

// --- Leases: automatic heartbeat and presence --------------------------------

/**
 * The hook input's session and the Claude Code session id in the env: they
 * can differ after /clear (the MCP server keeps the id it started with), and
 * a lease taken under either should stay alive while this session is active.
 */
function leaseSessions(input: BaseHookInput): Array<string | undefined> {
  return [input.session_id, currentSession()];
}

/** Renew this session's leases when due. Only sessions that hold leases ever reach the network. */
async function keepLeasesAlive(input: BaseHookInput): Promise<void> {
  try {
    await withTimeout(heartbeatIfDue(leaseSessions(input)), HEARTBEAT_BUDGET_MS);
  } catch (e) {
    process.stderr.write(`[yapa-hook] lease heartbeat failed (non-fatal): ${e}\n`);
  }
}

const relTime = (secs: number) => (secs < 120 ? `${secs}s` : secs < 7200 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`);

/** Lines for the session-start block: who holds what in the active collection right now. */
export function presenceLines(leases: Lease[], now: number, mySessions: Array<string | undefined>, me: string): string[] {
  if (!leases.length) return [];
  const mine = new Set(mySessions.filter(Boolean));
  const out = ['', '## Work in progress (leases)'];
  for (const l of leases.slice(0, 10)) {
    const who = l.holder.user === me
      // Your own sessions in full: an abbreviated id gets copied back as a session name.
      ? (mine.has(l.holder.session) ? 'you (this session)' : `you (another session, ${l.holder.session})`)
      : l.holder.user;
    const title = l.title ? ` ${l.title}` : '';
    out.push(`- **${l.key}**${title}: ${who}, for ${relTime(Math.max(0, now - l.acquired_at))}, expires in ${relTime(Math.max(0, l.expires_at - now))}`);
  }
  if (leases.length > 10) out.push(`- _…${leases.length - 10} more (\`lease\` action \`list\`)_`);
  return out;
}

/**
 * Live leases in the active collection: the presence block, plus the claims
 * by key so open tasks can say who holds them. `claims` is undefined when they
 * could not be read (no holders shown rather than guessed).
 */
async function presence(collection: string, input: BaseHookInput): Promise<{ lines: string[]; claims?: Map<string, Lease> }> {
  // Shared collections ask the service; local-only ones (and all with sync off) this machine.
  try {
    const r = await withTimeout((async () => (await requireCoordination()).leaseList(collection))(), LEASE_LIST_BUDGET_MS);
    if (!r) return { lines: [] };
    const live = r.leases.filter(l => !l.expired);
    return { lines: presenceLines(r.leases, r.now, leaseSessions(input), getConfig().USERNAME), claims: new Map(live.map(l => [l.key, l])) };
  } catch {
    return { lines: [] }; // offline, older service, signed out: presence is optional
  }
}

/** Claim notices (a claim taken over, an offline claim that clashed) as context lines. */
function claimNoticeLines(): string[] {
  return takeClaimNotices().map(n => `**YAPA claim:** ${n}`);
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

/**
 * "## Waiting on you": decisions, questions and person-only steps that name
 * this user, across every collection, plus a count of those for anyone. Empty
 * when nothing waits (or the read is slow: session start never waits on it).
 * In a shared `collection`, items from private-* and local-* collections are fenced out (only
 * counted), like recall's cross-collection extras.
 */
export async function waitingLines(user: string, budgetMs = 2000, collection = 'global'): Promise<string[]> {
  try {
    const all = await Promise.race([
      waitingOn({ user }),
      new Promise<undefined>(res => setTimeout(() => res(undefined), budgetMs).unref()),
    ]);
    if (!all) return [];
    const { waiting: w, hidden } = fenceWaiting(all, collection);
    const items = [...w.decisions, ...w.questions, ...w.actions, ...w.blocked];
    const mine = items.filter(i => includesUser(i.for, user));
    const anyone = items.filter(i => i.for.length === 0).length;
    if (!mine.length && !anyone && !hidden) return [];
    const out = ['', '## Waiting on you'];
    for (const i of mine.slice(0, 8)) out.push(waitingLine(i, { collection: true }));
    if (mine.length > 8) out.push(`- _…${mine.length - 8} more (call \`waiting\`)_`);
    if (anyone) out.push(`- _${anyone} item(s) wait on anyone with the role (call \`waiting\`)_`);
    if (hidden) out.push(`- _${hidden} more in private collections, not listed in this shared scope (call \`waiting\` to see them)_`);
    out.push('Tell the user about these when relevant; record a choice with `memory_update` (status accepted), never only in chat.');
    return out;
  } catch (e) {
    process.stderr.write(`[yapa-hook] waiting failed: ${e}\n`);
    return [];
  }
}

export async function sessionStart(input: SessionStartInput): Promise<void> {
  // First: the status line waits for this session's server to report from now (also on resume).
  noteSessionStarting(input.session_id);
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;
  recordSessionScope(input.session_id, collection);
  const pulled = await freshenFromRemote(collection);

  const lines: string[] = [];
  if (getConfig().HOOK_INJECT_RULES) lines.push(CLAUDE_CODE_RULES, '');
  lines.push('# YAPA Context', '', scopeLine(detection));
  if (pulled) lines.push(`_Pulled ${pulled} new or updated item(s) from the team sync._`);
  const down = syncDownLine();
  if (down) lines.push(down);
  const captureDown = captureDownLine();
  if (captureDown) lines.push(captureDown);
  const hint = prepareStatusLine();
  if (hint) lines.push(hint);
  const update = updateLine();
  if (update) lines.push(update);
  const notice = takeNotice(input.session_id);
  if (notice) lines.push(`_${notice}_`);
  const [held] = await Promise.all([presence(collection, input), keepLeasesAlive(input)]);
  lines.push(...claimNoticeLines());

  try {
    const tasks = await listTasks({ collection, includeComplete: false });
    if (tasks.length) {
      lines.push('', '## Open tasks');
      for (const t of tasks.slice(0, 10)) {
        const status = t.metadata.status ?? 'open';
        const prio = t.metadata.priority ? `, ${t.metadata.priority}` : '';
        const claim = claimNote(t, held.claims, leaseSessions(input));
        lines.push(`- **${t.id}** [${status}${prio}${attribution(t.metadata)}${claim ? `; ${claim}` : ''}] ${t.title}`);
      }
      if (tasks.length > 10) lines.push(`- _…${tasks.length - 10} more (call \`task_list\` for the full list)_`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] task_list failed: ${e}\n`);
  }

  lines.push(...await waitingLines(getConfig().USERNAME, undefined, collection));

  lines.push(...held.lines);

  try {
    const memories = (await listMemories({ collection, limit: 25 })).filter(r => !isSessionSummary(r.metadata)).slice(0, 5);
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

  try {
    const stale = (await staleFindings(collection)).length;
    if (stale >= getConfig().FINDINGS_CLEANUP_THRESHOLD) {
      lines.push('', '## Findings backlog', `${stale} of your open findings in ${collection} have had no disposition for over two days. \`yapa memory sweep-findings --collection ${collection} --save FILE\` lists the ones that are only progress notes or superseded (\`--apply --from FILE\` closes them once checked); give the rest a disposition with \`memory_update\`.`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-hook] findings check failed: ${e}\n`);
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

/**
 * The user's own words in a prompt, without the background-task events
 * Claude Code delivers through the same hook: `<task-notification>` blocks
 * (a finished background command, a Monitor event) and the
 * "[SYSTEM NOTIFICATION - NOT USER INPUT]" preamble that can introduce them.
 * Empty when the prompt is nothing but notifications.
 */
export function userText(prompt: string): string {
  if (!prompt.includes('<task-notification') && !prompt.includes('[SYSTEM NOTIFICATION')) return prompt.trim();
  return prompt
    .replace(/<task-notification>[\s\S]*?(<\/task-notification>|$)/g, '')
    // The preamble runs to the first blank line (or the end).
    .replace(/\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?(\n\s*\n|$)/g, '')
    .replace(/<system-reminder>\s*<\/system-reminder>/g, '')
    .trim();
}

export async function userPromptSubmit(input: UserPromptSubmitInput): Promise<void> {
  const raw = (input.prompt ?? '').trim();
  const prompt = userText(raw);

  if (!prompt) {
    emit({});
    // A notification-only prompt: no recall, nothing recorded as the user's
    // turn, and any capture notice waits for a real prompt. But a session
    // waiting on a long background job may see nothing else for hours, so its
    // leases still have to be renewed.
    if (raw) await keepLeasesAlive(input);
    return;
  }
  const detection = await detectCollection(input.cwd);
  const collection = detection.collection;
  recordSessionScope(input.session_id, collection);
  recordPrompt(input.session_id, prompt);
  await Promise.all([freshenFromRemote(collection, { gate: true }), keepLeasesAlive(input)]);

  const lines: string[] = ['# YAPA Recall', '', `${scopeLine(detection)}  **Query:** ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`];
  const notice = takeNotice(input.session_id);
  if (notice) lines.push(`_${notice}_`);
  const down = syncDownLine();
  if (down) lines.push(down);
  const claimNotices = claimNoticeLines();
  lines.push(...claimNotices);

  try {
    const recall = await recallMemory(prompt, { collection, nResults: 3, crossCollection: getConfig().CROSS_COLLECTION_RESULTS });
    if (recall.length === 0 && !notice && !down && !claimNotices.length) {
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
 * Response capture (on unless YAPA_RESPONSE_CAPTURE=false). Runs as an async
 * Stop hook: judges the finished turn (buffered prompt + Claude Code's
 * `last_assistant_message`) with the aux LLM and stores durable findings. The
 * outcome surfaces as a one-line notice on the next prompt's context.
 */
export async function stop(input: StopInput): Promise<void> {
  emit({}); // never blocks or alters the stop; all work below is best-effort
  await keepLeasesAlive(input); // a long turn ends: renew before the session may go quiet
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
      {
        maxMemories: config.CAPTURE_MAX_MEMORIES, maxSalience: config.CAPTURE_MAX_SALIENCE, dedupeDistance: config.CAPTURE_DEDUPE_DISTANCE,
        // Typed captures belong to the task this session is on.
        taskIds: heldKeys(currentSession(input.session_id) ?? input.session_id, collection).filter(k => !k.startsWith('cleanup:')),
      },
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
    recordCapture({ kind: 'compaction' });
  } catch (e) {
    recordCapture({ kind: 'compaction', error: e });
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
