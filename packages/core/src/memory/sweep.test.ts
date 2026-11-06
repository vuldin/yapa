import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByFilter, getDocumentsByIds, patchDocument } from '../store/index.js';
import { storeMemory } from './store.js';
import { applySweep, staleFindings, sweepFindings } from './sweep.js';
import { createTask } from '../tasks/create.js';
import { nextTasks } from '../tasks/next.js';

let dir: string;
const OLD = Math.floor(Date.now() / 1000) - 5 * 86400;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-sweep-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_COMPACTION_THRESHOLD: '100000', YAPA_FINDINGS_CLEANUP_THRESHOLD: '3' }));
  setStore(createLocalStore(dir));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

async function finding(collection: string, content: string, opts: { old?: boolean; meta?: Record<string, any> } = {}): Promise<string> {
  const { ids: [first] } = await storeMemory(content, { collection, typed: { kind: 'finding' } });
  const id = content.length > 2000 ? first.replace(/-0$/, '') : first;
  const patch = { ...(opts.old !== false ? { created_at: OLD } : {}), ...opts.meta };
  if (!Object.keys(patch).length) return id;
  const chunks = await getDocumentsByFilter(collection, { parent_id: id }, 1000);
  for (const docId of chunks.length ? chunks.map(c => c.id) : [id]) await patchDocument(collection, docId, patch);
  return id;
}

const judge = (verdicts: (prompt: string) => Array<{ id: string; verdict: string; reason?: string }>) => {
  const calls: string[] = [];
  return {
    calls,
    call: async (o: { messages: Array<{ content: string }> }) => {
      const p = o.messages[1].content;
      calls.push(p);
      return JSON.stringify(verdicts(p));
    },
  };
};

const idsIn = (prompt: string) => [...prompt.matchAll(/^- id: (\S+)$/gm)].map(m => m[1]);

describe('sweepFindings', () => {
  it('lists progress notes in a dry run and resolves them only with apply', async () => {
    const C = 'project-sweep';
    const progress = await finding(C, 'Review round 4 of the export branch found nothing; pushed abc1234.');
    const keep = await finding(C, 'The export job fails because the reporting user\'s password expires every 90 days.');
    const recent = await finding(C, 'Tests passed on the release branch.', { old: false });
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: id === progress ? 'progress' : 'keep', reason: id === progress ? 'a review round' : 'root cause' })));

    const dry = await sweepFindings({ collection: C }, { call: j.call as any });
    expect(dry.considered).toBe(2);
    expect(dry.items.map(i => [i.id, i.verdict, i.applied])).toEqual([[progress, 'progress', undefined], [keep, 'keep', undefined]]);
    expect((await getDocumentsByIds(C, [progress]))[0].metadata.status).toBe('open');
    expect(idsIn(j.calls[0])).not.toContain(recent);

    const done = await sweepFindings({ collection: C, apply: true }, { call: j.call as any });
    expect(done.items.find(i => i.id === progress)?.applied).toBe(true);
    const [p] = await getDocumentsByIds(C, [progress]);
    expect(p.metadata).toMatchObject({ status: 'resolved', disposition: 'no-action', disposition_reason: 'progress note, not a finding: a review round' });
    expect(p.content).toMatch(/Swept: progress note/);
    expect((await getDocumentsByIds(C, [keep]))[0].metadata.status).toBe('open');
  });

  it('asks in batches of ten, skips read-only findings, and keeps anything the model does not judge', async () => {
    const C = 'project-sweep-batch';
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await finding(C, `Finding number ${i} about shard ${i} rebalancing under load with ${i * 7} partitions.`));
    const remote = await finding(C, 'A record the remote owns.', { meta: { read_only: true } });
    const j = judge(p => idsIn(p).slice(0, 1).map(id => ({ id, verdict: 'progress' })).concat([{ id: 'mem-not-shown', verdict: 'progress' }]));
    const r = await sweepFindings({ collection: C }, { call: j.call as any });
    expect(j.calls.map(c => idsIn(c).length)).toEqual([10, 2]);
    expect(r.items.map(i => i.id)).not.toContain(remote);
    expect(r.items.filter(i => i.verdict === 'progress').map(i => i.id)).toEqual([ids[0], ids[10]]);
    expect(r.items.filter(i => i.verdict === 'keep')).toHaveLength(10);
  });

  it('calls a finding superseded only when it was shown a newer note, and survives a bad answer', async () => {
    const C = 'project-sweep-sup';
    const old = await finding(C, 'The nightly export runs as the reporting user.');
    await storeMemory('The nightly export now runs as the svc-export service account (journal).', { collection: C, tags: ['journal'], typed: { kind: 'finding' } });
    const { ids: [newer] } = await storeMemory('The nightly export now runs as the svc-export service account, not the reporting user.', { collection: C, typed: { kind: 'finding' } });
    const lonely = await finding(C, 'Bucket lifecycle rules delete multipart uploads after a week.');
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: 'superseded' })));
    const r = await sweepFindings({ collection: C }, { call: j.call as any });
    expect(j.calls[0]).toContain(`newer note (${newer})`);
    expect(r.items.map(i => [i.id, i.verdict, i.superseded_by])).toEqual([[old, 'superseded', newer], [lonely, 'keep', undefined]]);

    const bad = await sweepFindings({ collection: C }, { call: (async () => 'not json') as any });
    expect(bad.items.every(i => i.verdict === 'keep')).toBe(true);
    const down = await sweepFindings({ collection: C, apply: true }, { call: (async () => { throw new Error('model down'); }) as any });
    expect(down.items.every(i => i.verdict === 'keep' && i.error?.includes('model down'))).toBe(true);
    expect((await getDocumentsByIds(C, [old]))[0].metadata.status).toBe('open');
  });
});

