import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { authenticate, bearerToken, checkGoogleClaims, GoogleTokenVerifier, InsecureTestVerifier, type UserRow } from './auth.js';
import { ApiError } from './errors.js';
import { loadConfig, ConfigError } from './config.js';
import { setLogSink } from './log.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const AUD = 'desktop-client.apps.example';

function b64(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function mint(claims: Record<string, unknown>, kid = 'k1'): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64({ iss: 'https://accounts.google.com', aud: AUD, iat: now, exp: now + 3600, email: 'alice@example.com', email_verified: true, hd: 'example.com', ...claims });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function verifier(audiences = [AUD]): GoogleTokenVerifier {
  const client = new OAuth2Client();
  // Stub Google's JWKS fetch with our test key; everything else is the real verifyIdToken.
  (client as unknown as { getFederatedSignonCertsAsync: () => Promise<unknown> }).getFederatedSignonCertsAsync =
    async () => ({ certs: { k1: PEM }, format: 'PEM' });
  return new GoogleTokenVerifier(audiences, 'example.com', client);
}

let lines: string[] = [];
let restore: () => void;
beforeEach(() => { lines = []; restore = setLogSink(l => lines.push(l)); });
afterEach(() => restore());

describe('GoogleTokenVerifier (real verifyIdToken, stubbed certs)', () => {
  it('accepts a valid token and lowercases the email', async () => {
    expect(await verifier().verify(mint({ email: 'Alice@Example.com' }))).toEqual({ email: 'alice@example.com' });
  });
  it('accepts any audience on the allow-list', async () => {
    expect(await verifier(['https://svc.example', AUD]).verify(mint({}))).toEqual({ email: 'alice@example.com' });
  });
  const bad: Array<[string, () => string, string]> = [
    ['wrong audience', () => mint({ aud: 'other-app' }), 'wrong_audience'],
    ['expired', () => mint({ iat: 1_700_000_000, exp: 1_700_003_600 }), 'token_expired'],
    ['wrong issuer', () => mint({ iss: 'https://evil.example' }), 'bad_issuer'],
    ['unverified email', () => mint({ email_verified: false }), 'email_unverified'],
    ['missing hd', () => mint({ hd: undefined }), 'wrong_hd'],
    ['other domain', () => mint({ hd: 'other.example' }), 'wrong_hd'],
    ['unknown key id', () => mint({}, 'k2'), 'bad_signature'],
    ['tampered payload', () => { const [h, , s] = mint({}).split('.'); return `${h}.${b64({ email: 'mallory@example.com' })}.${s}`; }, 'bad_signature'],
    ['garbage', () => 'not-a-jwt', 'malformed_token'],
  ];
  for (const [name, tok, reason] of bad) {
    it(`rejects ${name}`, async () => {
      await expect(verifier().verify(tok())).rejects.toMatchObject({ reason });
    });
  }
});

describe('checkGoogleClaims', () => {
  it('requires every claim', () => {
    expect(() => checkGoogleClaims(undefined, 'example.com')).toThrow();
    expect(() => checkGoogleClaims({ iss: 'accounts.google.com', aud: 'x', iat: 1, exp: 2, sub: 's', email_verified: true, hd: 'example.com' }, 'example.com')).toThrow(/no_email/);
  });
});

describe('InsecureTestVerifier', () => {
  it('takes test:<email>', async () => {
    expect(await new InsecureTestVerifier().verify('test:Bob@Example.com')).toEqual({ email: 'bob@example.com' });
    await expect(new InsecureTestVerifier().verify('bob@example.com')).rejects.toThrow();
    await expect(new InsecureTestVerifier().verify('test:nope')).rejects.toThrow();
  });
});

describe('authenticate', () => {
  const users: Record<string, UserRow> = {
    'alice@example.com': { username: 'alice', email: 'alice@example.com', active: true },
    'carol@example.com': { username: 'carol', email: 'carol@example.com', active: false },
  };
  const lookup = async (e: string) => users[e];
  const v = new InsecureTestVerifier();

  it('maps an active user', async () => {
    expect(await authenticate('Bearer test:alice@example.com', v, lookup)).toEqual({ username: 'alice', email: 'alice@example.com' });
  });
  it('401 without a token, logging auth_failure without token contents', async () => {
    await expect(authenticate(undefined, v, lookup)).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    await expect(authenticate('Basic abc', v, lookup)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(authenticate('Bearer garbage-token-value', v, lookup)).rejects.toMatchObject({ code: 'unauthenticated' });
    const events = lines.map(l => JSON.parse(l)).filter(l => l.event === 'auth_failure');
    expect(events.map(e => e.reason)).toEqual(['missing_token', 'missing_token', 'malformed_token']);
    expect(events.every(e => e.severity === 'WARNING')).toBe(true);
    expect(lines.join('\n')).not.toContain('garbage-token-value');
  });
  it('403 not_member for an unmapped email, 403 user_inactive for a disabled user', async () => {
    await expect(authenticate('Bearer test:dave@example.com', v, lookup)).rejects.toMatchObject({ code: 'not_member', status: 403 });
    await expect(authenticate('Bearer test:carol@example.com', v, lookup)).rejects.toMatchObject({ code: 'user_inactive', status: 403 });
    expect(lines.join('\n')).not.toContain('dave@example.com');
  });
  it('bearerToken parsing', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc ')).toBe('abc');
    expect(bearerToken('Bearer a b')).toBeUndefined();
  });
  it('errors are ApiErrors', async () => {
    await expect(authenticate(undefined, v, lookup)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('loadConfig', () => {
  const base = { YAPA_DATABASE_URL: 'postgres://localhost/yapa', YAPA_AUDIENCES: 'a, b', YAPA_ALLOWED_HD: 'Example.com' };
  it('parses audiences and hd', () => {
    const c = loadConfig(base);
    expect(c.audiences).toEqual(['a', 'b']);
    expect(c.allowedHd).toBe('example.com');
    expect(c.port).toBe(8080);
    expect(c.authMode).toBe('google');
  });
  it('google mode needs audiences and hd', () => {
    expect(() => loadConfig({ ...base, YAPA_AUDIENCES: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAPA_ALLOWED_HD: '' })).toThrow(ConfigError);
  });
  it('refuses insecure-test on Cloud Run', () => {
    expect(loadConfig({ YAPA_DATABASE_URL: 'x', YAPA_AUTH_MODE: 'insecure-test' }).authMode).toBe('insecure-test');
    expect(() => loadConfig({ YAPA_DATABASE_URL: 'x', YAPA_AUTH_MODE: 'insecure-test', K_SERVICE: 'yapa-service' })).toThrow(/Cloud Run/);
    expect(() => loadConfig({ ...base, YAPA_AUTH_MODE: 'none' })).toThrow(ConfigError);
  });
  it('needs exactly one database target', () => {
    expect(() => loadConfig({ YAPA_AUDIENCES: 'a', YAPA_ALLOWED_HD: 'h' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, YAPA_INSTANCE_CONNECTION_NAME: 'p:r:i' })).toThrow(ConfigError);
    expect(() => loadConfig({ YAPA_AUDIENCES: 'a', YAPA_ALLOWED_HD: 'h', YAPA_INSTANCE_CONNECTION_NAME: 'p:r:i' })).toThrow(/YAPA_DB_USER/);
    const c = loadConfig({ YAPA_AUDIENCES: 'a', YAPA_ALLOWED_HD: 'h', YAPA_INSTANCE_CONNECTION_NAME: 'p:r:i', YAPA_DB_USER: 'sa@p.iam', YAPA_DB_NAME: 'yapa' });
    expect(c.dbIpType).toBe('PRIVATE');
  });
});
