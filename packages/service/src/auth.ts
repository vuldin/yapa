/**
 * Identity (design section 3, decision 0). Every route except /healthz
 * requires `Authorization: Bearer <Google ID token>`. The token is verified
 * in the app with google-auth-library even though Cloud Run IAM checks it
 * first (defense in depth). Then the verified email is mapped to an active
 * `users` row; the username comes only from there.
 *
 * TEST-ONLY mode (YAPA_AUTH_MODE=insecure-test, refused on Cloud Run):
 * `Bearer test:<email>` is taken at face value so tests can run locally.
 */
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import type { ServiceConfig } from './config.js';
import { ApiError } from './errors.js';
import { log } from './log.js';

export interface VerifiedIdentity {
  email: string;
}

export interface Caller {
  username: string;
  email: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

/** Reason strings are short and never contain token contents or unverified emails. */
export class AuthFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Claims checks after signature/exp/aud/iss verification (exported for tests). */
export function checkGoogleClaims(payload: TokenPayload | undefined, allowedHd: string): VerifiedIdentity {
  if (!payload) throw new AuthFailure('no_payload');
  if (!payload.iss || !GOOGLE_ISSUERS.includes(payload.iss)) throw new AuthFailure('bad_issuer');
  if (!payload.email) throw new AuthFailure('no_email');
  if (payload.email_verified !== true) throw new AuthFailure('email_unverified');
  if (!payload.hd || payload.hd.toLowerCase() !== allowedHd) throw new AuthFailure('wrong_hd');
  return { email: payload.email.toLowerCase() };
}

export class GoogleTokenVerifier implements TokenVerifier {
  constructor(
    private readonly audiences: string[],
    private readonly allowedHd: string,
    /** Injectable for tests (cert fetching is stubbed there). */
    readonly client: OAuth2Client = new OAuth2Client(),
  ) {
    if (audiences.length === 0) throw new Error('at least one audience is required');
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken: token, audience: this.audiences });
      payload = ticket.getPayload();
    } catch (e) {
      throw new AuthFailure(classifyVerifyError(e));
    }
    return checkGoogleClaims(payload, this.allowedHd);
  }
}

/** Map google-auth-library errors to a coarse reason (messages may embed the token). */
function classifyVerifyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/too late|expir/i.test(msg)) return 'token_expired';
  if (/too early/i.test(msg)) return 'token_not_yet_valid';
  if (/audience/i.test(msg)) return 'wrong_audience';
  if (/issuer/i.test(msg)) return 'bad_issuer';
  if (/signature|pem/i.test(msg)) return 'bad_signature';
  if (/segments|parse/i.test(msg)) return 'malformed_token';
  if (/certs|fetch|ENOTFOUND|ECONN|socket|network/i.test(msg)) return 'cert_fetch_failed';
  return 'invalid_token';
}

const EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,255}$/;

/** TEST ONLY: `test:<email>` is accepted without any verification. */
export class InsecureTestVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedIdentity> {
    if (!token.startsWith('test:')) throw new AuthFailure('malformed_token');
    const email = token.slice(5).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new AuthFailure('malformed_token');
    return { email };
  }
}

export function createVerifier(cfg: ServiceConfig): TokenVerifier {
  if (cfg.authMode === 'insecure-test') {
    log('WARNING', 'YAPA_AUTH_MODE=insecure-test: tokens are NOT verified; never use outside local tests');
    return new InsecureTestVerifier();
  }
  return new GoogleTokenVerifier(cfg.audiences, cfg.allowedHd);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : undefined;
}

export interface UserRow {
  username: string;
  email: string;
  active: boolean;
}

export type UserLookup = (email: string) => Promise<UserRow | undefined>;

/** One line per rejected request; a log-based metric matches event="auth_failure". */
export function logAuthFailure(reason: string, requestId?: string): void {
  log('WARNING', 'auth failure', { event: 'auth_failure', reason, request_id: requestId });
}

/**
 * Full authentication: token -> verified email -> active users row.
 * Throws ApiError 401 unauthenticated / 403 not_member / 403 user_inactive.
 */
export async function authenticate(
  authorization: string | undefined,
  verifier: TokenVerifier,
  lookup: UserLookup,
  requestId?: string,
): Promise<Caller> {
  const token = bearerToken(authorization);
  if (!token) {
    logAuthFailure('missing_token', requestId);
    throw new ApiError('unauthenticated', 'missing bearer token');
  }
  let id: VerifiedIdentity;
  try {
    id = await verifier.verify(token);
  } catch (e) {
    const reason = e instanceof AuthFailure ? e.reason : 'invalid_token';
    logAuthFailure(reason, requestId);
    if (reason === 'cert_fetch_failed') throw new ApiError('unavailable', 'could not verify token right now');
    throw new ApiError('unauthenticated', 'invalid or expired token');
  }
  const user = await lookup(id.email);
  if (!user) {
    logAuthFailure('no_user_mapping', requestId);
    throw new ApiError('not_member', 'this account is not mapped to a YAPA user; ask an admin');
  }
  if (!user.active) {
    logAuthFailure('user_inactive', requestId);
    throw new ApiError('user_inactive', 'this YAPA user is disabled');
  }
  return { username: user.username, email: user.email.toLowerCase() };
}
