import { describe, it, expect, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock('pg', () => ({ default: { Pool: class { query = query; end = vi.fn(); } } }));

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRemoteDocsSinceQuery, upsertRemoteDocument, buildPoolConfig } from './postgres.js';

describe('buildPoolConfig (TLS)', () => {
  const ca = join(mkdtempSync(join(tmpdir(), 'yapa-ca-')), 'server-ca.pem');
  writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
  const remote = 'postgres://u:p@db.example.com:5432/yapa';

  it('verifies the server against the CA when one is configured', () => {
    const c = buildPoolConfig(remote, ca);
    expect(c.tls).toBe('verify-ca');
    expect(c.ssl).toMatchObject({ ca: expect.stringContaining('TEST'), rejectUnauthorized: true });
    expect((c.ssl as any).checkServerIdentity()).toBeUndefined();
  });

  it('encrypts without verification for a remote host with no CA (never plaintext)', () => {
    expect(buildPoolConfig(remote, '')).toMatchObject({ tls: 'unverified', ssl: { rejectUnauthorized: false } });
  });

  it('keeps localhost plaintext by default', () => {
    expect(buildPoolConfig('postgres://u:p@localhost:5433/yapa', '')).toMatchObject({ tls: 'off', ssl: false });
  });

  it('verifies with the CA even for URLs the URL parser rejects', () => {
    expect(buildPoolConfig('postgres://u:p@/yapa?host=db.example.com', ca).tls).toBe('verify-ca');
  });

  it('treats a ?host= remote as remote (TLS), a socket path as local', () => {
    expect(buildPoolConfig('postgres://u:p@/yapa?host=db.example.com', '').tls).toBe('unverified');
    expect(buildPoolConfig('postgres://u:p@/yapa?host=/var/run/postgresql', '').tls).toBe('off');
  });

  it('honors sslmode from the URL and strips it so it cannot override the ssl options', () => {
    const off = buildPoolConfig(`${remote}?sslmode=disable`, ca);
    expect(off).toMatchObject({ tls: 'off', ssl: false });
    expect(off.connectionString).not.toContain('sslmode');
    expect(buildPoolConfig('postgres://u:p@localhost/yapa?sslmode=require', '').tls).toBe('unverified');
    expect(buildPoolConfig(`${remote}?sslmode=verify-ca`, ca).tls).toBe('verify-ca');
    expect(() => buildPoolConfig(`${remote}?sslmode=verify-full`, '')).toThrow(/YAPA_SYNC_CA_CERT/);
  });
});

describe('buildRemoteDocsSinceQuery', () => {
  const self = { user: 'josh', device: 'dev-A' };

  it('skips only this device\'s writes plus this user\'s pre-device legacy rows', () => {
    const q = buildRemoteDocsSinceQuery('project-acme', 100, self);
    expect(q.values).toEqual(['project-acme', 100, 'josh', 'dev-A']);
    expect(q.text).toContain(`COALESCE(metadata->>'origin_device', '') <> $4`);
    expect(q.text).toContain(`NOT (origin_user = $3 AND metadata->>'origin_device' IS NULL)`);
    // Not the old blanket "origin_user != me" filter, which blocked a user's own other machines.
    expect(q.text).not.toMatch(/origin_user\s*!=\s*\$3/);
    expect(q.text).not.toContain('AND origin_user = $3\n');
  });

  it('restricts personal collections to the user\'s own rows', () => {
    const q = buildRemoteDocsSinceQuery('global', 0, self, { onlyOwnRows: true });
    expect(q.text).toMatch(/AND origin_user = \$3\s+ORDER BY/);
  });

  it('drops the echo filters only for a recovery pull', () => {
    const q = buildRemoteDocsSinceQuery('customer-lost', 0, self, { includeOwnDevice: true });
    expect(q.text).not.toContain('origin_device');
  });
});

describe('buildRemoteDocsSinceQuery bind parameters', () => {
  const self = { user: 'josh', device: 'dev-A' };
  const highest = (sql: string) => Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  for (const onlyOwnRows of [false, true]) for (const includeOwnDevice of [false, true]) {
    it(`binds exactly the placeholders it uses (onlyOwnRows=${onlyOwnRows}, includeOwnDevice=${includeOwnDevice})`, () => {
      const q = buildRemoteDocsSinceQuery('c', 0, self, { onlyOwnRows, includeOwnDevice });
      expect(q.values).toHaveLength(highest(q.text));
      if (onlyOwnRows) expect(q.values).toContain('josh');
    });
  }
});

describe('upsertRemoteDocument', () => {
  it('moves the remote row when the doc lives in a different collection now', async () => {
    await upsertRemoteDocument({ id: 'user-140', collection: 'customer-acme', content: 'x', embedding: [0.1], metadata: {}, origin_user: 'user', created_at: 1, updated_at: 2 });
    const [sql, values] = query.mock.calls.at(-1) as unknown as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET[\s\S]*collection = EXCLUDED\.collection/);
    expect(values[1]).toBe('customer-acme');
    // authorship is never rewritten by a later writer
    expect(sql).not.toMatch(/origin_user = EXCLUDED/);
  });
});