describe('sweep safety', () => {
  it('keeps a finding open when the newer note it was superseded by is closed in the same sweep', async () => {
    const C = 'project-sweep-chain';
    const a = await finding(C, 'Root cause of the consumer lag: the fetch quota was set to 1 MB for the whole group.', { meta: { created_at: OLD - 100 } });
    const b = await finding(C, 'Review round 2: confirmed the consumer lag root cause is the 1 MB fetch quota for the group; pushed the fix.');
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: id === a ? 'superseded' : 'progress' })));
    const r = await sweepFindings({ collection: C, apply: true }, { call: j.call as any });
    expect(r.items.map(i => [i.id, i.verdict])).toEqual([[a, 'keep'], [b, 'progress']]);
    expect((await getDocumentsByIds(C, [a]))[0].metadata.status).toBe('open');
  });

  it('never closes a note an earlier sweep closed a finding in favor of', async () => {
    const C = 'project-sweep-later';
    const a = await finding(C, 'Root cause of the consumer lag: the fetch quota was set to 1 MB for the whole group.');
    const b = await finding(C, 'Review round 2: confirmed the consumer lag root cause is the 1 MB fetch quota for the group; pushed the fix.', { old: false });
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: id === a ? 'superseded' : 'progress' })));
    const first = await sweepFindings({ collection: C, apply: true }, { call: j.call as any });
    expect(first.items.map(i => [i.id, i.verdict, i.applied])).toEqual([[a, 'superseded', true]]);
    expect((await getDocumentsByIds(C, [a]))[0].metadata.disposition_ids).toEqual([b]);

    await patchDocument(C, b, { created_at: OLD });
    const second = await sweepFindings({ collection: C, apply: true }, { call: j.call as any });
    expect(second.items.map(i => [i.id, i.verdict, i.reason])).toEqual([[b, 'keep', 'a finding closed earlier was superseded by it']]);
    expect((await getDocumentsByIds(C, [b]))[0].metadata.status).toBe('open');
    const forced = await applySweep(C, [{ id: b, verdict: 'progress', reason: '', content: '' }]);
    expect(forced[0].skipped).toBe('a finding closed earlier was superseded by it');

    const { updateMemory } = await import('./update.js');
    const legacy = await finding(C, 'Old finding closed by an earlier client.');
    const target = await finding(C, 'Tagged release 4.0 and published the notes.');
    await updateMemory(legacy, { status: 'resolved', disposition: 'no-action', disposition_reason: `superseded by ${target}: same thing` }, C);
    expect((await applySweep(C, [{ id: target, verdict: 'progress', reason: '', content: '' }]))[0].skipped).toBe('a finding closed earlier was superseded by it');
  });

  it('sweeps only your own findings unless asked for everyone\'s', async () => {
    const C = 'project-sweep-team';
    const mineId = await finding(C, 'Pushed the TLS fix and reran the suite.');
    const theirs = await finding(C, 'The TLS handshake fails because the broker certificate lacks the SAN for the internal name.', { meta: { origin_user: 'dana' } });
    expect((await staleFindings(C)).map(f => f.id)).toEqual([mineId]);
    expect((await staleFindings(C, { allOwners: true })).map(f => f.id).sort()).toEqual([mineId, theirs].sort());
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: 'progress' })));
    const r = await sweepFindings({ collection: C, apply: true }, { call: j.call as any });
    expect(r.items.map(i => i.id)).toEqual([mineId]);
    expect((await getDocumentsByIds(C, [theirs]))[0].metadata.status).toBe('open');
    const forced = await applySweep(C, [{ id: theirs, verdict: 'progress', reason: '', content: '' }]);
    expect(forced[0]).toMatchObject({ skipped: 'recorded by dana' });
    expect((await getDocumentsByIds(C, [theirs]))[0].metadata.status).toBe('open');
  });

  it('judges the whole text, joins chunks, and keeps a truncated finding', async () => {
    const C = 'project-sweep-long';
    const tail = 'ROOT CAUSE: a retract keeps a full copy on the server for 30 days.';
    const weekly = `Weekly status. ${Array.from({ length: 70 }, (_, i) => `Build ${i} pushed and suite ${i} rerun.`).join(' ')} ${tail}`;
    const chunked = await finding(C, weekly);
    const long = await finding(C, `PR review, round 2 notes. ${'We re-ran the suites and they pass. '.repeat(20)}${tail}`);
    const huge = await finding(C, `Release notes for the week. ${'Tagged and published another build. '.repeat(150)}`);
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: 'progress' })));
    const r = await sweepFindings({ collection: C }, { call: j.call as any });
    expect(j.calls.join('\n')).toContain(tail);
    expect((await getDocumentsByFilter(C, { parent_id: huge }, 100)).length).toBeGreaterThan(1);
    expect(r.items.find(i => i.id === huge)).toMatchObject({ verdict: 'keep', truncated: true });
    expect(j.calls.join('\n')).toContain(`${huge}\n  recorded:`);
    expect(r.items.find(i => i.id === long)?.verdict).toBe('progress');
    const shown = j.calls.join('\n').split(`- id: ${chunked}\n`)[1].split('\n- id:')[0];
    expect(shown).toContain(tail);
    expect(shown).toBe(`  recorded: ${new Date(OLD * 1000).toISOString().slice(0, 10)}\n  text: ${weekly}`);
    expect(shown).not.toMatch(/\(truncated\)/);
  });

  it('applies a saved list exactly, and leaves what changed since open', async () => {
    const C = 'project-sweep-saved';
    const p1 = await finding(C, 'Merged PR 12 after the second review round.');
    const p2 = await finding(C, 'Tagged release 3.1.0 and published the notes.');
    const j = judge(p => idsIn(p).map(id => ({ id, verdict: 'progress', reason: 'an event' })));
    const dry = await sweepFindings({ collection: C }, { call: j.call as any });
    const { updateMemory } = await import('./update.js');
    await updateMemory(p2, { status: 'resolved', disposition: 'no-action', disposition_reason: 'done by hand' }, C);
    const done = await applySweep(C, dry.items.map(i => ({ ...i })));
    expect(done.map(i => [i.id, i.applied, i.skipped])).toEqual([[p1, true, undefined], [p2, undefined, 'no longer an open finding']]);
    expect((await getDocumentsByIds(C, [p1]))[0].metadata.disposition_reason).toBe('progress note, not a finding: an event');
  });
});

describe('the findings backlog in task_next', () => {
  it('offers cleanup:findings beside ready tasks once the backlog reaches the threshold', async () => {
    const C = 'project-backlog';
    const ready = await createTask('ship the importer', {}, C);
    await finding(C, 'One old finding about the importer.');
    await finding(C, 'Two old findings about the importer.');
    let next = await nextTasks({ collection: C });
    expect(next.ready.map(t => t.id)).toEqual([ready]);
    expect(next.cleanup).toEqual([]);

    await finding(C, 'Three old findings about the importer.');
    await finding(C, 'A new finding does not count yet.', { old: false });
    expect((await staleFindings(C)).length).toBe(3);
    next = await nextTasks({ collection: C });
    expect(next.ready.map(t => t.id)).toEqual([ready]);
    expect(next.cleanup.map(c => [c.key, c.count])).toEqual([['cleanup:findings', 3]]);
    expect(next.cleanup[0].title).toContain(`yapa memory sweep-findings --collection ${C}`);

    next = await nextTasks({ collection: C, claim: true });
    expect(next.claimed).toMatchObject({ id: ready });
  });
});
