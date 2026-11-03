import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lease, LeaseAcquireRequest } from '../sync/backend.js';

// A fake coordination service: one live lease per (collection, key).
const leases = new Map<string, Lease>();
let reachable = true;
const acquireCalls: LeaseAcquireRequest[] = [];
const releaseCalls: Array<{ key: string; session: string; outcome?: string }> = [];
const pushNow = vi.fn(async (_collection: string, _ids: string[]) => ({ pushed: _ids, renamed: {} as Record<string, string>, errors: 0 }));

function lease(collection: string, key: string, user: string, session: string, extra: Partial<Lease> = {}): Lease {
  const now = Math.floor(Date.now() / 1000);
  return { collection, key, holder: { user, session, device: null }, title: null, scope: [`key:${key}`], ttl_seconds: 7200,
    acquired_at: now, heartbeat_at: now, expires_at: now + 7200, expired: false, took_over_from: null, ...extra };
}

const fakeCoordination = {
  async leaseAcquire(req: LeaseAcquireRequest & { reclaim?: boolean }) {
    if (!reachable) throw Object.assign(new Error('could not reach the sync service'), { code: 'unreachable' });
    acquireCalls.push(req);
    const k = `${req.collection}/${req.key}`;
    const cur = leases.get(k);
    const me = 'tester';
    if (cur && !(cur.holder.user === me && cur.holder.session === req.session)) {
      if (!(req.reclaim && cur.holder.user === me)) return { granted: false as const, conflicts: [{ lease: cur, overlap: [`key:${req.key}`] }] };
      const l = lease(req.collection, req.key, me, req.session);
      leases.set(k, l);
      return { granted: true as const, lease: l, renewed: false, took_over_from: { user: me, session: cur.holder.session, reclaim: true } };
    }
    const l = lease(req.collection, req.key, me, req.session);
    leases.set(k, l);
    return { granted: true as const, lease: l, renewed: !!cur };
  },
  async leaseRelease(collection: string, key: string, session: string, outcome?: string) {
    if (!reachable) throw Object.assign(new Error('could not reach the sync service'), { code: 'unreachable' });
    releaseCalls.push({ key, session, outcome });
    const k = `${collection}/${key}`;
    const cur = leases.get(k);
    if (!cur) return { released: false as const, reason: 'not_held' as const };
    if (cur.holder.session !== session) return { released: false as const, reason: 'held_by_other' as const, lease: cur };
    leases.delete(k);
    return { released: true as const, lease: cur };
  },
  async leaseList(collection: string) {
    if (!reachable) throw Object.assign(new Error('could not reach the sync service'), { code: 'unreachable' });
    return { leases: [...leases.values()].filter(l => l.collection === collection), now: Math.floor(Date.now() / 1000) };
  },
  leaseHeartbeat: async () => ({ renewed: [], lost: [] }),
  counterNext: async () => 1,
  nextTaskId: async () => ({ id: 'tester-1', number: 1 }),
};

vi.mock('../sync/coordination.js', async importOriginal => {
  const real = await importOriginal<typeof import('../sync/coordination.js')>();
  return {
    ...real,
    // Routed like the real one: local-only collections (and every one with
    // sync off) on this machine, the rest on the fake service.
    requireCoordination: async () => {
      const svc = () => {
        if (!reachable) throw new real.CoordinationUnavailableError('unreachable', 'YAPA sync service could not coordinate: offline');
        return fakeCoordination;
      };
      const pick = (c: string) => (real.coordinatedLocally(c) ? real.localCoordination() : svc());
      return {
        leaseAcquire: async (req: LeaseAcquireRequest) => pick(req.collection).leaseAcquire(req),
        leaseRelease: async (c: string, k: string, s: string, o?: string) => pick(c).leaseRelease(c, k, s, o),
        leaseList: async (c: string) => pick(c).leaseList(c),
        leaseHeartbeat: async () => svc().leaseHeartbeat(),
        counterNext: async () => svc().counterNext(),
        nextTaskId: async () => svc().nextTaskId(),
      };
    },
  };
});
vi.mock('../sync/push.js', async importOriginal => ({ ...(await importOriginal<any>()), pushDocsNow: pushNow }));

