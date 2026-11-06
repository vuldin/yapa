import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('lists what it would close, saves it, and applies exactly the saved list', async () => {
    const file = join(dir, 'sweep.json');
    let r = await runMemory('sweep-findings', ['--collection', C, '--save', file]);
    expect(r.exit).toBe(0);
    expect(r.text).toContain(`2 of your open finding(s) in project-acme: 1 progress note(s), 0 superseded, 1 kept (dry run, saved to ${file}; apply it with --apply --from ${file})`);
    expect(r.text).toContain(`- ${progress} [progress] a release event | Release 2.3.0 was tagged`);
    expect((await getDocumentsByIds(C, [progress]))[0].metadata.status).toBe('open');

    setHostLLMCaller(async () => { throw new Error('the apply step must not ask the model again'); });
    r = await runMemory('sweep-findings', ['--collection', C, '--apply', '--from', file, '--ids', 'mem-other']);
    expect(r.text).toContain('0 of 0 reviewed finding(s) in project-acme resolved as no-action');
    expect((await getDocumentsByIds(C, [progress]))[0].metadata.status).toBe('open');

    r = await runMemory('sweep-findings', ['--collection', C, '--apply', '--from', file]);
    expect(r.text).toContain('1 of 1 reviewed finding(s) in project-acme resolved as no-action');
    expect((await getDocumentsByIds(C, [progress]))[0].metadata).toMatchObject({ status: 'resolved', disposition: 'no-action', disposition_reason: 'progress note, not a finding: a release event' });
    expect((await getDocumentsByIds(C, [keep]))[0].metadata.status).toBe('open');
  });

  it('refuses bad arguments and a file from another collection', async () => {
    const file = join(dir, 'other.json');
    writeFileSync(file, JSON.stringify({ collection: 'project-other', items: [] }));
    for (const args of [
      [], ['--collection', C, '--limit', 'x'], ['--collection', C, '--min-age-days', '-1'],
      ['--collection', C, '--from', file], ['--collection', C, '--ids', 'a'], ['--collection', C, '--apply', '--from', file],
      ['--collection', C, '--apply', '--from', join(dir, 'missing.json')],
    ]) expect((await runMemory('sweep-findings', args)).exit).toBe(2);
  });
});
