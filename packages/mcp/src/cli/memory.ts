/**
 * `yapa memory` and `yapa waiting`: typed memories and what waits on people,
 * for scripts and project tooling. One JSON object on stdout (--text: a short
 * summary). Exit: 0 done, 2 bad arguments (including an invalid typed
 * memory), 1 any other error.
 *
 * `put --ref R` is for tooling that keeps its canonical records elsewhere:
 * the memory for R is created once and updated in place afterwards, so the
 * export can run as often as it likes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  getConfig, getDocumentsByFilter, listMemories, MemoryNotFoundError, putExternal, TypedMemoryError, setConfig, sweepFindings, applySweep, type SweepItem, type SweepResult,
  recordLastWrite, updateMemory, waitingOn, formatWaiting, resolveWriteCollection, sessionFolder, SharedCollectionNotAllowedError, redirectNote, type TypedFields,
  RecordsElsewhereError, untypeCollection,
} from '@yapa/core';

export const MEMORY_USAGE =
  'Usage: yapa memory list   [--collection C] [--kind K] [--status S] [--owner U] [--tag a,b] [--include-archived] [--limit N]\n' +
  '       yapa memory put    --collection C --ref R [typed fields] (--content TEXT | --stdin-json)\n' +
  '       yapa memory update ID [--collection C] [typed fields] [--note TEXT] [--stdin-json]\n' +
  '       yapa memory sweep-findings --collection C [--save FILE] [--apply [--from FILE [--ids a,b]]] [--limit N] [--min-age-days N] [--all-owners]\n' +
  '       yapa memory untype --collection C [--dry-run]\n' +
  '       yapa waiting       [--collection C] [--for U | --everyone]\n' +
  'Typed fields: --kind finding|decision|limitation|question|idea --status S --owner U --task-ids a,b\n' +
  '  --option TEXT (repeat) --recommendation TEXT --disposition D --disposition-ids a,b --disposition-reason TEXT\n' +
  '  --exit-criteria TEXT --tags a,b. --stdin-json reads the same fields (and content, note) as one JSON object.\n' +
  'sweep-findings asks the curation model which of your open findings older than --min-age-days (default 2) are\n' +
  '  only progress notes or superseded by a newer note, and lists them (--save FILE keeps the list). --apply --from FILE\n' +
  '  resolves exactly the saved list as no-action (--ids: some of it); --apply alone judges and resolves in one step.\n' +
  'untype turns your typed memories without an external ref (--ref) into notes, in a collection marked as keeping its\n' +
  '  records elsewhere (yapa scope records-elsewhere add C): copies made before it was marked. --dry-run lists them.\n' +
  'Prints one JSON object (--text: a short summary). Exit: 0 done, 2 bad arguments, 1 other error.\n';

export interface MemoryCliResult {
  exit: number;
  json: Record<string, unknown>;
  text: string;
}

class UsageError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && i + 1 < args.length) out.push(args[i + 1]); });
  return out;
}

const csv = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map(x => x.trim()).filter(Boolean));

const VALUE_FLAGS = new Set([
  '--collection', '--kind', '--status', '--owner', '--tag', '--limit', '--ref', '--content', '--note', '--task-ids', '--option',
  '--recommendation', '--disposition', '--disposition-ids', '--disposition-reason', '--exit-criteria', '--tags', '--for', '--min-age-days', '--from', '--save', '--ids',
]);

function positional(args: string[]): string | undefined {
  return args.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface Input extends TypedFields { content?: string; note?: string; tags?: string[] }

async function input(args: string[]): Promise<Input> {
  if (args.includes('--stdin-json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readStdin());
    } catch (e) {
      throw new UsageError(`--stdin-json: ${e instanceof Error ? e.message : e}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('--stdin-json expects one JSON object');
    return parsed as Input;
  }
  const out: Input = {};
  const set = (k: keyof Input, v: unknown) => { if (v !== undefined && !(Array.isArray(v) && !v.length)) (out as any)[k] = v; };
  set('kind', flag(args, '--kind'));
  set('status', flag(args, '--status'));
  set('owner', flag(args, '--owner'));
  set('task_ids', csv(flag(args, '--task-ids')));
  set('options', flags(args, '--option'));
  set('recommendation', flag(args, '--recommendation'));
  set('disposition', flag(args, '--disposition'));
  set('disposition_ids', csv(flag(args, '--disposition-ids')));
  set('disposition_reason', flag(args, '--disposition-reason'));
  set('exit_criteria', flag(args, '--exit-criteria'));
  set('tags', csv(flag(args, '--tags')));
  set('content', flag(args, '--content'));
  set('note', flag(args, '--note'));
  return out;
}

function split(i: Input): { content?: string; note?: string; tags?: string[]; typed: TypedFields } {
  const { content, note, tags, ...typed } = i;
  return { content, note, tags, typed };
}

/** Memories as whole documents: chunks of one memory joined in order. */
async function listWhole(args: string[]) {
  const collection = flag(args, '--collection');
  const limitRaw = flag(args, '--limit');
  const limit = limitRaw === undefined ? 1000 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) throw new UsageError('--limit must be a positive integer');
  const rows = await listMemories({
    collection,
    kind: flag(args, '--kind'),
    status: flag(args, '--status'),
    owner: flag(args, '--owner'),
    tags: csv(flag(args, '--tag')),
    include_archived: args.includes('--include-archived'),
    limit: 100_000,
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.collection}\u0000${r.metadata.parent_id ?? r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = [];
  for (const parts of groups.values()) {
    const first = parts[0];
    let chunks = parts;
    if (first.metadata.parent_id) {
      // A filter can match some chunks only; read the whole memory.
      chunks = (await getDocumentsByFilter(first.collection, { parent_id: first.metadata.parent_id }, 1000).catch(() => parts))
        .map(d => ({ ...d, collection: first.collection }));
      chunks.sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0));
    }
    const { chunk_index: _i, chunk_total: _t, parent_id: _p, ...metadata } = chunks[0].metadata;
    out.push({
      id: first.metadata.parent_id ?? first.id,
      collection: first.collection,
      content: chunks.map(c => c.content).join(''),
      metadata,
    });
  }
  out.sort((a, b) => Number(b.metadata.created_at ?? 0) - Number(a.metadata.created_at ?? 0));
  return out.slice(0, limit);
}

