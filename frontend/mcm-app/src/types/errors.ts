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
  SESSION_IDLE_TIMEOUT = 'SESSION_IDLE_TIMEOUT',
  SESSION_ABSOLUTE_TIMEOUT = 'SESSION_ABSOLUTE_TIMEOUT',
  SESSION_LIMIT_EXCEEDED = 'SESSION_LIMIT_EXCEEDED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',

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

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AuthError';
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