const { setConfig, resetConfig, createConfig } = await import('../config.js');
const { setStore, resetStore, createLocalStore } = await import('../store/index.js');
const { createTask } = await import('./create.js');
const { getTask, updateTask, completeTask } = await import('./update.js');
const { deleteTask } = await import('./delete.js');
const { TaskClaimedError, claimNote, claimsFor, retryUnsharedClaims } = await import('./claim.js');
const { takeClaimNotices } = await import('../sync/coordination.js');

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-claim-test-'));
  process.env.YAPA_SESSION = 'sess-a'; // currentSession() reads the env, ahead of CLAUDE_CODE_SESSION_ID
  setConfig(createConfig({
    YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://sync.example.test',
    YAPA_LEASE_STATE_DIR: join(dir, 'leases'), YAPA_LOCAL_COORD_DIR: join(dir, 'coord'),
  }));
  setStore(createLocalStore(join(dir, 'store')));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.YAPA_SESSION;
  resetStore();
  resetConfig();
});

beforeEach(() => {
  leases.clear();
  reachable = true;
  acquireCalls.length = 0;
  releaseCalls.length = 0;
  pushNow.mockClear();
  takeClaimNotices();
});

describe('task claims', () => {
  it('in_progress claims the task, pushes it at once, and complete releases it', async () => {
    const id = await createTask('rotate the staging certs', {}, 'project-acme');
    const r = await updateTask(id, { status: 'in_progress' });
    expect(r.claim?.kind).toBe('granted');
    expect(leases.get(`project-acme/${id}`)?.holder.session).toBe('sess-a');
    // Pushed before the claim (unpushed edits: the id must be final) and after the status write.
    expect(pushNow).toHaveBeenCalledWith('project-acme', [id]);
    expect((await getTask(id))?.metadata.status).toBe('in_progress');

    const done = await completeTask(id);
    expect(done.release?.kind).toBe('released');
    expect(releaseCalls.at(-1)).toMatchObject({ key: id, outcome: 'done' });
    expect(leases.has(`project-acme/${id}`)).toBe(false);
  });

  it('is refused when another holder has it: nothing is written', async () => {
    const id = await createTask('upgrade the broker', {}, 'project-acme');
    leases.set(`project-acme/${id}`, lease('project-acme', id, 'alex', 'sess-x'));
    await expect(updateTask(id, { status: 'in_progress', notes: 'starting' })).rejects.toBeInstanceOf(TaskClaimedError);
    await expect(updateTask(id, { status: 'in_progress' })).rejects.toThrow(/being worked on by alex \(session sess-x\)/);
    const t = await getTask(id);
    expect(t?.metadata.status).toBe('pending');
    expect(t?.metadata.notes ?? '').toBe('');
  });

  it('refuses your own other session unless reclaim is passed', async () => {
    const id = await createTask('write the runbook', {}, 'project-acme');
    leases.set(`project-acme/${id}`, lease('project-acme', id, 'tester', 'sess-old'));
    await expect(updateTask(id, { status: 'in_progress' })).rejects.toThrow(/another session.*reclaim: true/);
    const r = await updateTask(id, { status: 'in_progress' }, { reclaim: true });
    expect(r.claim).toMatchObject({ kind: 'granted', tookOverFrom: { session: 'sess-old', reclaim: true } });
  });

  it('a renewal by the same session sends no scope, so a scope set elsewhere is kept', async () => {
    const id = await createTask('benchmark run', {}, 'project-acme');
    await updateTask(id, { status: 'in_progress' });
    await updateTask(id, { status: 'in_progress' });
    expect(acquireCalls).toHaveLength(2);
    for (const c of acquireCalls) {
      expect(c).not.toHaveProperty('scope');
      expect(c).not.toHaveProperty('ttlSeconds');
    }
  });

  it('blocked and pending release with that outcome; delete releases too', async () => {
    const a = await createTask('a', {}, 'project-acme');
    await updateTask(a, { status: 'in_progress' });
    await updateTask(a, { status: 'blocked', blockedReason: 'waiting on access' });
    expect(releaseCalls.at(-1)).toMatchObject({ key: a, outcome: 'blocked' });

    const b = await createTask('b', {}, 'project-acme');
    await updateTask(b, { status: 'in_progress' });
    await updateTask(b, { status: 'pending' });
    expect(releaseCalls.at(-1)).toMatchObject({ key: b, outcome: 'pending' });

    const c = await createTask('c', {}, 'project-acme');
    await updateTask(c, { status: 'in_progress' });
    await deleteTask(c);
    expect(releaseCalls.at(-1)).toMatchObject({ key: c, outcome: 'deleted' });
  });

  it('uses the re-keyed id when the first push renames the task', async () => {
    const id = await createTask('offline-created task', {}, 'project-acme');
    const { getDocumentsByIds, addDocument, deleteDocument } = await import('../store/index.js');
    pushNow.mockImplementationOnce(async (collection: string, ids: string[]) => {
      const [doc] = await getDocumentsByIds(collection, ids);
      await addDocument(collection, 'tester-900', doc.content, { ...doc.metadata, id: 'tester-900', rekeyed_from: id });
      await deleteDocument(collection, id);
      return { pushed: ['tester-900'], renamed: { [id]: 'tester-900' }, errors: 0 };
    });
    const r = await updateTask(id, { status: 'in_progress' });
    expect(r.id).toBe('tester-900');
    expect(leases.has('project-acme/tester-900')).toBe(true);
    expect((await getTask('tester-900'))?.metadata.status).toBe('in_progress');
  });

  it('offline: the status changes locally, marked unshared; the retry later grants or reports a clash', async () => {
    reachable = false;
    const a = await createTask('offline claim that works out', {}, 'project-acme');
    const b = await createTask('offline claim that clashes', {}, 'project-acme');
    expect((await updateTask(a, { status: 'in_progress' })).claim?.kind).toBe('unshared');
    expect((await updateTask(b, { status: 'in_progress' })).claim?.kind).toBe('unshared');
    expect((await getTask(a))?.metadata.claim_unshared).toBe('sess-a');
    expect(claimNote((await getTask(a))!, undefined)).toBe('claim not shared yet');

    reachable = true;
    leases.set(`project-acme/${b}`, lease('project-acme', b, 'alex', 'sess-x'));
    expect(await retryUnsharedClaims()).toEqual({ granted: 1, refused: 1 });
    expect((await getTask(a))?.metadata.claim_unshared).toBe('');
    expect((await getTask(b))?.metadata.claim_unshared).toBe('');
    const notices = takeClaimNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(new RegExp(`alex .* claimed ${b}`));
  });

  it('local-only collections are claimed on this machine: a second session is refused, the service never asked', async () => {
    const id = await createTask('personal errand', {}, 'private-me');
    const r = await updateTask(id, { status: 'in_progress' });
    expect(r.claim).toMatchObject({ kind: 'granted', id, collection: 'private-me', session: 'sess-a' });
    const other = await updateTask(id, { status: 'in_progress' }, { session: 'sess-b' }).catch(e => e);
    expect(other).toBeInstanceOf(TaskClaimedError);
    expect(other.message).toMatch(new RegExp(`^${id} is being worked on by you \\(another session, sess-a\\) since `));
    expect(acquireCalls).toHaveLength(0);
    expect((await claimsFor('private-me'))?.get(id)?.holder.session).toBe('sess-a');
    // Done: the claim is released, and the next session may take it again.
    await updateTask(id, { status: 'pending' });
    expect((await claimsFor('private-me'))?.has(id)).toBe(false);
    expect((await updateTask(id, { status: 'in_progress' }, { session: 'sess-b' })).claim?.kind).toBe('granted');
    await updateTask(id, { status: 'pending' }, { session: 'sess-b' });
  });

  it('a local claim that lapsed is offered again by the ready queue', async () => {
    const { nextTasks } = await import('./next.js');
    const id = await createTask('lapsing errand', {}, 'private-lapse');
    await updateTask(id, { status: 'in_progress' }, { ttlSeconds: 30 });
    let q = await nextTasks({ collection: 'private-lapse' });
    expect(q.claimsKnown).toBe(true);
    expect(q.skipped.find(x => x.id === id)?.reason).toMatch(/^claimed by you \(another session, sess-a\)/);
    // 31 seconds later, nobody renewed it.
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      q = await nextTasks({ collection: 'private-lapse' });
      expect(q.ready.find(x => x.id === id)).toMatchObject({ lapsed: true });
      const taken = await nextTasks({ collection: 'private-lapse', claim: true, session: 'sess-b' });
      expect(taken.claimed).toMatchObject({ kind: 'granted', id, session: 'sess-b', tookOverFrom: { session: 'sess-a' } });
    } finally {
      Date.now = realNow;
    }
  });

  it('with sync off, shared collections are claimed on this machine too', async () => {
    const prev = createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://sync.example.test', YAPA_LEASE_STATE_DIR: join(dir, 'leases'), YAPA_LOCAL_COORD_DIR: join(dir, 'coord') });
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_LEASE_STATE_DIR: join(dir, 'leases'), YAPA_LOCAL_COORD_DIR: join(dir, 'coord') }));
    try {
      const id = await createTask('solo work', {}, 'project-solo');
      expect((await updateTask(id, { status: 'in_progress' })).claim?.kind).toBe('granted');
      await expect(updateTask(id, { status: 'in_progress' }, { session: 'sess-b' })).rejects.toBeInstanceOf(TaskClaimedError);
      expect(acquireCalls).toHaveLength(0);
    } finally {
      setConfig(prev);
    }
  });

  it('claimNote: holder, yourself, or no live claim', async () => {
    const id = await createTask('annotated', {}, 'project-acme');
    await updateTask(id, { status: 'in_progress' });
    const claims = await claimsFor('project-acme');
    const t = (await getTask(id))!;
    expect(claimNote(t, claims, ['sess-a'])).toMatch(/^claimed by you \(this session\) since /);
    leases.set(`project-acme/${id}`, lease('project-acme', id, 'alex', 'sess-x'));
    expect(claimNote(t, await claimsFor('project-acme'))).toMatch(/^claimed by alex \(session sess-x\) since \d\d:\d\d UTC$/);
    leases.clear();
    expect(claimNote(t, await claimsFor('project-acme'))).toBe('no live claim');
  });
});

