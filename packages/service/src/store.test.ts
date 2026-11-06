/**
 * store.ts units with a fake pool: the echo-suppression SQL, the pull byte
 * budget and idempotency key scoping. Real-SQL behavior is covered by
 * test/integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { decodeCursor, posFromSince } from './cursor.js';
import {
  echoClause, findOrCreateUser, idempotencyStorageKey, pull, purgeMany, requestHash, restoreMany, rowsWithinBudget, upsertOne,
  type RequestCtx, usernameFromEmail,
} from './store.js';

interface Q { text: string; values: unknown[] }

function fakePool(respond: (q: Q) => Array<Record<string, unknown>>): { pool: pg.Pool; queries: Q[] } {
  const queries: Q[] = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      const q = { text, values };
      queries.push(q);
      return { rows: /^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(text) ? [] : respond(q), rowCount: 0 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, queries };
}

const ctx = (username: string, device: string): RequestCtx => ({
  caller: { username, email: `${username}@example.com` } as RequestCtx['caller'], device, requestId: 'req-00000001',
});

/** Evaluates the echo predicate the way Postgres would, for a row's write stamps. */
function isEcho(row: { origin_user: string; last_editor: string | null; last_device: string | null; origin_device?: string }, me: string, dev: string): boolean {
  const lastWriter = row.last_editor ?? row.origin_user;
  const lastDev = row.last_device ?? row.origin_device ?? null;
  return (lastWriter === me && (lastDev ?? '') === dev) || (row.origin_user === me && lastDev === null);
}

describe('echo suppression', () => {
  it('pull SQL scopes the device match to rows last written by the caller', async () => {
    const { pool, queries } = fakePool(() => []);
    await pull(pool, ctx('alice', 'A'), {
      collection: 'customer-acme', docsPos: posFromSince(0), delsPos: posFromSince(0), limit: 10,
      includeOwnDevice: false, embeddings: false, maxBytes: 1 << 20,
    });
    const q = queries.find(x => x.text.includes('FROM documents'))!;
    expect(q.text).toMatch(/NOT \(COALESCE\(last_editor, origin_user\) = \$\d+ AND COALESCE\(last_device, metadata->>'origin_device', ''\) = \$\d+\)/);
    expect(q.text).not.toMatch(/COALESCE\(last_device, metadata->>'origin_device', ''\) <>/);
    expect(q.values).toContain('alice');
    expect(q.values).toContain('A');
  });

  it('echoClause binds caller and device as parameters', () => {
    const vals: unknown[] = [];
    const sql = echoClause(v => { vals.push(v); return `$${vals.length}`; }, 'bob', "B'; --");
    expect(vals).toEqual(['bob', "B'; --"]);
    expect(sql).not.toContain("B'");
  });

  it('a teammate writing with the owner device id is NOT an echo for the owner (spoof)', () => {
    // Bob overwrote alice's row sending X-Yapa-Device: A (alice's device).
    const spoofed = { origin_user: 'alice', last_editor: 'bob', last_device: 'A' };
    expect(isEcho(spoofed, 'alice', 'A')).toBe(false); // alice still receives bob's edit
    expect(isEcho(spoofed, 'bob', 'A')).toBe(true); // only bob's own device-A pulls skip it
    expect(isEcho({ origin_user: 'alice', last_editor: 'alice', last_device: 'A' }, 'alice', 'A')).toBe(true);
    expect(isEcho({ origin_user: 'alice', last_editor: 'alice', last_device: 'A' }, 'alice', 'C')).toBe(false);
    expect(isEcho({ origin_user: 'alice', last_editor: null, last_device: null }, 'alice', 'Z')).toBe(true); // legacy
    expect(isEcho({ origin_user: 'alice', last_editor: null, last_device: null }, 'bob', '')).toBe(false);
  });
});