export async function runMemory(sub: string | undefined, args: string[]): Promise<MemoryCliResult> {
  try {
    switch (sub) {
      case 'list': {
        const memories = await listWhole(args);
        return { exit: 0, json: { ok: true, memories }, text: `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}` };
      }
      case 'put': {
        const collection = flag(args, '--collection');
        const ref = flag(args, '--ref');
        if (!collection || !ref) throw new UsageError('--collection and --ref are required');
        const { content, tags, typed } = split(await input(args));
        if (!content?.trim()) throw new UsageError('content is required (--content or "content" in --stdin-json)');
        const target = await resolveWriteCollection(collection, { folder: sessionFolder() });
        const r = await putExternal(target.collection, ref, { content, typed, tags });
        recordLastWrite(target.collection);
        return {
          exit: 0,
          json: { ok: true, ...r, ref, collection: target.collection, ...(target.redirectedFrom ? { redirected_from: target.redirectedFrom } : {}) },
          text: `${r.id} ${r.action}${target.redirectedFrom ? ` (${redirectNote(target)})` : ''}`,
        };
      }
      case 'update': {
        const id = positional(args);
        if (!id) throw new UsageError('memory id required');
        const { content, note, tags, typed } = split(await input(args));
        const r = await updateMemory(id, { ...typed, ...(content !== undefined ? { content } : {}), ...(note !== undefined ? { note } : {}), ...(tags ? { tags } : {}) }, flag(args, '--collection'));
        recordLastWrite(r.collection);
        return { exit: 0, json: { ok: true, id: r.id, collection: r.collection, metadata: r.metadata }, text: `updated ${r.id}` };
      }
      case 'sweep-findings': {
        const collection = flag(args, '--collection');
        if (!collection) throw new UsageError('--collection is required');
        const num = (name: string) => {
          const v = flag(args, name);
          if (v === undefined) return undefined;
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer`);
          return n;
        };
        const apply = args.includes('--apply');
        const allOwners = args.includes('--all-owners');
        const from = flag(args, '--from');
        const save = flag(args, '--save');
        const ids = csv(flag(args, '--ids'));
        if (from && !apply) throw new UsageError('--from applies a saved dry run: add --apply');
        if (ids && !from) throw new UsageError('--ids picks items of a saved dry run: add --from FILE');
        let r: SweepResult;
        if (from) {
          let saved: { collection?: string; items?: SweepItem[] };
          try {
            saved = JSON.parse(readFileSync(from, 'utf8'));
          } catch (e) {
            throw new UsageError(`cannot read ${from}: ${e instanceof Error ? e.message : e}`);
          }
          if (saved.collection !== collection || !Array.isArray(saved.items)) throw new UsageError(`${from} is not a dry run of ${collection}`);
          const items = saved.items.filter(i => i.verdict !== 'keep' && (!ids || ids.includes(i.id)))
            .map(i => ({ ...i, applied: undefined, skipped: undefined, error: undefined }));
          await applySweep(collection, items, { allOwners });
          r = { collection, considered: items.length, items, applied: true };
        } else {
          const config = getConfig();
          if (config.CURATION_LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
            setConfig({ ...config, CURATION_LLM_PROVIDER: 'claude-cli', CURATION_MODEL: config.CURATION_MODEL || 'haiku' });
          }
          r = await sweepFindings({ collection, apply, allOwners, limit: num('--limit'), minAgeDays: num('--min-age-days') });
          if (save) writeFileSync(save, JSON.stringify(r, null, 2));
        }
        if (r.applied) recordLastWrite(collection);
        const count = (v: string) => r.items.filter(i => i.verdict === v).length;
        const closed = r.items.filter(i => i.applied).length;
        const head = from
          ? `${closed} of ${r.items.length} reviewed finding(s) in ${collection} resolved as no-action`
          : `${r.considered} of your open finding(s) in ${collection}${allOwners ? ' (everyone\'s)' : ''}: ${count('progress')} progress note(s), ${count('superseded')} superseded, ${count('keep')} kept`
            + (apply ? `; ${closed} resolved as no-action` : ` (dry run${save ? `, saved to ${save}; apply it with --apply --from ${save}` : ': --save FILE, then --apply --from FILE'})`);
        const lines = [head, ...r.items.filter(i => i.verdict !== 'keep').map(i =>
          `- ${i.id} [${i.verdict}${i.superseded_by ? ` by ${i.superseded_by}` : ''}${i.skipped ? `, left open: ${i.skipped}` : ''}${i.error ? `, failed: ${i.error}` : ''}] ${i.reason} | ${i.content.replace(/\s+/g, ' ').slice(0, 120)}`)];
        const failed = r.items.filter(i => i.error).length;
        return { exit: failed && failed === r.items.length ? 1 : 0, json: { ok: true, ...r }, text: lines.join('\n') };
      }
      case 'untype': {
        const collection = flag(args, '--collection');
        if (!collection) throw new UsageError('--collection is required');
        const dryRun = args.includes('--dry-run');
        const r = await untypeCollection(collection, { dryRun });
        if (!dryRun && r.items.length) recordLastWrite(collection);
        const kinds = Object.entries(r.by_kind).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
        const head = `${r.items.length} typed memor${r.items.length === 1 ? 'y' : 'ies'} without an external ref in ${collection}${kinds ? ` (${kinds})` : ''}`
          + (dryRun ? ': dry run, nothing changed; run again without --dry-run to keep them as notes' : r.items.length ? ': kept as notes now' : '')
          + (r.others ? `. ${r.others} of someone else's left as they are` : '');
        const lines = [head, ...(dryRun ? r.items.map(i => `- ${i.id} [${i.kind}${i.status ? `, ${i.status}` : ''}] ${i.content.replace(/\s+/g, ' ').slice(0, 120)}`) : [])];
        return { exit: 0, json: { ok: true, ...r }, text: lines.join('\n') };
      }
      default:
        throw new UsageError(`unknown command\n${MEMORY_USAGE}`);
    }
  } catch (e) {
    return fail(`yapa memory ${sub ?? ''}`, e);
  }
}

export async function runWaiting(args: string[]): Promise<MemoryCliResult> {
  try {
    const collection = flag(args, '--collection');
    const user = args.includes('--everyone') ? undefined : flag(args, '--for') ?? getConfig().USERNAME;
    const w = await waitingOn({ collection, user });
    return { exit: 0, json: { ok: true, user: user ?? null, ...w }, text: formatWaiting(w, { collection: !collection }) };
  } catch (e) {
    return fail('yapa waiting', e);
  }
}

function fail(what: string, e: unknown): MemoryCliResult {
  const usage = e instanceof UsageError || e instanceof TypedMemoryError;
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof MemoryNotFoundError ? 'not_found' : e instanceof SharedCollectionNotAllowedError ? e.code : undefined;
  if (e instanceof RecordsElsewhereError) return { exit: 3, json: { ok: false, refused: true, error: message, code: e.code }, text: `${what}: ${message}` };
  if (e instanceof SharedCollectionNotAllowedError) return { exit: 3, json: { ok: false, refused: true, error: message, code }, text: `${what}: ${message}` };
  return { exit: usage ? 2 : 1, json: { ok: false, error: message, ...(code ? { code } : {}) }, text: `${what}: ${message}` };
}
