/**
 * Unit tests for error message mapping (T-037)
 */

import { getAuthErrorMessage, extractErrorCode, getErrorMessage } from '@/utils/errors';
import { AuthErrorCode } from '@/types/errors';

describe('getAuthErrorMessage', () => {
  it('returns message for known error code', () => {
    expect(getAuthErrorMessage(AuthErrorCode.INVALID_CREDENTIALS)).toBe(
      'Authentication failed. Please check your credentials and try again.',
    );
  });

  it('returns message for RATE_LIMIT_EXCEEDED', () => {
    expect(getAuthErrorMessage(AuthErrorCode.RATE_LIMIT_EXCEEDED)).toBe(
      'Too many requests. Please try again later.',
    );
  });

  it('returns fallback message for undefined code', () => {
    expect(getAuthErrorMessage(undefined)).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });

  it('returns fallback message for unknown code', () => {
    expect(getAuthErrorMessage('UNKNOWN_CODE_XYZ')).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });

  it('returns distinct idle vs absolute session timeout messages', () => {
    const idleMsg = getAuthErrorMessage(AuthErrorCode.SESSION_IDLE_TIMEOUT);
    const absoluteMsg = getAuthErrorMessage(AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT);
    expect(idleMsg).toContain('inactivity');
    expect(absoluteMsg).toContain('security purposes');
    expect(idleMsg).not.toBe(absoluteMsg);
  });
});

describe('extractErrorCode', () => {
  it('extracts code from Axios error response', () => {
    const error = {
      response: {
        data: { code: AuthErrorCode.DUPLICATE_EMAIL, error: 'An account with that email already exists.' },
        status: 409,
      },
    };
    expect(extractErrorCode(error)).toBe(AuthErrorCode.DUPLICATE_EMAIL);
  });

  it('returns undefined for non-Axios error', () => {
    expect(extractErrorCode(new Error('plain error'))).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(extractErrorCode(null)).toBeUndefined();
  });

  it('returns undefined when code is not a string', () => {
    const error = { response: { data: { code: 42 } } };
    expect(extractErrorCode(error)).toBeUndefined();
  });
});

describe('getErrorMessage', () => {
  it('returns user-facing message from Axios error', () => {
    const error = {
      response: {
        data: { code: AuthErrorCode.WEAK_PASSWORD },
        status: 400,
      },
    };
    expect(getErrorMessage(error)).toContain('12 characters');
  });

  it('returns fallback for plain error', () => {
    expect(getErrorMessage(new Error())).toBe(
      'An unexpected error occurred. Please try again.',
    );
  });
});
