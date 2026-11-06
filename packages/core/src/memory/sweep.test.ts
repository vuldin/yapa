import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds, patchDocument } from '../store/index.js';
import { storeMemory } from './store.js';
import { staleFindings, sweepFindings } from './sweep.js';
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
  const { ids: [id] } = await storeMemory(content, { collection, typed: { kind: 'finding' } });
  if (opts.old !== false || opts.meta) await patchDocument(collection, id, { ...(opts.old !== false ? { created_at: OLD } : {}), ...opts.meta });
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
    const { ids: [newer] } = await storeMemory('The nightly export now runs as the svc-export service account, not the reporting user.', { collection: C });
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
