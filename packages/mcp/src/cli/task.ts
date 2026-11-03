/**
 * `yapa task`: tasks for scripts and project tooling, with the same claims
 * the MCP tools take. Each command prints one JSON object on stdout (--text:
 * a short summary) and exits like `yapa coord`:
 *
 *   0  done (listed, claimed, renewed, released)
 *   3  refused (someone else holds the task)
 *   4  done locally but NOT shared (offline, signed out): others may take it
 *   2  bad arguments
 *   1  any other error
 */
import { readFileSync } from 'node:fs';
import {
  claimKey, claimNote, claimSession, claimsFor, completeTask, describeClaim, getTask, listTasks, nextTasks, pushDocsNow, recordForTask,
  recordLastWrite, releaseTaskClaim, requestDecision, TaskClaimedError, TypedMemoryError, updateTask, validateLearned,
  type ClaimResult, type DecisionNeeded, type FollowUp, type LearnedItem, type Lease, type TaskStatus,
} from '@yapa/core';
import { EXIT } from '../coord.js';

export const TASK_USAGE =
  'Usage: yapa task list    [--collection C] [--status S] [--tag a,b] [--include-complete]\n' +
  '       yapa task next    --collection C [--tag a,b] [--exclude-tag a,b] [--auto-only] [--include-cleanup] [--claim [claim options]]\n' +
  '       yapa task claim   ID|cleanup:KIND [--collection C] [--session S] [--scope a,b] [--ttl SECONDS] [--title T] [--reclaim]\n' +
  '       yapa task release ID --status pending|blocked|complete [--reason R] [--note N] [--tag a,b] [--duration MIN]\n' +
  '                         [--waits-on MEM,..] [--learned-file F] [--follow-ups-file F] [--decision-needed-file F] [--session S]\n' +
  '       yapa task release cleanup:KIND --collection C [--session S]\n' +
  '       yapa task show    ID\n' +
  'claim moves the task to in_progress and takes a lease on its id (shared collections); release sets the new\n' +
  'status and releases it. A cleanup:KIND key (from next) is a lease only. --learned-file and --follow-ups-file\n' +
  'hold a JSON array (learned: {content, kind, status, ...}; follow-ups: {title, priority, tags, notes});\n' +
  '--decision-needed-file a JSON object {question, options, recommendation, owner, context} (the task then waits\n' +
  'on it, pending). "-" reads stdin. --session defaults to $YAPA_SESSION, then $CLAUDE_CODE_SESSION_ID, else this process.\n' +
  'Prints one JSON object (--text: a short summary).\n' +
  'Exit: 0 done, 3 refused (held by someone else), 4 done locally but not shared, 2 bad arguments, 1 other error.\n';

