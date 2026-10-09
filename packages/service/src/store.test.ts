/**
 * store.ts units with a fake pool: the echo-suppression SQL, the pull byte
 * budget and idempotency key scoping. Real-SQL behavior is covered by
 * test/integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { decodeCursor, posFromSince } from './cursor.js';
import { echoClause, idempotencyStorageKey, pull, requestHash, rowsWithinBudget, type RequestCtx, usernameFromEmail } from './store.js';

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

describe('usernameFromEmail', () => {
  it('lowercases the local part and maps other characters to -', () => {
    expect(usernameFromEmail('josh@redpanda.com')).toBe('josh');
    expect(usernameFromEmail('Dana.Smith+yapa@redpanda.com')).toBe('dana-smith-yapa');
    expect(usernameFromEmail('..@redpanda.com')).toBeUndefined();
    expect(usernameFromEmail(`${'a'.repeat(80)}@x.com`)).toHaveLength(64);
  });
});
