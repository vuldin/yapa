import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, resetConfig, setConfig } from '@yapa/core';
import { counterNext, EXIT, leaseAcquire, leaseList, leaseRelease } from './coord.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-coord-cli-'));
  // Sync on, but the service is never reached for a private collection.
  setConfig(createConfig({
    YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'http://127.0.0.1:9',
    YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases'),
  }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
});

describe('yapa coord on a private collection', () => {
  it('acquires, refuses an overlap (exit 3), lists, releases and counts on this machine', async () => {
    const a = await leaseAcquire({ collection: 'private-acme', key: 'hyg:docs', session: 's1', scope: ['res:bench'] });
    expect(a).toMatchObject({ exit: EXIT.ok, json: { ok: true, granted: true, local: true } });
    expect(a.text).toMatch(/^granted hyg:docs to session s1 \(this machine\): scope key:hyg:docs, res:bench/);
    const b = await leaseAcquire({ collection: 'private-acme', key: 'freeze:repo', session: 's2', scope: ['res:bench'] });
    expect(b.exit).toBe(EXIT.refused);
    expect(b.text).toMatch(/^CONFLICT freeze:repo: hyg:docs held by tester \(session s1/);
    expect((await leaseList('private-acme')).text).toMatch(/^- hyg:docs held by tester/);
    expect((await leaseRelease('private-acme', 'hyg:docs', 's2')).exit).toBe(EXIT.refused);
    expect((await leaseRelease('private-acme', 'hyg:docs', 's1', 'done')).exit).toBe(EXIT.ok);
    expect(await counterNext('private-acme', 'FIND-2026', 199)).toMatchObject({ exit: EXIT.ok, json: { value: 200, local: true } });
    expect((await counterNext('private-acme', 'FIND-2026')).json.value).toBe(201);
  });

  it('a shared collection still goes to the service (unreachable here: exit 4, nothing shared)', async () => {
    const r = await leaseAcquire({ collection: 'project-acme', key: 'k', session: 's1' });
    expect(r.exit).toBe(EXIT.unavailable);
    expect(r.text).toMatch(/^not shared: /);
  });
});