describe('nextTasks (ready queue)', () => {
  it('orders by priority, then unblocks; skips claimed, blocked and waiting tasks; claims the first', async () => {
    const { nextTasks } = await import('./next.js');
    const { addDependency } = await import('./dependencies.js');
    const C = 'project-queue';
    const low = await createTask('low one', { priority: 'low' }, C);
    const high = await createTask('high one', { priority: 'high' }, C);
    const med = await createTask('medium, unblocks two', { priority: 'medium' }, C);
    const medPlain = await createTask('medium plain', { priority: 'medium' }, C);
    const w1 = await createTask('waits on med (1)', { priority: 'critical' }, C);
    const w2 = await createTask('waits on med (2)', {}, C);
    await addDependency(w1, med);
    await addDependency(w2, med);
    const blocked = await createTask('blocked one', { priority: 'critical' }, C);
    await updateTask(blocked, { status: 'blocked', blockedReason: 'needs access' });
    const taken = await createTask('someone has it', { priority: 'critical' }, C);
    leases.set(`${C}/${taken}`, lease(C, taken, 'alex', 'sess-x'));
    const skipTag = await createTask('needs a person', { priority: 'critical', tags: ['needs-human'] }, C);

    const r = await nextTasks({ collection: C, excludeTags: ['needs-human'] });
    expect(r.claimsKnown).toBe(true);
    expect(r.ready.map(t => t.id)).toEqual([high, med, medPlain, low]);
    expect(r.ready.find(t => t.id === med)?.unblocks).toBe(2);
    const reasons = Object.fromEntries(r.skipped.map(s => [s.id, s.reason]));
    expect(reasons[w1]).toBe(`waiting on ${med}`);
    expect(reasons[blocked]).toBe('blocked: needs access');
    expect(reasons[taken]).toMatch(/^claimed by alex/);
    expect(reasons[skipTag]).toBe('tagged needs-human');

    // Lost the race for the first one: the next ready task is claimed instead.
    leases.set(`${C}/${high}`, lease(C, high, 'dana', 'sess-d'));
    const c = await nextTasks({ collection: C, excludeTags: ['needs-human'], claim: true });
    expect(c.claimed).toMatchObject({ kind: 'granted', id: med });
    expect((await getTask(med))?.metadata.status).toBe('in_progress');
  });

  it('ranks tasks near live work last, and offers an in_progress task whose claim lapsed', async () => {
    const { nextTasks } = await import('./next.js');
    const C = 'project-near';
    const busy = await createTask('touches the infra repo', { claim_scope: ['repo:infra'] }, C);
    await updateTask(busy, { status: 'in_progress' });
    const near = await createTask('also infra', { priority: 'high', claim_scope: ['repo:infra'] }, C);
    const far = await createTask('docs only', { priority: 'medium', claim_scope: ['repo:docs'] }, C);
    let r = await nextTasks({ collection: C });
    expect(r.ready.map(t => t.id)).toEqual([far, near]);
    expect(r.ready[1].near).toEqual([busy]);

    leases.clear(); // the holder went quiet past the TTL
    r = await nextTasks({ collection: C });
    expect(r.ready.find(t => t.id === busy)?.lapsed).toBe(true);
  });

  it('a claim made offline by another session on this machine is refused locally', async () => {
    reachable = false;
    const id = await createTask('offline shared machine', {}, 'project-acme');
    await updateTask(id, { status: 'in_progress' }, { session: 'sess-other' });
    reachable = true;
    await expect(updateTask(id, { status: 'in_progress' })).rejects.toThrow(/another session, sess-other/);
  });
});
