import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, storeMemory, patchDocument, getDocumentsByIds, setHostLLMCaller,
} from '@yapa/core';
import { runMemory } from './memory.js';

let dir: string;
const C = 'project-acme';
let progress: string;
let keep: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-memory-cli-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'josh' }));
  setStore(createLocalStore(join(dir, 'store')));
  const old = Math.floor(Date.now() / 1000) - 5 * 86400;
  ({ ids: [progress] } = await storeMemory('Release 2.3.0 was tagged and the release notes published.', { collection: C, typed: { kind: 'finding' } }));
  ({ ids: [keep] } = await storeMemory('Uploads over 5 GB fail because the client never switches to multipart.', { collection: C, typed: { kind: 'finding' } }));
  for (const id of [progress, keep]) await patchDocument(C, id, { created_at: old });
  setHostLLMCaller(async o => {
    const ids = [...o.messages[1].content.matchAll(/^- id: (\S+)$/gm)].map(m => m[1]);
    return JSON.stringify(ids.map(id => ({ id, verdict: id === progress ? 'progress' : 'keep', reason: id === progress ? 'a release event' : 'root cause' })));
  });
});

afterAll(() => {
  setHostLLMCaller(undefined);
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('yapa memory sweep-findings', () => {
  it('lists what it would close, then closes it with --apply', async () => {
    let r = await runMemory('sweep-findings', ['--collection', C]);
    expect(r.exit).toBe(0);
    expect(r.text).toContain('2 open finding(s) in project-acme: 1 progress note(s), 0 superseded, 1 kept (dry run: --apply resolves them)');
    expect(r.text).toContain(`- ${progress} [progress] a release event | Release 2.3.0 was tagged`);
    expect((await getDocumentsByIds(C, [progress]))[0].metadata.status).toBe('open');

    r = await runMemory('sweep-findings', ['--collection', C, '--apply']);
    expect(r.text).toContain('1 resolved as no-action');
    expect((await getDocumentsByIds(C, [progress]))[0].metadata).toMatchObject({ status: 'resolved', disposition: 'no-action' });
    expect((await getDocumentsByIds(C, [keep]))[0].metadata.status).toBe('open');
    expect((r.json as any).items.map((i: any) => i.id)).toEqual([progress, keep]);
  });

  it('needs a collection and whole numbers', async () => {
    expect((await runMemory('sweep-findings', [])).exit).toBe(2);
    expect((await runMemory('sweep-findings', ['--collection', C, '--limit', 'x'])).exit).toBe(2);
    expect((await runMemory('sweep-findings', ['--collection', C, '--min-age-days', '-1'])).exit).toBe(2);
  });
});