describe('pull byte budget', () => {
  it('rowsWithinBudget always takes one row and stops before the budget', () => {
    expect(rowsWithinBudget([], 10)).toBe(0);
    expect(rowsWithinBudget([50], 10)).toBe(1);
    expect(rowsWithinBudget([4, 4, 4], 10)).toBe(2);
    expect(rowsWithinBudget([5, 5, 1], 10)).toBe(2);
    expect(rowsWithinBudget([1, 1, 1], 10)).toBe(3);
  });

  it('trims a page to the budget, sets has_more and points the cursor at the last returned row', async () => {
    const big = 'x'.repeat(4000);
    const rows = ['d1', 'd2', 'd3', 'd4'].map((id, i) => ({
      id, collection: 'customer-acme', content: big, metadata: {}, origin_user: 'bob', last_editor: 'bob', related_ids: [],
      created_at: '1', updated_at: '1', synced_at: '1', synced_us: String(1_000_000 + i), total: '4',
    }));
    const { pool, queries } = fakePool(q => (q.text.includes('FROM documents') ? rows : []));
    const r = await pull(pool, ctx('alice', 'A'), {
      collection: 'customer-acme', docsPos: posFromSince(0), delsPos: posFromSince(0), limit: 10,
      includeOwnDevice: false, embeddings: false, maxBytes: 9000,
    });
    expect(r.documents.map(d => d.id)).toEqual(['d1', 'd2']);
    expect(r.has_more).toBe(true);
    expect(decodeCursor(r.next_cursor, 'customer-acme').d).toEqual({ t: '1000001', id: 'd2' });
    expect(queries.find(x => x.text.includes('FROM documents'))!.values).toContain(9000);

    // One document larger than the whole budget is still returned alone.
    const one = await pull(fakePool(q => (q.text.includes('FROM documents') ? rows.slice(0, 1).map(x => ({ ...x, total: '1' })) : [])).pool, ctx('alice', 'A'), {
      collection: 'customer-acme', docsPos: posFromSince(0), delsPos: posFromSince(0), limit: 10,
      includeOwnDevice: false, embeddings: false, maxBytes: 100,
    });
    expect(one.documents).toHaveLength(1);
    expect(one.has_more).toBe(false);
  });
});

describe('idempotency scoping', () => {
  it('the storage key and request hash include method and concrete path', () => {
    const k = (t: string) => idempotencyStorageKey('alice', t, 'k-1');
    expect(k('PUT /v1/documents/a')).not.toBe(k('PUT /v1/documents/b'));
    expect(k('PUT /v1/documents/a')).not.toBe(k('POST /v1/documents/a'));
    expect(idempotencyStorageKey('bob', 'PUT /v1/documents/a', 'k-1')).not.toBe(k('PUT /v1/documents/a'));
    expect(requestHash('PUT /v1/documents/a', '{}')).not.toBe(requestHash('PUT /v1/documents/b', '{}'));
  });
});

describe('findOrCreateUser reserves the svc- namespace (no database)', () => {
  // Answers the users lookup with no row and records every statement.
  function fakePool() {
    const sql: string[] = [];
    const pool = {
      query: async (text: string) => {
        sql.push(text);
        return text.startsWith('INSERT')
          ? { rows: [{ username: 'dana', email: 'dana@example.com', active: true }] }
          : { rows: [] };
      },
    } as unknown as pg.Pool;
    return { pool, sql };
  }

  it('never auto-provisions a svc-* username for a person', async () => {
    const { pool, sql } = fakePool();
    expect(await findOrCreateUser(pool, 'svc-task-dashboard@example.com', 'example.com')).toBeUndefined();
    expect(await findOrCreateUser(pool, 'SVC.Reports@example.com', 'example.com')).toBeUndefined();
    expect(sql.some(s => s.startsWith('INSERT'))).toBe(false);
  });

  it('still provisions ordinary names, including ones that merely contain svc', async () => {
    const { pool, sql } = fakePool();
    expect(await findOrCreateUser(pool, 'dana@example.com', 'example.com')).toMatchObject({ username: 'dana' });
    await findOrCreateUser(pool, 'svcteam@example.com', 'example.com');
    expect(sql.filter(s => s.startsWith('INSERT'))).toHaveLength(2);
  });
});

describe('usernameFromEmail', () => {
  it('lowercases the local part and maps other characters to -', () => {
    expect(usernameFromEmail('alex@example.com')).toBe('alex');
    expect(usernameFromEmail('Dana.Smith+yapa@example.com')).toBe('dana-smith-yapa');
    expect(usernameFromEmail('..@example.com')).toBeUndefined();
    expect(usernameFromEmail(`${'a'.repeat(80)}@x.com`)).toHaveLength(64);
  });
});

