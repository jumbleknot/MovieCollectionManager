/**
 * Error message mapping utility (T-032)
 * Maps error codes to user-facing, security-safe messages.
 * Used by frontend components to display contextual error feedback.
 */

import { AuthErrorCode } from '@/types/errors';

// ─── User-facing error messages ────────────────────────────────────────────────
// These mirror error-handler.ts (BFF) to ensure consistent messaging.

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
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
  [AuthErrorCode.REFRESH_FAILED]:
    'Unable to refresh your session. Please log in again.',
  [AuthErrorCode.REFRESH_TOKEN_INVALID]:
    'Your session is no longer valid. Please log in again.',
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
  [AuthErrorCode.TOKEN_INVALID]:
    'Authentication failed. Please try again.',
  [AuthErrorCode.UNKNOWN]:
    'An unexpected error occurred. Please try again.',
  [AuthErrorCode.UNKNOWN_ERROR]:
    'An unexpected error occurred. Please try again.',
};

/**
 * Get a user-facing message for an error code (from BFF response or local error).
 * Falls back to the generic error message.
 */
export function getAuthErrorMessage(code: string | undefined): string {
  if (!code) return AUTH_ERROR_MESSAGES[AuthErrorCode.UNKNOWN]!;
  return AUTH_ERROR_MESSAGES[code] ?? AUTH_ERROR_MESSAGES[AuthErrorCode.UNKNOWN]!;
}

/**
 * Extract the error code from an Axios error response.
 * Returns undefined if the response does not contain a structured error.
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'data' in error.response &&
    error.response.data &&
    typeof error.response.data === 'object' &&
    'code' in error.response.data &&
    typeof (error.response.data as { code: unknown }).code === 'string'
  ) {
    return (error.response.data as { code: string }).code;
  }
  return undefined;
}

/**
 * Get a user-facing message from any thrown error (Axios or local).
 */
export function getErrorMessage(error: unknown): string {
  const code = extractErrorCode(error);
  return getAuthErrorMessage(code);
}
