/**
 * yapa-mcp authentication. Cloud Run's invoker check is off for this service
 * (ADP cannot present a Cloud Run ID token), so this module is the only gate.
 * A request is accepted in exactly one of these ways, checked in order:
 *
 *   a. Static key `yapa_sk_<kid>_<secret>` (ADP "Static Key" mode), from the
 *      key header (YAPA_MCP_KEY_HEADER, default X-Yapa-Key) or
 *      `Authorization: Bearer`. Looked up by kid, sha256 compared in constant
 *      time; acts as a reserved `svc-*` principal (kind "service").
 *   b. A JWT: verified as a Google ID token whose `aud` is one of
 *      YAPA_MCP_OAUTH_CLIENT_IDS, then the service's claim checks (issuer,
 *      email_verified, hd).
 *   c. Anything else: an opaque Google access token (ADP "User OAuth" mode).
 *      Google's tokeninfo must report our client id as `aud` or `azp` (any
 *      app's token would pass otherwise), the email scope, a future `exp` and
 *      a verified email; userinfo must report `hd` = YAPA_ALLOWED_HD.
 *      Verified identities are cached by sha256(token).
 *
 * People are then mapped to an active users row exactly like yapa-service
 * (auto-provisioning when enabled; `svc-*` is never created for a person).
 * Every caller is read-only in this phase.
 *
 * TEST-ONLY mode (YAPA_AUTH_MODE=insecure-test, refused on Cloud Run):
 * `Bearer test:<email>` is taken at face value, as in yapa-service.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApiError, AuthFailure, bearerToken, GoogleTokenVerifier, logAuthFailure,
  type TokenVerifier, type UserRow, type VerifiedIdentity,
} from '@yapa/service/lib';
import { STATIC_KEY_RE, type McpConfig, type StaticKeyEntry } from './config.js';

export interface Caller {
  username: string;
  email?: string;
  /** user = a person via OAuth; service = a static key principal. */
  kind: 'user' | 'service';
  /** Phase 1: no write tools exist for anyone. */
  readOnly: true;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type UserLookup = (email: string) => Promise<UserRow | undefined>;

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const EMAIL_SCOPES = new Set(['email', 'https://www.googleapis.com/auth/userinfo.email']);
const EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,255}$/;
/** Opaque tokens are printable and bounded; anything else is rejected before calling Google. */
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Static key -> principal. Throws AuthFailure (malformed_key / unknown_key / bad_key). */
export function verifyStaticKey(presented: string, keys: ReadonlyMap<string, StaticKeyEntry>): string {
  const m = STATIC_KEY_RE.exec(presented);
  if (!m) throw new AuthFailure('malformed_key');
  const entry = keys.get(m[1]);
  if (!entry) throw new AuthFailure('unknown_key');
  const got = Buffer.from(sha256Hex(presented), 'hex');
  const want = Buffer.from(entry.sha256, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new AuthFailure('bad_key');
  return entry.principal;
}

export interface AccessTokenVerifierOptions {
  clientIds: string[];
  allowedHd: string;
  /** Injectable for tests. */
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  cacheMax?: number;
  cacheTtlMs?: number;
}

interface CacheEntry {
  id: VerifiedIdentity;
  until: number;
}

/**
 * Opaque Google access tokens, checked with Google's tokeninfo + userinfo
 * endpoints. Google 4xx -> AuthFailure (401); 5xx, timeouts and network
 * errors -> AuthFailure('google_unavailable') (503).
 */
export class GoogleAccessTokenVerifier implements TokenVerifier {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheMax: number;
  private readonly cacheTtlMs: number;
  private readonly clientIds: ReadonlySet<string>;

  constructor(private readonly opts: AccessTokenVerifierOptions) {
    if (opts.clientIds.length === 0) throw new Error('at least one OAuth client id is required');
    this.clientIds = new Set(opts.clientIds);
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.cacheMax = opts.cacheMax ?? 5000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
  }

  /** Test hook. */
  get cacheSize(): number {
    return this.cache.size;
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    if (!OPAQUE_TOKEN_RE.test(token)) throw new AuthFailure('malformed_token');
    const key = sha256Hex(token);
    const t = this.now();
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      if (hit.until > t) {
        this.cache.set(key, hit); // refresh LRU position
        return hit.id;
      }
    }

    // POST keeps the token out of URLs (and any proxy logs).
    const info = await this.call(TOKENINFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: token }).toString(),
    }, 'invalid_token');
    const aud = str(info.aud);
    const azp = str(info.azp);
    if (!(aud && this.clientIds.has(aud)) && !(azp && this.clientIds.has(azp))) throw new AuthFailure('wrong_audience');
    const scopes = str(info.scope)?.split(/\s+/) ?? [];
    if (!scopes.some(s => EMAIL_SCOPES.has(s))) throw new AuthFailure('missing_email_scope');
    const exp = Number(info.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= t) throw new AuthFailure('token_expired');
    const email = str(info.email)?.toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new AuthFailure('no_email');
    if (info.email_verified !== true && info.email_verified !== 'true') throw new AuthFailure('email_unverified');

    // tokeninfo has no `hd`; userinfo does (for Workspace accounts).
    const user = await this.call(USERINFO_URL, { headers: { authorization: `Bearer ${token}` } }, 'userinfo_rejected');
    const hd = str(user.hd)?.toLowerCase();
    if (!hd || hd !== this.opts.allowedHd) throw new AuthFailure('wrong_hd');
    if (str(user.email)?.toLowerCase() !== email) throw new AuthFailure('identity_mismatch');
    if (info.sub !== undefined && user.sub !== undefined && String(info.sub) !== String(user.sub)) throw new AuthFailure('identity_mismatch');

    const id: VerifiedIdentity = { email };
    this.cache.set(key, { id, until: Math.min(exp * 1000, t + this.cacheTtlMs) });
    while (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value!);
    return id;
  }

  private async call(url: string, init: RequestInit, rejectReason: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new AuthFailure('google_unavailable');
    }
    if (res.status >= 500) throw new AuthFailure('google_unavailable');
    if (!res.ok) throw new AuthFailure(rejectReason);
    try {
      const body = await res.json();
      if (!body || typeof body !== 'object') throw new Error('not an object');
      return body as Record<string, unknown>;
    } catch {
      throw new AuthFailure('google_unavailable');
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Reasons that mean "could not check right now" (503), not "bad credentials" (401). */
const UNAVAILABLE_REASONS = new Set(['google_unavailable', 'cert_fetch_failed']);

export interface AuthenticatorDeps {
  config: Pick<McpConfig, 'authMode' | 'staticKeys' | 'keyHeader'>;
  /** Google ID tokens (JWT); undefined when no OAuth client is configured. */
  idTokens?: TokenVerifier;
  /** Opaque Google access tokens; undefined when no OAuth client is configured. */
  accessTokens?: TokenVerifier;
  lookupUser: UserLookup;
}

export interface AuthInput {
  authorization?: string;
  /** Value of the configured key header. */
  key?: string;
}

export class McpAuthenticator {
  constructor(private readonly deps: AuthenticatorDeps) {}

  get keyHeader(): string {
    return this.deps.config.keyHeader;
  }

  /**
   * Throws ApiError: 401 unauthenticated, 403 not_member / user_inactive,
   * 503 unavailable (Google could not be reached).
   */
  async authenticate(input: AuthInput, requestId?: string): Promise<Caller> {
    const fail = (reason: string): never => {
      logAuthFailure(reason, requestId);
      if (UNAVAILABLE_REASONS.has(reason)) throw new ApiError('unavailable', 'could not verify credentials right now');
      throw new ApiError('unauthenticated', 'invalid or expired credentials');
    };

    const rawKey = input.key?.trim();
    const keyHeaderValue = rawKey ? (/^Bearer\s+/i.test(rawKey) ? bearerToken(rawKey) : rawKey) : undefined;
    if (rawKey && !keyHeaderValue) return fail('malformed_key');
    const token = keyHeaderValue ?? bearerToken(input.authorization);
    if (!token) {
      logAuthFailure('missing_token', requestId);
      throw new ApiError('unauthenticated', 'missing credentials');
    }

    // a. static key
    if (keyHeaderValue || token.startsWith('yapa_sk_')) {
      try {
        return { username: verifyStaticKey(token, this.deps.config.staticKeys), kind: 'service', readOnly: true };
      } catch (e) {
        return fail(e instanceof AuthFailure ? e.reason : 'bad_key');
      }
    }

    // b./c. a person's Google token
    let id: VerifiedIdentity;
    try {
      id = await this.verifyPerson(token);
    } catch (e) {
      return fail(e instanceof AuthFailure ? e.reason : 'invalid_token');
    }
    const user = await this.deps.lookupUser(id.email);
    if (!user) {
      logAuthFailure('no_user_mapping', requestId);
      throw new ApiError('not_member', 'this account is not mapped to a YAPA user; ask an admin');
    }
    if (!user.active) {
      logAuthFailure('user_inactive', requestId);
      throw new ApiError('user_inactive', 'this YAPA user is disabled');
    }
    return { username: user.username, email: user.email.toLowerCase(), kind: 'user', readOnly: true };
  }

  private async verifyPerson(token: string): Promise<VerifiedIdentity> {
    if (this.deps.config.authMode === 'insecure-test' && token.startsWith('test:')) {
      const email = token.slice(5).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new AuthFailure('malformed_token');
      return { email };
    }
    const verifier = token.split('.').length === 3 ? this.deps.idTokens : this.deps.accessTokens;
    if (!verifier) throw new AuthFailure('oauth_disabled');
    return verifier.verify(token);
  }
}

/** Production wiring from the config. */
export function createAuthenticator(cfg: McpConfig, lookupUser: UserLookup, fetchImpl?: FetchLike): McpAuthenticator {
  const oauth = cfg.oauthClientIds.length > 0;
  return new McpAuthenticator({
    config: cfg,
    idTokens: oauth ? new GoogleTokenVerifier(cfg.oauthClientIds, cfg.allowedHd) : undefined,
    accessTokens: oauth ? new GoogleAccessTokenVerifier({ clientIds: cfg.oauthClientIds, allowedHd: cfg.allowedHd, fetch: fetchImpl }) : undefined,
    lookupUser,
  });
}
