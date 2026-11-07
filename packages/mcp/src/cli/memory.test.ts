import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setConfig, createConfig, resetConfig, setStore, resetStore, createLocalStore, storeMemory, patchDocument, getDocumentsByIds, setHostLLMCaller,
  editScopeSettings, putExternal,
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

describe('yapa memory put from a folder outside every project root', () => {
  it('refuses a new shared collection (exit 3), and writes to an existing one', async () => {
    const scope = join(dir, 'scope.json');
    writeFileSync(scope, JSON.stringify({ project_roots: [join(dir, 'projects')] }));
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = join(dir, 'home');
    setConfig(createConfig({ YAPA_USERNAME: 'josh', YAPA_SCOPE_FILE: scope }));
    try {
      const r = await runMemory('put', ['--collection', 'project-brandnew', '--ref', 'r1', '--content', 'x']);
      expect(r).toMatchObject({ exit: 3, json: { ok: false, refused: true, code: 'shared_collection_not_allowed' } });
      expect((await runMemory('put', ['--collection', C, '--ref', 'r1', '--content', 'x'])).exit).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
      setConfig(createConfig({ YAPA_USERNAME: 'josh' }));
    }
  });
});

describe('yapa memory untype', () => {
  it('refuses an unmarked collection, lists with --dry-run, then keeps the copies as notes', async () => {
    const L = 'private-legacy-cli';
    const { ids: [copy] } = await storeMemory('a captured copy of record Q-7', { collection: L, typed: { kind: 'question', owner: 'josh' } });
    const pub = await putExternal(L, 'rec:Q-7', { content: 'Q-7: the published record', typed: { kind: 'question', owner: 'josh' } });
    let r = await runMemory('untype', ['--collection', L, '--dry-run']);
    expect(r.exit).toBe(1);
    expect(r.text).toMatch(/not marked/);
    await editScopeSettings({ op: 'add_records_elsewhere', collection: L });
    try {
      r = await runMemory('untype', ['--collection', L, '--dry-run']);
      expect(r.exit).toBe(0);
      expect(r.text).toMatch(/^1 typed memory without an external ref in private-legacy-cli \(1 question\): dry run/);
      expect(r.text).toContain(`- ${copy} [question, open]`);
      r = await runMemory('untype', ['--collection', L]);
      expect(r.text).toMatch(/kept as notes now/);
      expect((await getDocumentsByIds(L, [copy]))[0].metadata.kind).toBeUndefined();
      expect((await getDocumentsByIds(L, [pub.id]))[0].metadata.kind).toBe('question');
      r = await runMemory('update', [copy, '--collection', L, '--kind', 'question']);
      expect(r).toMatchObject({ exit: 3, json: { refused: true, code: 'records_elsewhere' } });
      expect((await runMemory('untype', [])).exit).toBe(2);
    } finally {
      await editScopeSettings({ op: 'remove_records_elsewhere', collection: L });
    }
  });
});
