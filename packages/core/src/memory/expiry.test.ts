import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { sweepExpiredMemories } from './expiry.js';
import { runDecaySweep } from './decay.js';

const DAY = 86400;
const NOW = 1_800_000_000;
const OLD = NOW - 200 * DAY;
const C = 'project-acme';
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-expiry-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester' }));
  setStore(createLocalStore(dir));
  await getStore().createCollection(C);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

const add = (id: string, md: Record<string, any> = {}) =>
  getStore().addDocument(C, id, `note ${id}`, { type: 'memory', username: 'tester', salience: 0.1, created_at: OLD, accessed_at: OLD, ...md });
const archived = async (id: string) => (await getDocumentsByIds(C, [id]))[0].metadata.archived === true;

describe('sweepExpiredMemories', () => {
  it('archives an old, faded note of yours, marked as expired by age', async () => {
    await add('old');
    const r = await sweepExpiredMemories(NOW);
    expect(r.candidates.map(c => c.id)).toEqual(['old']);
    const [d] = await getDocumentsByIds(C, ['old']);
    expect(d.metadata).toMatchObject({ archived: true, expired: 'age', is_synced: false });
  });

  it('keeps notes recently recalled, changed or still important', async () => {
    await add('recalled', { accessed_at: NOW - 10 * DAY });
    await add('changed', { updated_at: NOW - 10 * DAY });
    await add('important', { salience: 0.2 });
    await sweepExpiredMemories(NOW);
    for (const id of ['recalled', 'changed', 'important']) expect(await archived(id)).toBe(false);
  });

  it('keeps typed, pinned, summary, read-only and teammates\' memories', async () => {
    await add('typed', { kind: 'finding', status: 'resolved' });
    await add('pinned', { pinned: true });
    await add('summary', { source: 'compaction' });
    await add('remote', { read_only: true });
    await add('theirs', { username: 'dana', origin_user: 'dana' });
    const r = await sweepExpiredMemories(NOW);
    expect(r.candidates).toEqual([]);
  });

  it('keeps notes an open task links to, not ones a completed task does', async () => {
    await add('linked');
    await add('done-link');
    await getStore().addDocument(C, 't1', 'task', { type: 'task', status: 'pending', memory_ids: ['linked'] });
    await getStore().addDocument(C, 't2', 'task', { type: 'task', status: 'complete', memory_ids: ['done-link'] });
    await sweepExpiredMemories(NOW);
    expect(await archived('linked')).toBe(false);
    expect(await archived('done-link')).toBe(true);
  });

  it('decides a chunked memory as a whole', async () => {
    await add('m-0', { parent_id: 'm', chunk_index: 0 });
    await add('m-1', { parent_id: 'm', chunk_index: 1, accessed_at: NOW - DAY });
    await add('n-0', { parent_id: 'n', chunk_index: 0 });
    await add('n-1', { parent_id: 'n', chunk_index: 1 });
    const r = await sweepExpiredMemories(NOW);
    expect(r.candidates.map(c => c.id)).toEqual(['n']);
    expect(await archived('m-0')).toBe(false);
    expect(await archived('n-0')).toBe(true);
    expect(await archived('n-1')).toBe(true);
  });

  it('lists without archiving on a dry run, and does nothing at 0 days', async () => {
    await add('old');
    expect((await sweepExpiredMemories(NOW, { dryRun: true })).candidates).toHaveLength(1);
    expect(await archived('old')).toBe(false);
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_MEMORY_EXPIRY_DAYS: '0' }));
    expect((await sweepExpiredMemories(NOW)).candidates).toEqual([]);
    expect(await archived('old')).toBe(false);
  });

  it('runs as part of the daily decay sweep', async () => {
    await add('old', { decayed_at: NOW });
    await runDecaySweep(NOW);
    expect(await archived('old')).toBe(true);
  });
});
