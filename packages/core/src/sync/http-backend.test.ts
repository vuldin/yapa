/**
 * HttpBackend over fetch: the shared suites (http-backend.suites.ts), plus
 * what only plain HTTP has: the header contract, Cloud Run IAM answers and
 * base URLs with a path prefix.
 */
import { describe, it, expect } from 'vitest';

import { setConfig, createConfig, getConfig } from '../config.js';
import { HttpBackend, IdTokenProvider, decodeJwtPayload, redactTokens } from './http-backend.js';
import { setSyncBackend, getSyncBackend, syncBackendKind } from './backend.js';
import { backend, base, httpBackendSuites, jwt, seen, setHandler, tokens } from './http-backend.suites.js';

httpBackendSuites({
  start: async () => undefined,
  stop: async () => undefined,
  backend: opts => new HttpBackend({ baseUrl: base, ...opts }),
  signInHint: /gcloud auth login/,
  describeLines: url => ['Backend: YAPA sync service', `Service: ${url}`],
});

describe('plain HTTP', () => {
  it('sends the ID token as Bearer AND X-Yapa-Id-Token, plus the device; writes carry an Idempotency-Key', async () => {
    const t = jwt(Math.floor(Date.now() / 1000) + 3600);
    setHandler(() => ({ json: { results: [{ id: 'a', status: 'inserted', synced_at: 1, similar: [] }] } }));
    await backend({ tokens: tokens([t]).provider }).upsertMany([{ id: 'a', collection: 'project-x', content: 'c', embedding: [1], metadata: {}, origin_user: 'tester', created_at: 1, updated_at: 1 }]);
    const [r] = seen;
    expect(r.headers.authorization).toBe(`Bearer ${t}`);
    expect(r.headers['x-yapa-id-token']).toBe(t);
    expect(r.headers['x-yapa-device']).toBe('dev-A');
    expect(r.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.documents[0]).not.toHaveProperty('origin_user'); // the server assigns ownership
  });

  it('explains a Cloud Run IAM 403 (HTML body, no API error code)', async () => {
    setHandler(() => ({ status: 403, text: '<html>Forbidden</html>' }));
    await expect(backend().collections()).rejects.toThrow(/roles\/run\.invoker/);
  });

  it('decodes exp without verification and redacts JWT-like text', () => {
    const t = jwt(123, 'z@example.com');
    expect(decodeJwtPayload(t)).toMatchObject({ exp: 123, email: 'z@example.com' });
    expect(decodeJwtPayload('opaque')).toBeUndefined();
    expect(redactTokens(`x ${t} y`)).toBe('x <token> y');
  });

  it('a base URL with a path prefix keeps it: every request goes to <prefix>/v1/...', async () => {
    expect(createConfig({ YAPA_SYNC_SERVICE_URL: 'https://sync.example.com/api/yapa/' }).SYNC_SERVICE_URL).toBe('https://sync.example.com/api/yapa');
    setHandler(s => (s.path.endsWith('/v1/me')
      ? { json: { username: 'tester', email: 'tester@example.com' } }
      : { json: { documents: [], deletions: [], has_more: false, results: [], deleted: 0, leases: [], now: 0 } }));
    const b = new HttpBackend({ baseUrl: `${base}/api/yapa/`, tokens: tokens().provider, device: () => 'dev-A', timeoutMs: 2000 });
    expect(b.target).toBe(`${base}/api/yapa`);
    await b.me(true);
    await b.pull('project-x', { since: 0 });
    await b.delete(['a'], 'delete');
    await b.coordination.leaseList('project-x');
    expect(seen.map(s => s.path)).toEqual([
      '/api/yapa/v1/me',
      '/api/yapa/v1/collections/project-x/documents',
      '/api/yapa/v1/documents:batchDelete',
      '/api/yapa/v1/leases',
    ]);
  });
});

describe('backend selection', () => {
  it('the service URL wins over a database URL; neither means no backend', async () => {
    expect(syncBackendKind(createConfig({ YAPA_SYNC_SERVICE_URL: 'https://svc.example', YAPA_SYNC_DATABASE_URL: 'postgres://x' }))).toBe('service');
    expect(syncBackendKind(createConfig({ YAPA_SYNC_DATABASE_URL: 'postgres://x' }))).toBe('postgres');
    expect(syncBackendKind(createConfig({}))).toBeUndefined();
    setSyncBackend(undefined);
    const prev = getConfig();
    setConfig(createConfig({ YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://svc.example/', YAPA_SYNC_DATABASE_URL: 'postgres://u:p@h/db' }));
    const b = await getSyncBackend();
    expect(b?.kind).toBe('service');
    expect(b?.target).toBe('https://svc.example');
    setConfig(prev);
  });
});

describe('IdTokenProvider disk cache', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp, email: 'a@example.com' })).toString('base64url')}.s`;

  it('a second process reuses a still-valid cached token instead of minting', async () => {
    const { mkdtempSync, statSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'yapa-tok-')), 'sub', 'id-token');
    const now = 1_800_000_000_000;
    let minted = 0;
    const mint = async () => { minted++; return jwt(now / 1000 + 3600); };
    const a = new IdTokenProvider(mint, () => now, path);
    const t1 = await a.get();
    expect(minted).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const b = new IdTokenProvider(mint, () => now + 60_000, path);
    expect(await b.get()).toBe(t1);
    expect(minted).toBe(1);
    const late = new IdTokenProvider(mint, () => now + 3600_000, path);
    await late.get();
    expect(minted).toBe(2);
    late.invalidate();
    expect(existsSync(path)).toBe(false);
  });
});