export interface TaskCliResult {
  exit: number;
  json: Record<string, unknown>;
  text: string;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const list = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map(x => x.trim()).filter(Boolean));

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer`);
  return n;
}

class UsageError extends Error {}

const STATUSES = ['pending', 'in_progress', 'blocked', 'complete'];

function taskJson(t: { id: string; title: string; collection: string; metadata: Record<string, any> }, claims?: Map<string, Lease>) {
  const m = t.metadata;
  const lease = claims?.get(t.id);
  return {
    id: t.id, title: t.title, collection: t.collection, status: m.status, priority: m.priority,
    tags: Array.isArray(m.tags) ? m.tags : String(m.tags ?? '').split(',').filter(Boolean),
    depends_on: Array.isArray(m.depends_on) ? m.depends_on : String(m.depends_on ?? '').split(',').filter(Boolean),
    blocks: Array.isArray(m.blocks) ? m.blocks : String(m.blocks ?? '').split(',').filter(Boolean),
    claim_scope: Array.isArray(m.claim_scope) ? m.claim_scope : String(m.claim_scope ?? '').split(',').filter(Boolean),
    waits_on: Array.isArray(m.waits_on) ? m.waits_on : String(m.waits_on ?? '').split(',').filter(Boolean),
    memory_ids: Array.isArray(m.memory_ids) ? m.memory_ids : String(m.memory_ids ?? '').split(',').filter(Boolean),
    blocked_reason: m.blockedReason || m.blocked_reason || null,
    notes: m.notes ?? '', due_date: m.due_date || null, owner: m.origin_user ?? null,
    created_at: m.created_at ?? null, updated_at: m.updated_at ?? null,
    claim: lease ? { user: lease.holder.user, session: lease.holder.session, since: lease.acquired_at, expires_at: lease.expires_at } : null,
    claim_note: claimNote(t, claims) || null,
  };
}

function claimExit(c: ClaimResult | undefined): number {
  if (c?.kind === 'refused') return EXIT.refused;
  if (c?.kind === 'unshared') return EXIT.unavailable;
  return EXIT.ok;
}

function claimJson(c: ClaimResult | undefined) {
  if (!c) return null;
  const base = { kind: c.kind, id: c.id };
  switch (c.kind) {
    case 'granted': return { ...base, session: c.session, renewed: c.renewed, lease: c.lease, took_over_from: c.tookOverFrom ?? null };
    case 'refused': return { ...base, session: c.session, conflicts: c.conflicts };
    case 'unshared': return { ...base, session: c.session, reason: c.reason };
    default: return base;
  }
}

export async function runTask(sub: string | undefined, args: string[]): Promise<TaskCliResult> {
  try {
    return await dispatch(sub, args);
  } catch (e) {
    if (e instanceof TaskClaimedError) {
      return { exit: EXIT.refused, json: { ok: false, refused: true, claim: claimJson(e.result) }, text: e.message };
    }
    const usage = e instanceof UsageError || e instanceof TypedMemoryError;
    const message = e instanceof Error ? e.message : String(e);
    return { exit: usage ? EXIT.usage : EXIT.error, json: { ok: false, error: message }, text: `yapa task ${sub ?? ''}: ${message}` };
  }
}

async function dispatch(sub: string | undefined, args: string[]): Promise<TaskCliResult> {
  const positional = args.find(a => !a.startsWith('--') && !isFlagValue(args, a));
  const session = flag(args, '--session');
  const claimOpts = {
    session,
    scope: list(flag(args, '--scope')),
    ttlSeconds: int(flag(args, '--ttl'), '--ttl'),
    title: flag(args, '--title'),
    reclaim: args.includes('--reclaim') || undefined,
  };
  switch (sub) {
    case 'list': {
      const status = flag(args, '--status');
      if (status && !STATUSES.includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(', ')}`);
      const collection = flag(args, '--collection');
      const wantTags = list(flag(args, '--tag')) ?? [];
      const tasks = (await listTasks({ collection, status: status as TaskStatus | undefined, includeComplete: args.includes('--include-complete') }))
        .filter(t => {
          if (!wantTags.length) return true;
          const tags = Array.isArray(t.metadata.tags) ? t.metadata.tags : String(t.metadata.tags ?? '').split(',');
          return wantTags.every(x => tags.includes(x));
        });
      const claims = collection ? await claimsFor(collection) : undefined;
      return { exit: EXIT.ok, json: { ok: true, tasks: tasks.map(t => taskJson(t, claims)) }, text: `${tasks.length} task(s)` };
    }
    case 'show': {
      if (!positional) throw new UsageError('task id required');
      const t = await getTask(positional);
      if (!t) return { exit: EXIT.error, json: { ok: false, error: 'not_found' }, text: `${positional} not found` };
      return { exit: EXIT.ok, json: { ok: true, task: taskJson(t, await claimsFor(t.collection)) }, text: `${t.id} [${t.metadata.status}] ${t.title}` };
    }
    case 'next': {
      const collection = flag(args, '--collection');
      if (!collection) throw new UsageError('--collection is required');
      const r = await nextTasks({
        collection, tags: list(flag(args, '--tag')), excludeTags: list(flag(args, '--exclude-tag')), claim: args.includes('--claim'),
        autoOnly: args.includes('--auto-only'), includeCleanup: args.includes('--include-cleanup'), ...claimOpts,
      });
      if (r.claimed) recordLastWrite(collection);
      const json = { ok: true, claims_known: r.claimsKnown, ready: r.ready, skipped: r.skipped, cleanup: r.cleanup, claimed: claimJson(r.claimed) };
      if (!args.includes('--claim')) {
        return { exit: EXIT.ok, json, text: r.ready.length ? `next: ${r.ready[0].id} ${r.ready[0].title} (${r.ready.length} ready)` : 'nothing ready' };
      }
      if (!r.claimed) return { exit: EXIT.ok, json: { ...json, ok: true }, text: 'nothing ready' };
      return { exit: claimExit(r.claimed), json, text: describeClaim(r.claimed) || `started ${r.claimed.id}` };
    }
    case 'claim': {
      if (!positional) throw new UsageError('task id required');
      if (positional.startsWith('cleanup:')) {
        const collection = flag(args, '--collection');
        if (!collection) throw new UsageError('--collection is required for a cleanup key');
        const c = await claimKey(collection, positional, claimOpts);
        return { exit: claimExit(c), json: { ok: c.kind !== 'refused', id: positional, session: claimSession(session), claim: claimJson(c) }, text: describeClaim(c) || `claimed ${positional}` };
      }
      const r = await updateTask(positional, { status: 'in_progress' }, claimOpts);
      recordLastWrite((await getTask(r.id))?.collection);
      return {
        exit: claimExit(r.claim),
        json: { ok: true, id: r.id, session: claimSession(session), claim: claimJson(r.claim) },
        text: (r.claim && describeClaim(r.claim)) || `started ${r.id}`,
      };
    }
    case 'release': {
      if (!positional) throw new UsageError('task id required');
      if (positional.startsWith('cleanup:')) {
        const collection = flag(args, '--collection');
        if (!collection) throw new UsageError('--collection is required for a cleanup key');
        const rel = await releaseTaskClaim(positional, collection, 'done', session);
        return { exit: rel.kind === 'unshared' ? EXIT.unavailable : EXIT.ok, json: { ok: true, id: positional, release: rel }, text: `${positional} released` };
      }
      const status = flag(args, '--status');
      if (!status || !['pending', 'blocked', 'complete'].includes(status)) throw new UsageError('--status must be pending, blocked or complete');
      const t = await getTask(positional);
      if (!t) return { exit: EXIT.error, json: { ok: false, error: 'not_found' }, text: `${positional} not found` };
      const note = flag(args, '--note');
      const addTags = list(flag(args, '--tag')) ?? [];
      const extra: Record<string, any> = {};
      if (note) extra.notes = t.metadata.notes ? `${t.metadata.notes}\n${note}` : note;
      if (addTags.length) {
        const cur = Array.isArray(t.metadata.tags) ? t.metadata.tags : String(t.metadata.tags ?? '').split(',').filter(Boolean);
        extra.tags = [...new Set([...cur, ...addTags])];
      }
      const learned = jsonFile<LearnedItem[]>(flag(args, '--learned-file'), 'array');
      const followUps = jsonFile<FollowUp[]>(flag(args, '--follow-ups-file'), 'array');
      const decisionNeeded = jsonFile<DecisionNeeded>(flag(args, '--decision-needed-file'), 'object');
      const waitsOn = list(flag(args, '--waits-on'));
      if (decisionNeeded && status !== 'pending') throw new UsageError('--decision-needed-file goes with --status pending');
      if (waitsOn?.length) {
        const cur = Array.isArray(t.metadata.waits_on) ? t.metadata.waits_on : String(t.metadata.waits_on ?? '').split(',').filter(Boolean);
        extra.waits_on = [...new Set([...cur, ...waitsOn])];
      }
      validateLearned(learned);
      let release;
      let recorded: { memories: string[]; follow_ups: string[] } | undefined;
      let nudge: string | undefined;
      let decision: string | undefined;
      if (status === 'complete') {
        if (Object.keys(extra).length) await updateTask(t.id, extra, { session });
        const c = await completeTask(t.id, int(flag(args, '--duration'), '--duration'), { session }, { learned, follow_ups: followUps });
        release = c.release;
        recorded = c.recorded;
        nudge = c.nudge;
      } else {
        const reason = flag(args, '--reason');
        const fields = { ...(reason ? { blockedReason: reason } : {}), ...extra };
        if (decisionNeeded) {
          const d = await requestDecision(t.id, decisionNeeded, { session }, fields);
          release = d.release;
          decision = d.decision;
        } else {
          release = (await updateTask(t.id, { status: status as TaskStatus, ...fields }, { session })).release;
        }
        if (learned?.length || followUps?.length) recorded = await recordForTask({ id: t.id, collection: t.collection }, { learned, follow_ups: followUps });
      }
      recordLastWrite(t.collection);
      // A CLI process has no background sync: push the new status before exiting.
      const pushed = await pushDocsNow(t.collection, [t.id]).catch(() => undefined);
      const exit = release?.kind === 'unshared' || (pushed && pushed.errors > 0) ? EXIT.unavailable : EXIT.ok;
      const text = release?.kind === 'released' ? `${t.id} -> ${status}; claim released`
        : release?.kind === 'held_by_other' ? `${t.id} -> ${status}; note: ${release.lease.holder.user} (session ${release.lease.holder.session}) still holds a claim on it`
          : release?.kind === 'unshared' ? `${t.id} -> ${status}; release not shared (${release.reason}); the claim lapses on its own`
            : `${t.id} -> ${status}`;
      const more = [decision ? `decision ${decision} recorded; the task waits on it` : '', recorded?.memories.length ? `recorded ${recorded.memories.join(', ')}` : '',
        recorded?.follow_ups.length ? `follow-ups ${recorded.follow_ups.join(', ')}` : '', nudge ?? ''].filter(Boolean);
      return {
        exit,
        json: { ok: true, id: t.id, status, release: release ?? null, decision: decision ?? null, recorded: recorded ?? null, nudge: nudge ?? null },
        text: more.length ? `${text}\n${more.join('\n')}` : text,
      };
    }
    default:
      throw new UsageError(`unknown command\n${TASK_USAGE}`);
  }
}

/** Read a JSON file (or stdin for "-") holding an array or an object. */
function jsonFile<T>(path: string | undefined, shape: 'array' | 'object'): T | undefined {
  if (path === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
  } catch (e) {
    throw new UsageError(`${path}: ${e instanceof Error ? e.message : e}`);
  }
  if (shape === 'array' ? !Array.isArray(v) : !v || typeof v !== 'object' || Array.isArray(v)) {
    throw new UsageError(`${path}: expected a JSON ${shape}`);
  }
  return v as T;
}

/** True when `a` is the value of a `--flag value` pair (not a positional). */
function isFlagValue(args: string[], a: string): boolean {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1].startsWith('--') && !['--claim', '--reclaim', '--include-complete', '--text', '--auto-only', '--include-cleanup'].includes(args[i - 1]);
}
