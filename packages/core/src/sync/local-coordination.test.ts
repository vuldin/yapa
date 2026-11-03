/**
 * Local coordination answers like the sync service: these mirror
 * packages/service/test/coord.integration.test.ts case for case, so a
 * project script can't tell a private collection from a shared one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalCoordination, EXPIRED_KEEP_SECONDS, LEASE_TTL_DEFAULT, LocalCoordinationError } from './local-coordination.js';

let dir: string;
let now: number;
const C = 'private-acme';
const as = (user: string) => createLocalCoordination({ dir, user, now: () => now });
let me: ReturnType<typeof as>;
let other: ReturnType<typeof as>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-local-coord-'));
  now = 1_800_000_000;
  me = as('tester');
  other = as('dana');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('leases', () => {
  it('grants a free key and reports it in the listing with holder and expiry', async () => {
    const r = await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1', title: 'fix it' });
    expect(r).toMatchObject({ granted: true, renewed: false, lease: { key: 'task-1', holder: { user: 'tester', session: 's1' }, title: 'fix it', scope: ['key:task-1'], ttl_seconds: LEASE_TTL_DEFAULT, expires_at: now + LEASE_TTL_DEFAULT, expired: false } });
    const l = await me.leaseList(C);
    expect(l.leases.map(x => x.key)).toEqual(['task-1']);
    expect(l.now).toBe(now);
  });

  it('refuses the same key to another user and to the same user in another session', async () => {
    await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1' });
    const a = await other.leaseAcquire({ collection: C, key: 'task-1', session: 'x' });
    expect(a).toMatchObject({ granted: false, conflicts: [{ lease: { key: 'task-1' }, overlap: ['key:task-1'] }] });
    expect((await me.leaseAcquire({ collection: C, key: 'task-1', session: 's2' })).granted).toBe(false);
  });

  it('refuses a different key whose scope overlaps a live lease', async () => {
    await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1', scope: ['res:bench', 'spec:A'] });
    const r = await me.leaseAcquire({ collection: C, key: 'task-2', session: 's2', scope: ['res:bench'] });
    expect(r).toMatchObject({ granted: false, conflicts: [{ lease: { key: 'task-1' }, overlap: ['res:bench'] }] });
    expect((await me.leaseAcquire({ collection: C, key: 'task-3', session: 's2', scope: ['res:other'] })).granted).toBe(true);
    // A scope naming another lease's key overlaps it too.
    expect((await me.leaseAcquire({ collection: C, key: 'task-4', session: 's3', scope: ['key:task-1'] })).granted).toBe(false);
  });

  it('re-acquire by the holder renews and replaces the scope, keeping acquired_at', async () => {
    const first = await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1', scope: ['res:a'] });
    now += 100;
    const again = await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1', scope: ['res:b'] });
    expect(again).toMatchObject({ granted: true, renewed: true, lease: { scope: ['key:task-1', 'res:b'], heartbeat_at: now } });
    if (first.granted && again.granted) expect(again.lease.acquired_at).toBe(first.lease.acquired_at);
  });

  it('an expired lease can be taken over, and the takeover is recorded', async () => {
    await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1', ttlSeconds: 60 });
    now += 61;
    const r = await other.leaseAcquire({ collection: C, key: 'task-1', session: 'x' });
    expect(r).toMatchObject({ granted: true, renewed: false, took_over_from: { user: 'tester', session: 's1', expired_at: now - 1 } });
    if (r.granted) expect(r.lease.took_over_from).toMatchObject({ session: 's1' });
  });

  it('expired leases are hidden from the default listing and do not block; very old ones are pruned', async () => {
    await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1', ttlSeconds: 60 });
    now += 61;
    expect((await me.leaseList(C)).leases).toEqual([]);
    expect((await me.leaseList(C, true)).leases.map(l => [l.key, l.expired])).toEqual([['task-1', true]]);
    expect((await me.leaseAcquire({ collection: C, key: 'task-2', session: 's2', scope: ['key:task-1'], ttlSeconds: 60 })).granted).toBe(true);
    now += EXPIRED_KEEP_SECONDS + 120;
    await me.leaseAcquire({ collection: C, key: 'task-3', session: 's3' });
    expect((await me.leaseList(C, true)).leases.map(l => l.key)).toEqual(['task-3']);
  });

  it('heartbeat renews every lease of the session (an expired untaken one too); taken keys are lost', async () => {
    await me.leaseAcquire({ collection: C, key: 'a', session: 's1', ttlSeconds: 60 });
    await me.leaseAcquire({ collection: C, key: 'b', session: 's1', ttlSeconds: 60 });
    now += 61;
    await other.leaseAcquire({ collection: C, key: 'b', session: 'x' });
    const r = await me.leaseHeartbeat(C, 's1', ['a', 'b']);
    expect(r.renewed.map(l => [l.key, l.expires_at])).toEqual([['a', now + 60]]);
    expect(r.lost).toEqual(['b']);
  });

  it('heartbeat without a collection renews the session in every collection, and only its own leases', async () => {
    await me.leaseAcquire({ collection: C, key: 'a', session: 's1' });
    await me.leaseAcquire({ collection: 'local-notes', key: 'b', session: 's1' });
    await me.leaseAcquire({ collection: C, key: 'c', session: 's2' });
    const r = await me.leaseHeartbeat(undefined, 's1');
    expect(r.renewed.map(l => `${l.collection}/${l.key}`).sort()).toEqual(['local-notes/b', 'private-acme/a']);
    await expect(me.leaseHeartbeat(undefined, 's1', ['a'])).rejects.toThrow('keys needs a collection');
  });

  it('only the holder session releases; release frees the key', async () => {
    await me.leaseAcquire({ collection: C, key: 'task-1', session: 's1' });
    expect(await me.leaseRelease(C, 'task-1', 's2')).toMatchObject({ released: false, reason: 'held_by_other', lease: { holder: { session: 's1' } } });
    expect(await me.leaseRelease(C, 'task-1', 's1', 'done')).toMatchObject({ released: true });
    expect(await me.leaseRelease(C, 'task-1', 's1')).toEqual({ released: false, reason: 'not_held' });
    expect((await other.leaseAcquire({ collection: C, key: 'task-1', session: 'x' })).granted).toBe(true);
  });

  it('exactly one of many concurrent overlapping acquires wins', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => me.leaseAcquire({ collection: C, key: `k${i}`, session: `s${i}`, scope: ['res:one'] })));
    expect(rs.filter(r => r.granted)).toHaveLength(1);
  });

  it('validates input like the service (a 400)', async () => {
    const bad = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await bad(me.leaseAcquire({ collection: C, key: 'has space', session: 's' }));
    await bad(me.leaseAcquire({ collection: C, key: 'k', session: 'bad session' }));
    await bad(me.leaseAcquire({ collection: C, key: 'k', session: 's', ttlSeconds: 5 }));
    await bad(me.leaseAcquire({ collection: C, key: 'k', session: 's', scope: Array.from({ length: 65 }, (_, i) => `s${i}`) }));
    await bad(me.counterNext(C, 'bad name!'));
    await bad(me.counterNext(C, 'n', -1));
    await expect(me.leaseAcquire({ collection: C, key: 'k', session: 's', ttlSeconds: 5 })).rejects.toBeInstanceOf(LocalCoordinationError);
  });

  it('scope and ttl: fresh gets key:<key> and the default; a renewal without them keeps them; explicit [] replaces', async () => {
    await me.leaseAcquire({ collection: C, key: 'k', session: 's', scope: ['res:a'], ttlSeconds: 300 });
    let r = await me.leaseAcquire({ collection: C, key: 'k', session: 's' });
    expect(r).toMatchObject({ lease: { scope: ['key:k', 'res:a'], ttl_seconds: 300 } });
    r = await me.leaseAcquire({ collection: C, key: 'k', session: 's', scope: [], ttlSeconds: 600 });
    expect(r).toMatchObject({ lease: { scope: ['key:k'], ttl_seconds: 600 } });
    // Your own expired lease, re-acquired without scope: keeps it.
    await me.leaseAcquire({ collection: C, key: 'k2', session: 's', scope: ['res:b'], ttlSeconds: 60 });
    now += 61;
    expect(await me.leaseAcquire({ collection: C, key: 'k2', session: 's' })).toMatchObject({ renewed: true, lease: { scope: ['key:k2', 'res:b'], ttl_seconds: 60 } });
    // A takeover of an expired lease does not inherit them.
    now += 61;
    expect(await other.leaseAcquire({ collection: C, key: 'k2', session: 'x' })).toMatchObject({ renewed: false, lease: { scope: ['key:k2'], ttl_seconds: LEASE_TTL_DEFAULT } });
  });

  it('the conflict check of a renewal without scope uses the stored scope', async () => {
    await me.leaseAcquire({ collection: C, key: 'k', session: 's', scope: ['res:a'] });
    await me.leaseRelease(C, 'k', 's');
    await me.leaseAcquire({ collection: C, key: 'k', session: 's', scope: ['res:a'] });
    await other.leaseAcquire({ collection: C, key: 'other', session: 'x', scope: ['res:z'] });
    expect((await me.leaseAcquire({ collection: C, key: 'k', session: 's' })).granted).toBe(true);
  });

  it('reclaim takes over your own other session\'s live lease and records it; other users still refuse', async () => {
    await me.leaseAcquire({ collection: C, key: 'k', session: 'old' });
    const r = await me.leaseAcquire({ collection: C, key: 'k', session: 'new', reclaim: true });
    expect(r).toMatchObject({ granted: true, took_over_from: { session: 'old', reclaim: true } });
    await other.leaseAcquire({ collection: C, key: 'theirs', session: 'x', scope: ['res:q'] });
    expect((await me.leaseAcquire({ collection: C, key: 'theirs', session: 'new', reclaim: true })).granted).toBe(false);
    // Own overlap ignored with reclaim, own lease on another key left in place.
    await me.leaseAcquire({ collection: C, key: 'mine-a', session: 'old', scope: ['res:w'] });
    expect((await me.leaseAcquire({ collection: C, key: 'mine-b', session: 'new', scope: ['res:w'], reclaim: true })).granted).toBe(true);
    expect((await me.leaseList(C)).leases.map(l => l.key)).toContain('mine-a');
  });

  it('refuses to guess when the state file is unreadable, and says how to recover', async () => {
    writeFileSync(join(dir, `${encodeURIComponent(C)}.json`), '{not json');
    await expect(me.leaseAcquire({ collection: C, key: 'k', session: 's' })).rejects.toThrow(/unreadable .*move it aside \(mv /);
  });

  it('matches the service on the edges: a takeover keeps the title, reclaim must be a boolean, @ collections are reserved', async () => {
    await me.leaseAcquire({ collection: C, key: 'k', session: 's1', ttlSeconds: 60, title: 'the first title' });
    now += 61;
    expect(await other.leaseAcquire({ collection: C, key: 'k', session: 'x' })).toMatchObject({ granted: true, lease: { title: 'the first title' } });
    await expect(me.leaseAcquire({ collection: C, key: 'k2', session: 's', reclaim: 'yes' as unknown as boolean })).rejects.toMatchObject({ status: 400 });
    await expect(me.counterNext('@tasks', 'tester')).rejects.toMatchObject({ status: 400 });
    expect(await me.nextTaskId()).toBe('tester-1');
    // An expired lease stays listed with include_expired until it is pruned.
    now += EXPIRED_KEEP_SECONDS + 3600;
    expect((await me.leaseList(C, true)).leases.map(l => l.key)).toEqual(['k']);
  });
});

describe('counters and task ids', () => {
  it('hands out strictly increasing values, never below the floor, per collection and name', async () => {
    expect(await me.counterNext(C, 'FIND-2026')).toBe(1);
    expect(await me.counterNext(C, 'FIND-2026')).toBe(2);
    expect(await me.counterNext(C, 'FIND-2026', 10)).toBe(11);
    expect(await me.counterNext(C, 'FIND-2026', 3)).toBe(12);
    expect(await me.counterNext(C, 'LIM')).toBe(1);
    expect(await me.counterNext('private-other', 'FIND-2026')).toBe(1);
  });

  it('concurrent callers never get the same value', async () => {
    const vs = await Promise.all(Array.from({ length: 30 }, () => me.counterNext(C, 'n')));
    expect(new Set(vs).size).toBe(30);
  });

  it('task ids: one sequence per user, above the floor', async () => {
    expect(await me.nextTaskId(41)).toBe('tester-42');
    expect(await me.nextTaskId()).toBe('tester-43');
    expect(await other.nextTaskId()).toBe('dana-1');
  });
});

describe('routing and heartbeats', () => {
  it('with sync off, hooks renew local leases and a lease lost to another session leaves a notice', async () => {
    const { createConfig, resetConfig, setConfig } = await import('../config.js');
    const { heartbeatIfDue, localCoordination, noteLeaseHeld, requireCoordination, takeClaimNotices } = await import('./coordination.js');
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases') }));
    try {
      const t0 = Math.floor(Date.now() / 1000);
      const c = await requireCoordination();
      const r = await c.leaseAcquire({ collection: C, key: 'task-9', session: 'hb', ttlSeconds: 60 });
      expect(r.granted).toBe(true);
      noteLeaseHeld('hb', 60, t0, { collection: C, key: 'task-9' });
      // Not due yet (a third of the TTL): nothing renewed.
      expect(await heartbeatIfDue(['hb'], t0 + 5)).toBe(0);
      expect(await heartbeatIfDue(['hb'], t0 + 25)).toBe(1);
      // Another session takes it (reclaim), so the next beat reports it lost.
      await localCoordination().leaseAcquire({ collection: C, key: 'task-9', session: 'other', reclaim: true });
      expect(await heartbeatIfDue(['hb'], t0 + 60)).toBe(0);
      expect(takeClaimNotices()).toEqual([expect.stringMatching(/^Your claim on task-9 \(private-acme\) is no longer held/)]);
    } finally {
      resetConfig();
    }
  });
});

describe('sync on, the service unreachable', () => {
  const setup = async () => {
    const { createConfig, setConfig } = await import('../config.js');
    const { setSyncBackend } = await import('./backend.js');
    setSyncBackend(undefined);
    setConfig(createConfig({
      YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'http://127.0.0.1:9',
      YAPA_SYNC_ID_TOKEN_CMD: 'echo test-token', YAPA_SYNC_ID_TOKEN_CACHE: 'off',
      YAPA_LOCAL_COORD_DIR: join(dir, 'coord'), YAPA_LEASE_STATE_DIR: join(dir, 'leases'),
    }));
    return import('./coordination.js');
  };
  afterEach(async () => {
    (await import('../config.js')).resetConfig();
    (await import('./backend.js')).setSyncBackend(undefined);
  });

  it('renews local leases, keeps the shared one watched, and retries the service on the next prompt', async () => {
    const { heartbeatIfDue, localCoordination, noteLeaseHeld, takeClaimNotices } = await setup();
    const { readFileSync } = await import('node:fs');
    const marker = () => JSON.parse(readFileSync(join(dir, 'leases', 'mix.json'), 'utf-8'));
    const t0 = Math.floor(Date.now() / 1000);
    await localCoordination().leaseAcquire({ collection: C, key: 'local-1', session: 'mix', ttlSeconds: 7200 });
    noteLeaseHeld('mix', 7200, t0, { collection: C, key: 'local-1' });
    noteLeaseHeld('mix', 120, t0, { collection: 'project-acme', key: 'shared-1' }); // granted by the service earlier
    expect(await heartbeatIfDue(['mix'], t0 + 41)).toBe(1); // the local one
    // The failed service beat leaves the 120 s cadence and the last full beat alone...
    expect(marker()).toMatchObject({ min_ttl: 120, last_beat: t0 });
    expect(marker().keys).toEqual(expect.arrayContaining([`${C}\u0000local-1`, 'project-acme\u0000shared-1']));
    // ...so the next prompt tries again, and nothing is reported lost.
    expect(await heartbeatIfDue(['mix'], t0 + 45)).toBe(1);
    expect(takeClaimNotices()).toEqual([]);
  }, 30_000);

  it('a heartbeat for every collection says the shared leases were not renewed', async () => {
    const { localCoordination, requireCoordination } = await setup();
    await localCoordination().leaseAcquire({ collection: C, key: 'local-2', session: 'all' });
    const r = await (await requireCoordination()).leaseHeartbeat(undefined, 'all');
    expect(r.renewed.map(l => l.key)).toEqual(['local-2']);
    expect(r.unreachable).toBeTruthy();
  }, 30_000);
});