describe('soft delete ownership (no database)', () => {
  // Like fakePool above, but rowCount follows the rows the responder returns.
  function countingPool(respond: (q: Q) => Array<Record<string, unknown>>) {
    const queries: Q[] = [];
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        const q = { text, values };
        queries.push(q);
        const rows = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT set_config)/.test(text) ? [] : respond(q);
        return { rows, rowCount: rows.length };
      },
      release: () => undefined,
    };
    return { pool: { connect: async () => client } as unknown as pg.Pool, queries };
  }
  const writes = (qs: Q[]) => qs.filter(q => /^\s*(WITH|INSERT|DELETE|UPDATE)/.test(q.text));

  it('purge of a teammate\'s live row is not_owner and changes nothing', async () => {
    const { pool, queries } = countingPool(q => (q.text.includes('FROM documents WHERE id = $1 FOR UPDATE')
      ? [{ collection: 'customer-acme', origin_user: 'bob', last_editor: 'bob' }] : []));
    const r = await purgeMany(pool, ctx('alice', 'A'), ['acme-1']);
    expect(r).toEqual({ results: [{ id: 'acme-1', status: 'error', error: { code: 'not_owner', message: expect.any(String) } }], purged: 0 });
    // The only write is the caller-scoped removal of their own deleted copies, which found none.
    expect(writes(queries).map(q => [q.text.split(' WHERE')[0], q.values])).toEqual([['DELETE FROM deleted_documents', ['acme-1', 'alice']]]);
  });

  it('purge of a reused id removes only the caller\'s deleted copies: purged_copies, no purged_ids or feed entry', async () => {
    const { pool, queries } = countingPool(q => {
      if (q.text.includes('FROM documents WHERE id = $1 FOR UPDATE')) return [{ collection: 'customer-acme', origin_user: 'bob', last_editor: 'bob' }];
      if (q.text.startsWith('DELETE FROM deleted_documents')) return [{ collection: 'customer-acme', last_editor: 'alice', origin_user: 'alice' }];
      return [];
    });
    expect(await purgeMany(pool, ctx('alice', 'A'), ['acme-1'])).toEqual({ results: [{ id: 'acme-1', status: 'purged_copies' }], purged: 1 });
    expect(queries.some(q => q.text.includes('purged_ids') || q.text.includes('INSERT INTO deletions') || q.text.startsWith('DELETE FROM documents'))).toBe(false);
  });

  it('purge with neither a live row nor an own deleted copy is not_found; deleted copies are matched on the caller', async () => {
    const { pool, queries } = countingPool(() => []);
    expect((await purgeMany(pool, ctx('alice', 'A'), ['acme-1'])).results).toEqual([{ id: 'acme-1', status: 'not_found' }]);
    const del = queries.find(q => q.text.startsWith('DELETE FROM deleted_documents'))!;
    expect(del.text).toContain('origin_user = $2');
    expect(del.values).toEqual(['acme-1', 'alice']);
    expect(queries.some(q => q.text.includes('purged_ids') || q.text.includes('INSERT INTO deletions'))).toBe(false);
  });

  it('restore only looks at the caller\'s own deleted rows within retention', async () => {
    const { pool, queries } = countingPool(() => []);
    expect(await restoreMany(pool, ctx('bob', 'B'), ['acme-1'], 30)).toEqual({ results: [{ id: 'acme-1', status: 'not_found' }], restored: 0 });
    const sel = queries.find(q => q.text.includes('FROM deleted_documents'))!;
    expect(sel.text).toMatch(/origin_user = \$2 AND deleted_at > now\(\) - make_interval\(days => \$3::int\)/);
    expect(sel.values).toEqual(['acme-1', 'bob', 30]);
    expect(writes(queries)).toEqual([]);
  });

  it('upsert of a purged id is the item error purged, before any write', async () => {
    const { pool, queries } = countingPool(q => (q.text.includes('FROM purged_ids') ? [{ one: 1 }] : []));
    const r = await upsertOne(pool, ctx('alice', 'A'), {
      id: 'acme-1', collection: 'customer-acme', content: 'x', embedding: Array(384).fill(1 / Math.sqrt(384)), metadata: {}, created_at: 1, updated_at: 1,
    } as never, 0.95);
    expect(r).toEqual({ id: 'acme-1', status: 'error', error: { code: 'purged', message: expect.any(String) } });
    expect(writes(queries)).toEqual([]);
  });
});
