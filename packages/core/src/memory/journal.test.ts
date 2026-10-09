import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByFilter } from '../store/index.js';
import { consolidateStaleDrafts } from './journal.js';

let dir: string;
const OLD = Math.floor(Date.now() / 1000) - 3 * 86400;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-journal-'));
  setConfig(createConfig({ YAPA_USERNAME: 'teammate' }));
  setStore(createLocalStore(dir));
  const store = getStore();
  await store.createCollection('global');
  await store.addDocument('global', 'd-mine', 'my old step', { type: 'journal_draft', username: 'teammate', session_id: 's-mine', created_at: OLD });
  await store.addDocument('global', 'd-theirs', 'josh old step', { type: 'journal_draft', username: 'josh', session_id: 's-josh', created_at: OLD });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('consolidateStaleDrafts', () => {
  it('rolls up only this user\'s stale drafts, never someone else\'s', async () => {
    const rolled = await consolidateStaleDrafts();
    expect(rolled).toHaveLength(1);
    const drafts = (await getDocumentsByFilter('global', { type: 'journal_draft' }, 10)).map(d => d.id);
    expect(drafts).toEqual(['d-theirs']);
    const journals = await getDocumentsByFilter('global', { type: 'memory' }, 10);
    expect(journals).toHaveLength(1);
    expect(journals[0].content).toContain('my old step');
    expect(journals[0].content).not.toContain('josh old step');
  });
});
