import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByFilter, getDocumentsByIds, patchDocument } from '../store/index.js';
import { storeMemory } from './store.js';
import { sweepSessionSummaries } from './summary-retention.js';
import { runDecaySweep } from './decay.js';
import { listMemories } from './list.js';

const dirs: string[] = [];
const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 100 * 86400;
const C = 'project-acme';

function fresh(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yapa-summary-retention-'));
  dirs.push(dir);
  setConfig(createConfig({ YAPA_USERNAME: 'josh', ...env }));
  setStore(createLocalStore(dir));
}

async function summary(text: string, opts: { createdAt?: number; meta?: Record<string, any> } = {}): Promise<string> {
  const { ids } = await storeMemory(`# Conversation compaction summary\n\n${text}`, {
    collection: C, tags: ['compaction', 'journal'], sector: 'episodic', metadata: { source: 'compaction' },
  });
  const base = ids.length > 1 ? ids[0].replace(/-0$/, '') : ids[0];
  const patch = { created_at: opts.createdAt ?? OLD, ...opts.meta };
  for (const id of ids) await patchDocument(C, id, patch);
  return base;
}

const archived = async (id: string) => {
  const docs = await getDocumentsByFilter(C, { parent_id: id }, 100);
  const all = docs.length ? docs : await getDocumentsByIds(C, [id]);
  return all.map(d => d.metadata.archived === true);
};

beforeEach(() => fresh());
afterAll(() => {
  resetStore();
  resetConfig();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('session summary retention', () => {
  it('archives your own summaries past the retention, and keeps recent, teammates\' and read-only ones', async () => {
    const old = await summary('Old session about the importer.');
    const recent = await summary('Recent session about the importer.', { createdAt: NOW - 10 * 86400 });
    const teammate = await summary('A teammate\'s old session.', { meta: { origin_user: 'alex' } });
    const remote = await summary('An old summary the remote owns.', { meta: { read_only: true } });
    const { ids: [note] } = await storeMemory('An ordinary old note about the importer.', { collection: C });
    await patchDocument(C, note, { created_at: OLD });

    expect(await sweepSessionSummaries(NOW)).toBe(1);
    expect(await archived(old)).toEqual([true]);
    expect((await getDocumentsByIds(C, [old]))[0].metadata.expired).toBe('session_summary_retention');
    for (const id of [recent, teammate, remote, note]) expect(await archived(id)).toEqual([false]);

    expect((await listMemories({ collection: C, limit: 50 })).map(m => m.id)).not.toContain(old);
    expect((await listMemories({ collection: C, limit: 50, include_archived: true })).map(m => m.id)).toContain(old);
  });

  it('treats a summary stored under the configured name as yours after the server\'s username replaces it', async () => {
    const { applyServerUsername, setSyncBackend } = await import('../sync/backend.js');
    const mine = await summary('Old session stored under the configured name.');
    applyServerUsername('jdoe');
    try {
      expect(await sweepSessionSummaries(NOW)).toBe(1);
      expect(await archived(mine)).toEqual([true]);
    } finally {
      setSyncBackend(undefined);
    }
  });

  it('archives a chunked summary whole, and a second sweep changes nothing', async () => {
    const long = await summary(Array.from({ length: 120 }, (_, i) => `Step ${i}: the importer retried batch ${i}.`).join(' '));
    expect((await getDocumentsByFilter(C, { parent_id: long }, 100)).length).toBeGreaterThan(1);
    const n = await sweepSessionSummaries(NOW);
    expect(n).toBeGreaterThan(1);
    expect((await archived(long)).every(Boolean)).toBe(true);
    expect(await sweepSessionSummaries(NOW)).toBe(0);
  });

  it('keeps everything when the retention is 0, and runs from the daily decay sweep', async () => {
    fresh({ YAPA_SESSION_SUMMARY_RETENTION_DAYS: '0' });
    const kept = await summary('Old session, retention off.');
    expect(await sweepSessionSummaries(NOW)).toBe(0);
    expect(await archived(kept)).toEqual([false]);

    fresh({ YAPA_SESSION_SUMMARY_RETENTION_DAYS: '30' });
    const swept = await summary('Old session, swept by decay.', { createdAt: NOW - 40 * 86400 });
    await runDecaySweep(NOW);
    expect(await archived(swept)).toEqual([true]);
  });
});
