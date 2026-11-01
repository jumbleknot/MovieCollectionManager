/**
 * Auth error types and codes (T-033)
 * Plan: specs/001-user-login/plan.md — Error Messaging Strategy
 */

export enum AuthErrorCode {
  // Registration errors
  WEAK_PASSWORD = 'WEAK_PASSWORD',
  DUPLICATE_USERNAME = 'DUPLICATE_USERNAME',
  DUPLICATE_EMAIL = 'DUPLICATE_EMAIL',
  INVALID_EMAIL = 'INVALID_EMAIL',
  INVALID_INPUT = 'INVALID_INPUT',

  // Login errors
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  ROLES_REVOKED = 'ROLES_REVOKED',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  AUTH_CODE_INVALID = 'AUTH_CODE_INVALID',
  AUTH_CODE_EXPIRED = 'AUTH_CODE_EXPIRED',
  REDIRECT_URI_MISMATCH = 'REDIRECT_URI_MISMATCH',

  // Session errors
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  REFRESH_FAILED = 'REFRESH_FAILED',
  REFRESH_TOKEN_INVALID = 'REFRESH_TOKEN_INVALID',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_IDLE_TIMEOUT = 'SESSION_IDLE_TIMEOUT',
  SESSION_ABSOLUTE_TIMEOUT = 'SESSION_ABSOLUTE_TIMEOUT',
  SESSION_LIMIT_EXCEEDED = 'SESSION_LIMIT_EXCEEDED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  // Feature 085: a refresh whose renewed token belongs to someone other than the session owner.
  SESSION_OWNER_MISMATCH = 'SESSION_OWNER_MISMATCH',
  // Feature 085: a concurrent request waited for another request's token renewal and it did not land.
  SESSION_RENEWAL_PENDING = 'SESSION_RENEWAL_PENDING',

  // Run-scoped assistant identity (feature 085, item #844)
  AGENT_IDENTITY_REJECTED = 'AGENT_IDENTITY_REJECTED',
  AGENT_IDENTITY_UNAVAILABLE = 'AGENT_IDENTITY_UNAVAILABLE',

  // Email verification errors
  VERIFICATION_TOKEN_INVALID = 'VERIFICATION_TOKEN_INVALID',
  VERIFICATION_TOKEN_EXPIRED = 'VERIFICATION_TOKEN_EXPIRED',
  ALREADY_VERIFIED = 'ALREADY_VERIFIED',

  // Infrastructure errors
  KEYCLOAK_UNAVAILABLE = 'KEYCLOAK_UNAVAILABLE',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  UNKNOWN = 'UNKNOWN',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  TOKEN_INVALID = 'TOKEN_INVALID',
}

export interface AuthErrorOptions {
  /** Set-Cookie lines the response must carry, e.g. clearing a session that just ended. */
  clearCookies?: string[];
  /** Seconds for a `Retry-After` header on a retryable (503) refusal. */
  retryAfterSeconds?: number;
}

export class AuthError extends Error {
  public readonly clearCookies?: string[];
  public readonly retryAfterSeconds?: number;

  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    options: AuthErrorOptions = {},
  ) {
    super(message);
    this.name = 'AuthError';
    this.clearCookies = options.clearCookies;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class RateLimitError extends AuthError {
  constructor(
    public readonly retryAfter: number,
  ) {
    super(AuthErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests. Please try again later.', 429);
    this.name = 'RateLimitError';
  }
}

export class UnauthorizedError extends AuthError {
  constructor(message = 'Authentication required.') {
    super(AuthErrorCode.UNAUTHORIZED, message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = 'You do not have permission to access this resource.') {
    super(AuthErrorCode.FORBIDDEN, message, 403);
    this.name = 'ForbiddenError';
  }
}
