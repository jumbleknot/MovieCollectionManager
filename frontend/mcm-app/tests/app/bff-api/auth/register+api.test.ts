/**
 * Unit tests for BFF /register route (T-054)
 */

// Mock all server-side deps
// 040 US3: register+api now consults the self-registration toggle BEFORE any validation
// (`getAppSettings()` → the app_settings store → a real MongoClient.connect()). Without this mock
// the suite opens a live Mongo connection: it passes on a machine with the stack up, but on a
// machine/CI without Mongo the connect only fails AFTER teardown — jest then aborts the run with
// "Cannot log after tests are done" (a 31s hang + 6 failures). These tests cover the ALLOWED path,
// so registration is enabled here; the disabled path is covered by
// src/bff-server/unit-tests/register-enforcement.test.ts.
jest.mock('@/bff-server/app-settings-store', () => ({
  getAppSettings: jest.fn().mockResolvedValue({
    allowSelfRegistration: true,
    updatedBy: null,
    updatedAt: null,
  }),
}));

jest.mock('@/bff-server/rate-limiter', () => ({
  checkRegisterRateLimit: jest.fn().mockResolvedValue(undefined),
  checkRegisterIpRateLimit: jest.fn().mockResolvedValue(undefined),
  extractClientIp: jest.fn().mockReturnValue('127.0.0.1'),
}));

jest.mock('@/bff-server/keycloak', () => ({
  createUser: jest.fn().mockResolvedValue('user-abc-123'),
  assignMcUserRole: jest.fn().mockResolvedValue(undefined),
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/cache-service', () => ({
  cacheUserProfile: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/bff-api/auth/register+api';
import { checkRegisterRateLimit } from '@/bff-server/rate-limiter';
import { assignMcUserRole, createUser } from '@/bff-server/keycloak';
import { logger } from '@/bff-server/logger';
import { AuthErrorCode, AuthError, RateLimitError } from '@/types/errors';

function makeRequest(body: unknown): {
  url: string;
  headers: Headers;
  json: () => Promise<unknown>;
} {
  return {
    url: 'http://localhost:8081/bff-api/auth/register',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /bff-api/auth/register', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 for valid registration', async () => {
    const res = await POST(
      makeRequest({
        username: 'testuser',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'SecurePass1!extra',
      }) as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await POST(makeRequest({ username: 'testuser' }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.INVALID_INPUT);
  });

  it('returns 400 for invalid email', async () => {
    const res = await POST(
      makeRequest({
        username: 'testuser',
        email: 'not-valid-email',
        firstName: 'Test',
        lastName: 'User',
        password: 'SecurePass1!extra',
      }) as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.INVALID_EMAIL);
  });

  it('returns 400 for weak password', async () => {
    const res = await POST(
      makeRequest({
        username: 'testuser',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'weak',
      }) as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.WEAK_PASSWORD);
  });

  it('returns 429 when rate limit exceeded', async () => {
    (checkRegisterRateLimit as jest.Mock).mockRejectedValueOnce(new RateLimitError(86400));

    const res = await POST(
      makeRequest({
        username: 'testuser',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'SecurePass1!extra',
      }) as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(429);
  });

  // Feature 092. This route used to log nothing when it failed, so a production registration that
  // created the account and then could not give it a role left no trace.
  describe('failure logging', () => {
    const validBody = {
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      password: 'SecurePass1!extra',
    };
    let errorLog: jest.SpyInstance;

    beforeEach(() => {
      errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorLog.mockRestore();
    });

    it('logs a server-side failure, without the request body', async () => {
      (assignMcUserRole as jest.Mock).mockRejectedValueOnce(
        new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to look up the client', 502),
      );

      const res = await POST(makeRequest(validBody) as Parameters<typeof POST>[0]);

      expect(res.status).toBe(502);
      expect(errorLog).toHaveBeenCalledTimes(1);
      const [, context] = errorLog.mock.calls[0];
      expect(context).toMatchObject({ action: 'register_failed', ip: '127.0.0.1' });
      const logged = JSON.stringify(errorLog.mock.calls[0], (_k, v) =>
        v instanceof Error ? v.message : v,
      );
      expect(logged).toContain('Failed to look up the client');
      expect(logged).not.toContain(validBody.password);
      expect(logged).not.toContain(validBody.email);
    });

    it('does not log a refusal the caller caused', async () => {
      (createUser as jest.Mock).mockRejectedValueOnce(
        new AuthError(AuthErrorCode.DUPLICATE_EMAIL, 'Email exists', 409),
      );

      const res = await POST(makeRequest(validBody) as Parameters<typeof POST>[0]);

      expect(res.status).toBe(409);
      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  it('returns 409 when user already exists', async () => {
    (createUser as jest.Mock).mockRejectedValueOnce(
      new AuthError(AuthErrorCode.DUPLICATE_EMAIL, 'Email exists', 409),
    );

    const res = await POST(
      makeRequest({
        username: 'testuser',
        email: 'existing@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'SecurePass1!extra',
      }) as Parameters<typeof POST>[0],
    );

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.DUPLICATE_EMAIL);
  });
});
