/** API error codes from docs/service-design.md section 5 ("Errors"). */
export type ErrorCode =
  | 'invalid_request'
  | 'invalid_collection'
  | 'embedding_dimension'
  | 'embedding_invalid'
  | 'unauthenticated'
  | 'not_member'
  | 'user_inactive'
  | 'not_owner'
  | 'local_only_collection'
  | 'task_namespace'
  | 'not_found'
  | 'id_taken'
  | 'payload_too_large'
  | 'secret_detected'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_collection: 400,
  embedding_dimension: 422,
  embedding_invalid: 422,
  unauthenticated: 401,
  not_member: 403,
  user_inactive: 403,
  not_owner: 403,
  local_only_collection: 403,
  task_namespace: 403,
  not_found: 404,
  id_taken: 409,
  payload_too_large: 413,
  secret_detected: 422,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Extra response headers (e.g. Retry-After). */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  get status(): number {
    return statusFor(this.code);
  }
}

/** Per-item error inside batch results. */
export interface ItemError {
  code: ErrorCode;
  message: string;
  [k: string]: unknown;
}

export function itemError(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): ItemError {
  return { code, message, ...extra };
}
