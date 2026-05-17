/**
 * BFF server global error handler (T-018)
 * Maps internal errors to security-safe HTTP responses.
 * Never leaks stack traces or internal details to clients.
 */

import { AuthError, AuthErrorCode, RateLimitError } from '@/types/errors';
import { logger } from '@/bff-server/logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface BffRequest {
  method: string;
  url: string;
}

interface BffResponse {
  status(code: number): BffResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

interface ErrorResponse {
  error: string;
  code: string;
}

// ─── User-facing error messages ────────────────────────────────────────────────
// These are intentionally vague to prevent information leakage (OWASP A01, A05)

const ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  [AuthErrorCode.WEAK_PASSWORD]:
    'Password must be at least 12 characters and include uppercase, lowercase, numbers, and symbols.',
  [AuthErrorCode.DUPLICATE_USERNAME]:
    'That username is already taken. Please choose another.',
  [AuthErrorCode.DUPLICATE_EMAIL]:
    'An account with that email already exists.',
  [AuthErrorCode.INVALID_EMAIL]:
    'Please enter a valid email address.',
  [AuthErrorCode.INVALID_INPUT]:
    'The provided information is invalid. Please check your input.',
  [AuthErrorCode.INVALID_CREDENTIALS]:
    'Authentication failed. Please check your credentials and try again.',
  [AuthErrorCode.ACCOUNT_LOCKED]:
    'Your account has been temporarily locked due to multiple failed login attempts. Please try again later or reset your password.',
  [AuthErrorCode.ACCOUNT_DISABLED]:
    'Your account has been disabled. Please contact support.',
  [AuthErrorCode.ROLES_REVOKED]:
    'Your account permissions have changed. Please log in again.',
  [AuthErrorCode.EMAIL_NOT_VERIFIED]:
    'Please verify your email address before logging in.',
  [AuthErrorCode.AUTH_CODE_INVALID]:
    'Authentication failed. Please try again.',
  [AuthErrorCode.AUTH_CODE_EXPIRED]:
    'Your login session has expired. Please try again.',
  [AuthErrorCode.REDIRECT_URI_MISMATCH]:
    'Authentication failed. Please try again.',
  [AuthErrorCode.TOKEN_EXPIRED]:
    'Your session has expired. Please log in again.',
  [AuthErrorCode.TOKEN_INVALID]:
    'Your session token is invalid. Please log in again.',
  [AuthErrorCode.REFRESH_FAILED]:
    'Unable to refresh your session. Please log in again.',
  [AuthErrorCode.REFRESH_TOKEN_INVALID]:
    'Your session has expired. Please log in again.',
  [AuthErrorCode.SESSION_NOT_FOUND]:
    'Your session could not be found. Please log in again.',
  [AuthErrorCode.SESSION_EXPIRED]:
    'Your session has expired. Please log in again.',
  [AuthErrorCode.SESSION_IDLE_TIMEOUT]:
    'Your session has ended due to inactivity. Please log in again.',
  [AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT]:
    'Your session has ended for security purposes. Please log in again.',
  [AuthErrorCode.SESSION_LIMIT_EXCEEDED]:
    'Maximum active sessions reached. Your oldest session has been ended.',
  [AuthErrorCode.UNAUTHORIZED]:
    'Authentication required.',
  [AuthErrorCode.FORBIDDEN]:
    'You do not have permission to access this resource.',
  [AuthErrorCode.VERIFICATION_TOKEN_INVALID]:
    'This verification link is invalid or has already been used.',
  [AuthErrorCode.VERIFICATION_TOKEN_EXPIRED]:
    'This verification link has expired. Please request a new one.',
  [AuthErrorCode.ALREADY_VERIFIED]:
    'Your email address has already been verified.',
  [AuthErrorCode.KEYCLOAK_UNAVAILABLE]:
    'The authentication service is temporarily unavailable. Please try again later.',
  [AuthErrorCode.RATE_LIMIT_EXCEEDED]:
    'Too many requests. Please try again later.',
  [AuthErrorCode.UNKNOWN]:
    'An unexpected error occurred. Please try again.',
  [AuthErrorCode.UNKNOWN_ERROR]:
    'An unexpected error occurred. Please try again.',
};

// ─── Error handler ─────────────────────────────────────────────────────────────

export function handleBffError(
  error: unknown,
  req: BffRequest,
  res: BffResponse,
): void {
  if (error instanceof RateLimitError) {
    res.setHeader('Retry-After', String(error.retryAfter));
    res.status(429).json({
      error: ERROR_MESSAGES[AuthErrorCode.RATE_LIMIT_EXCEEDED],
      code: AuthErrorCode.RATE_LIMIT_EXCEEDED,
    } satisfies ErrorResponse);
    return;
  }

  if (error instanceof AuthError) {
    const message = ERROR_MESSAGES[error.code] ?? ERROR_MESSAGES[AuthErrorCode.UNKNOWN];
    res.status(error.statusCode).json({
      error: message,
      code: error.code,
    } satisfies ErrorResponse);
    return;
  }

  // Unknown / unexpected errors — log internally but never expose to client
  logger.error('unhandled BFF error', { action: 'unhandled_error', method: req.method, path: req.url, error });
  res.status(500).json({
    error: ERROR_MESSAGES[AuthErrorCode.UNKNOWN],
    code: AuthErrorCode.UNKNOWN,
  } satisfies ErrorResponse);
}
