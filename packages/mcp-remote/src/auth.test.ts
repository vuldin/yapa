import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, ConfigError, GoogleTokenVerifier, setLogSink, type UserRow } from '@yapa/service/lib';
import { GoogleAccessTokenVerifier, McpAuthenticator, verifyStaticKey, type FetchLike } from './auth.js';
import { loadMcpConfig, parseStaticKeys, type StaticKeyEntry } from './config.js';

const CLIENT = 'adp-client.apps.example';
const HD = 'example.com';

// ---------------------------------------------------------------- helpers

function newKey(kid: string, principal = 'svc-adp'): { key: string; entry: [string, StaticKeyEntry] } {
  const key = `yapa_sk_${kid}_${randomBytes(32).toString('base64url')}`;
  return { key, entry: [kid, { principal, sha256: createHash('sha256').update(key).digest('hex') }] };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function mint(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT, iat: now, exp: now + 3600, email: 'alice@example.com', email_verified: true, hd: HD, ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function idVerifier(): GoogleTokenVerifier {
  const v = new GoogleTokenVerifier([CLIENT], HD);
  // Stub Google's JWKS fetch with our test key; everything else is the real verifyIdToken.
  (v.client as unknown as { getFederatedSignonCertsAsync: () => Promise<unknown> }).getFederatedSignonCertsAsync =
    async () => ({ certs: { k1: PEM }, format: 'PEM' });
  return v;
}

const NOW = 1_800_000_000_000;
const ACCESS = 'ya29.a0AfB_test-access-token-0123456789';

interface GoogleStub {
  tokeninfo?: { status?: number; body?: Record<string, unknown> } | 'throw';
  userinfo?: { status?: number; body?: Record<string, unknown> } | 'throw';
}

function google(stub: GoogleStub = {}): { fetch: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const respond = (s: GoogleStub['tokeninfo'], dflt: Record<string, unknown>) => {
    if (s === 'throw') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(s?.body ?? dflt), { status: s?.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return respond(stub.tokeninfo, {
          aud: CLIENT, azp: CLIENT, sub: '42', scope: 'openid https://www.googleapis.com/auth/userinfo.email',
          exp: String(NOW / 1000 + 3000), email: 'Alice@example.com', email_verified: 'true',
        });
      }
      if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
        return respond(stub.userinfo, { sub: '42', email: 'alice@example.com', email_verified: true, hd: HD });
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

function accessVerifier(stub: GoogleStub = {}, now = () => NOW) {
  const g = google(stub);
  return { v: new GoogleAccessTokenVerifier({ clientIds: [CLIENT], allowedHd: HD, fetch: g.fetch, now }), calls: g.calls };
}

const USERS: Record<string, UserRow> = {
  'alice@example.com': { username: 'alice', email: 'alice@example.com', active: true },
  'carol@example.com': { username: 'carol', email: 'carol@example.com', active: false },
};
const lookupUser = async (email: string) => USERS[email];

function authenticator(opts: { keys?: Array<[string, StaticKeyEntry]>; access?: GoogleAccessTokenVerifier; mode?: 'google' | 'insecure-test' } = {}) {
  return new McpAuthenticator({
    config: { authMode: opts.mode ?? 'google', staticKeys: new Map(opts.keys ?? []), keyHeader: 'x-yapa-key' },
    idTokens: idVerifier(),
    accessTokens: opts.access ?? accessVerifier().v,
    lookupUser,
  });
}

async function rejects(p: Promise<unknown>, status: number): Promise<ApiError> {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).status).toBe(status);
  return e as ApiError;
}

let lines: string[] = [];
let restore: () => void;
beforeEach(() => { lines = []; restore = setLogSink(l => lines.push(l)); });
afterEach(() => restore());
const reasons = () => lines.map(l => JSON.parse(l)).filter(l => l.event === 'auth_failure').map(l => l.reason);

// ------------------------------------------------------------------ tests

describe('static keys', () => {
  const a = newKey('adp-1');
  const b = newKey('dash-1', 'svc-dash');

  it('accepts a key from Authorization: Bearer and from the key header', async () => {
    const auth = authenticator({ keys: [a.entry, b.entry] });
    expect(await auth.authenticate({ authorization: `Bearer ${a.key}` })).toEqual({ username: 'svc-adp', kind: 'service', readOnly: true });
    expect(await auth.authenticate({ key: b.key })).toEqual({ username: 'svc-dash', kind: 'service', readOnly: true });
    expect(await auth.authenticate({ key: `Bearer ${b.key}` })).toMatchObject({ username: 'svc-dash' });
  });

  it('rejects a wrong secret for a known kid', async () => {
    const wrong = a.key.slice(0, -4) + (a.key.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await rejects(authenticator({ keys: [a.entry] }).authenticate({ authorization: `Bearer ${wrong}` }), 401);
    expect(reasons()).toEqual(['bad_key']);
  });

  it('rejects an unknown kid and a malformed key', async () => {
    const auth = authenticator({ keys: [a.entry] });
    await rejects(auth.authenticate({ key: b.key }), 401);
    await rejects(auth.authenticate({ key: 'yapa_sk_short_x' }), 401);
    await rejects(auth.authenticate({ key: 'not-a-key' }), 401);
    expect(reasons()).toEqual(['unknown_key', 'malformed_key', 'malformed_key']);
  });

  it('never logs the key', async () => {
    await rejects(authenticator({ keys: [a.entry] }).authenticate({ key: b.key }), 401);
    expect(lines.join('\n')).not.toContain(b.key.split('_').pop()!);
  });

  it('verifyStaticKey compares hashes', () => {
    expect(verifyStaticKey(a.key, new Map([a.entry]))).toBe('svc-adp');
  });
});

describe('Google ID tokens (JWT)', () => {
  it('accepts a token for our client and maps it to the users row', async () => {
    expect(await authenticator().authenticate({ authorization: `Bearer ${mint({})}` }))
      .toEqual({ username: 'alice', email: 'alice@example.com', kind: 'user', readOnly: true });
  });

  it('rejects a token minted for another client', async () => {
    await rejects(authenticator().authenticate({ authorization: `Bearer ${mint({ aud: 'other-app' })}` }), 401);
    expect(reasons()).toEqual(['wrong_audience']);
  });

  it('rejects another Workspace domain', async () => {
    await rejects(authenticator().authenticate({ authorization: `Bearer ${mint({ hd: 'other.example' })}` }), 401);
    expect(reasons()).toEqual(['wrong_hd']);
  });
});

describe('Google access tokens', () => {
  it('accepts a valid token (aud match), POSTs it to tokeninfo and never puts it in a URL', async () => {
    const { v, calls } = accessVerifier();
    expect(await v.verify(ACCESS)).toEqual({ email: 'alice@example.com' });
    expect(calls.map(c => c.url)).toEqual(['https://oauth2.googleapis.com/tokeninfo', 'https://openidconnect.googleapis.com/v1/userinfo']);
    expect(calls.every(c => !c.url.includes(ACCESS))).toBe(true);
    expect(String(calls[0].init?.body)).toContain('access_token=');
  });

  it('accepts a token whose azp (not aud) is our client', async () => {
    const { v } = accessVerifier({ tokeninfo: { body: { aud: 'other', azp: CLIENT, scope: 'email', exp: String(NOW / 1000 + 60), email: 'alice@example.com', email_verified: 'true' } } });
    expect(await v.verify(ACCESS)).toEqual({ email: 'alice@example.com' });
  });

  const bad: Array<[string, GoogleStub, string]> = [
    ['an audience mismatch (another app\'s token)', { tokeninfo: { body: { aud: 'other', azp: 'other', scope: 'email', exp: String(NOW / 1000 + 60), email: 'alice@example.com', email_verified: 'true' } } }, 'wrong_audience'],
    ['a token without the email scope', { tokeninfo: { body: { aud: CLIENT, scope: 'openid https://www.googleapis.com/auth/drive', exp: String(NOW / 1000 + 60), email: 'alice@example.com', email_verified: 'true' } } }, 'missing_email_scope'],
    ['an unverified email', { tokeninfo: { body: { aud: CLIENT, scope: 'email', exp: String(NOW / 1000 + 60), email: 'alice@example.com', email_verified: 'false' } } }, 'email_unverified'],
    ['an expired token', { tokeninfo: { body: { aud: CLIENT, scope: 'email', exp: String(NOW / 1000 - 1), email: 'alice@example.com', email_verified: 'true' } } }, 'token_expired'],
    ['a wrong hd', { userinfo: { body: { sub: '42', email: 'alice@example.com', hd: 'other.example' } } }, 'wrong_hd'],
    ['an absent hd (consumer account)', { userinfo: { body: { sub: '42', email: 'alice@example.com' } } }, 'wrong_hd'],
    ['a userinfo identity that differs from tokeninfo', { userinfo: { body: { sub: '43', email: 'alice@example.com', hd: HD } } }, 'identity_mismatch'],
    ['tokeninfo 400 (invalid token)', { tokeninfo: { status: 400, body: { error: 'invalid_token' } } }, 'invalid_token'],
  ];
  for (const [name, stub, reason] of bad) {
    it(`rejects ${name} with 401`, async () => {
      await rejects(authenticator({ access: accessVerifier(stub).v }).authenticate({ authorization: `Bearer ${ACCESS}` }), 401);
      expect(reasons()).toEqual([reason]);
    });
  }

  it('answers 503 when Google returns 5xx or cannot be reached', async () => {
    for (const stub of [{ tokeninfo: { status: 503 } }, { userinfo: { status: 500 } }, { tokeninfo: 'throw' as const }]) {
      await rejects(authenticator({ access: accessVerifier(stub).v }).authenticate({ authorization: `Bearer ${ACCESS}` }), 503);
    }
    expect(reasons()).toEqual(['google_unavailable', 'google_unavailable', 'google_unavailable']);
  });

  it('caches a verified identity until min(exp, 5 min)', async () => {
    let now = NOW;
    const { v, calls } = accessVerifier({}, () => now);
    await v.verify(ACCESS);
    await v.verify(ACCESS);
    expect(calls).toHaveLength(2); // one tokeninfo + one userinfo
    now += 4 * 60_000;
    await v.verify(ACCESS);
    expect(calls).toHaveLength(2);
    now += 2 * 60_000; // past the 5-minute cap
    await v.verify(ACCESS);
    expect(calls).toHaveLength(4);
  });

  it('never caches failures and bounds the cache', async () => {
    const { v, calls } = accessVerifier({ userinfo: { body: { sub: '42', email: 'alice@example.com', hd: 'other.example' } } });
    await expect(v.verify(ACCESS)).rejects.toThrow();
    await expect(v.verify(ACCESS)).rejects.toThrow();
    expect(calls).toHaveLength(4);
    expect(v.cacheSize).toBe(0);

    const g = google();
    const small = new GoogleAccessTokenVerifier({ clientIds: [CLIENT], allowedHd: HD, fetch: g.fetch, now: () => NOW, cacheMax: 3 });
    for (let i = 0; i < 5; i++) await small.verify(`${ACCESS}-${i}`);
    expect(small.cacheSize).toBe(3);
  });
});

describe('user mapping', () => {
  it('403 not_member without a users row, 403 user_inactive for a disabled user', async () => {
    const auth = authenticator({ mode: 'insecure-test' });
    expect((await rejects(auth.authenticate({ authorization: 'Bearer test:dave@example.com' }), 403)).code).toBe('not_member');
    expect((await rejects(auth.authenticate({ authorization: 'Bearer test:carol@example.com' }), 403)).code).toBe('user_inactive');
  });

  it('insecure test tokens only work in insecure-test mode', async () => {
    await rejects(authenticator().authenticate({ authorization: 'Bearer test:alice@example.com' }), 401);
    expect(await authenticator({ mode: 'insecure-test' }).authenticate({ authorization: 'Bearer test:alice@example.com' }))
      .toMatchObject({ username: 'alice', kind: 'user' });
  });

  it('401 without credentials', async () => {
    await rejects(authenticator().authenticate({}), 401);
    expect(reasons()).toEqual(['missing_token']);
  });
});

describe('config', () => {
  const base = { YAPA_DATABASE_URL: 'postgres://x', YAPA_ALLOWED_HD: HD, YAPA_MCP_OAUTH_CLIENT_IDS: CLIENT };

  it('parses static keys and requires svc-* principals', () => {
    const h = 'a'.repeat(64);
    expect(parseStaticKeys(JSON.stringify({ k1: { principal: 'svc-adp', sha256: h } })).get('k1')).toEqual({ principal: 'svc-adp', sha256: h });
    expect(() => parseStaticKeys(JSON.stringify({ k1: { principal: 'alice', sha256: h } }))).toThrow(ConfigError);
    expect(() => parseStaticKeys(JSON.stringify({ k1: { principal: 'svc-adp', sha256: 'nothex' } }))).toThrow(ConfigError);
    expect(() => parseStaticKeys(JSON.stringify({ 'bad_kid': { principal: 'svc-adp', sha256: h } }))).toThrow(ConfigError);
    expect(() => parseStaticKeys('not json')).toThrow(ConfigError);
  });

  it('refuses insecure-test on Cloud Run and requires a way to authenticate', () => {
    expect(() => loadMcpConfig({ ...base, YAPA_AUTH_MODE: 'insecure-test', K_SERVICE: 'yapa-mcp' })).toThrow(/refused on Cloud Run/);
    expect(() => loadMcpConfig({ ...base, YAPA_MCP_OAUTH_CLIENT_IDS: '' })).toThrow(/nothing could authenticate/);
    expect(() => loadMcpConfig({ ...base, YAPA_ALLOWED_HD: '' })).toThrow(/YAPA_ALLOWED_HD/);
    expect(() => loadMcpConfig({ ...base, YAPA_MCP_PUBLIC_URL: 'http://mcp.example' })).toThrow(/https/);
    const cfg = loadMcpConfig({ ...base, YAPA_MCP_PUBLIC_URL: 'https://mcp.example/' });
    expect(cfg.publicUrl).toBe('https://mcp.example');
    expect(cfg.keyHeader).toBe('x-yapa-key');
    expect(cfg.writesEnabled).toBe(false);
  });
});
