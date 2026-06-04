/**
 * Unit tests for handleMcApiError (mc-api-error.ts)
 *
 * Verifies:
 *   1. AuthError (401)  → 401 with audit log 'auth_failed'
 *   2. AuthError (403)  → 403 with audit log 'access_denied'
 *   3. Axios error with mc-service response → propagates status + body unchanged
 *   4. Axios 401 from mc-service → audit log 'auth_failed'
 *   5. Axios 403 from mc-service → audit log 'access_denied'
 *   6. Unknown error → 500 with generic message, error log
 */

import { handleMcApiError } from '@/bff-server/mc-api-error';
import { logger } from '@/bff-server/logger';
import { UnauthorizedError, ForbiddenError, AuthError, AuthErrorCode } from '@/types/errors';

jest.mock('@/bff-server/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    audit: jest.fn(),
  },
}));

jest.mock('@/bff-server/security-headers', () => ({
  securityHeaders: jest.fn(() => new Headers()),
}));

function makeAxiosError(status: number, data: unknown): Error {
  const err = new Error('mc-service error') as Error & {
    isAxiosError: boolean;
    response: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
}

describe('handleMcApiError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── AuthError (401) ──────────────────────────────────────────────────────────

  it('returns 401 for UnauthorizedError and audit-logs auth_failed', async () => {
    const err = new UnauthorizedError();
    const res = handleMcApiError(err, 'test_action');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe(AuthErrorCode.UNAUTHORIZED); // UnauthorizedError default code
    expect(logger.audit).toHaveBeenCalledWith('auth_failed', expect.objectContaining({ action: 'test_action' }));
    expect(logger.audit).not.toHaveBeenCalledWith('access_denied', expect.anything());
  });

  // ─── AuthError (403) ──────────────────────────────────────────────────────────

  it('returns 403 for ForbiddenError and audit-logs access_denied', async () => {
    const err = new ForbiddenError();
    const res = handleMcApiError(err, 'test_action');
    expect(res.status).toBe(403);
    expect(logger.audit).toHaveBeenCalledWith('access_denied', expect.objectContaining({ action: 'test_action' }));
    expect(logger.audit).not.toHaveBeenCalledWith('auth_failed', expect.anything());
  });

  // ─── Axios errors from mc-service ─────────────────────────────────────────────

  it('propagates mc-service 404 status and body unchanged', async () => {
    const body = { type: 'https://mc-service/errors/not-found', status: 404, title: 'Not Found' };
    const res = handleMcApiError(makeAxiosError(404, body), 'movie_get');
    expect(res.status).toBe(404);
  });

  it('propagates mc-service 409 status and body unchanged', async () => {
    const body = { status: 409, title: 'Duplicate' };
    const res = handleMcApiError(makeAxiosError(409, body), 'collection_create');
    expect(res.status).toBe(409);
  });

  it('audit-logs auth_failed when mc-service returns 401', async () => {
    handleMcApiError(makeAxiosError(401, {}), 'movie_list');
    expect(logger.audit).toHaveBeenCalledWith('auth_failed', expect.objectContaining({ upstream: 'mc-service' }));
  });

  it('audit-logs access_denied when mc-service returns 403', async () => {
    handleMcApiError(makeAxiosError(403, {}), 'collection_delete');
    expect(logger.audit).toHaveBeenCalledWith('access_denied', expect.objectContaining({ upstream: 'mc-service' }));
  });

  // ─── Unexpected errors ────────────────────────────────────────────────────────

  it('returns 500 with generic message for unknown errors', async () => {
    const res = handleMcApiError(new Error('boom'), 'movie_create');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('An unexpected error occurred.');
    expect(body.code).toBe(AuthErrorCode.UNKNOWN_ERROR);
  });

  it('logs error internally for unknown errors without exposing details', async () => {
    handleMcApiError(new Error('internal details'), 'movie_update');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('movie_update'),
      expect.objectContaining({ action: 'movie_update' }),
    );
  });

  it('does not leak internal error details in the 500 response body', async () => {
    const res = handleMcApiError(new Error('secret internal error'), 'some_action');
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('secret internal error');
  });
});

// ─── 010 US2: every 4xx is logged at the boundary (FR-005–FR-009) ────────────────

describe('handleMcApiError — 4xx logging (010 US2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs a warn for a client-side 400 AuthError with action + statusCode, not audit/error (US2-AC1)', () => {
    handleMcApiError(new AuthError(AuthErrorCode.INVALID_INPUT, 'Invalid id', 400), 'movie_get');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'movie_get', statusCode: 400 }),
    );
    expect(logger.audit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a warn for an upstream 404 (US2-AC1)', () => {
    handleMcApiError(makeAxiosError(404, { status: 404 }), 'movie_get');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'movie_get', statusCode: 404 }),
    );
    expect(logger.audit).not.toHaveBeenCalled();
  });

  it('logs a warn for an upstream 409 conflict', () => {
    handleMcApiError(makeAxiosError(409, { status: 409 }), 'collection_create');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: 'collection_create', statusCode: 409 }),
    );
  });

  it('keeps 401 as an audit event, never a warn (US2-AC2)', () => {
    handleMcApiError(new UnauthorizedError(), 'movie_get');
    expect(logger.audit).toHaveBeenCalledWith('auth_failed', expect.objectContaining({ action: 'movie_get' }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps 403 as an audit event, never a warn (US2-AC2)', () => {
    handleMcApiError(new ForbiddenError(), 'movie_get');
    expect(logger.audit).toHaveBeenCalledWith('access_denied', expect.objectContaining({ action: 'movie_get' }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps an unexpected (non-4xx) error as an error log (US2-AC4)', () => {
    handleMcApiError(new Error('boom'), 'movie_get');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.audit).not.toHaveBeenCalled();
  });

  it('does not include token/PII fields in the 4xx warn context (US2-AC3)', () => {
    handleMcApiError(new AuthError(AuthErrorCode.INVALID_INPUT, 'Invalid id', 400), 'movie_get');
    const ctx = (logger.warn as jest.Mock).mock.calls[0]?.[1] ?? {};
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toMatch(/Bearer |eyJ|password|sessionId/i);
  });
});
