/**
 * Unit tests for BFF /register route (T-054)
 */

// Mock all server-side deps
jest.mock('@/bff-server/rate-limiter', () => ({
  checkRegisterRateLimit: jest.fn().mockResolvedValue(undefined),
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
import { createUser } from '@/bff-server/keycloak';
import { AuthErrorCode } from '@/types/errors';
import { RateLimitError } from '@/types/errors';

function makeRequest(body: unknown): { url: string; headers: Headers; json: () => Promise<unknown> } {
  return {
    url: 'http://localhost:8081/bff-api/auth/register',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /bff-api/auth/register', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 for valid registration', async () => {
    const res = await POST(makeRequest({
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      password: 'SecurePass1!extra',
    }) as Parameters<typeof POST>[0]);

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
    const res = await POST(makeRequest({
      username: 'testuser',
      email: 'not-valid-email',
      firstName: 'Test',
      lastName: 'User',
      password: 'SecurePass1!extra',
    }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.INVALID_EMAIL);
  });

  it('returns 400 for weak password', async () => {
    const res = await POST(makeRequest({
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      password: 'weak',
    }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.WEAK_PASSWORD);
  });

  it('returns 429 when rate limit exceeded', async () => {
    (checkRegisterRateLimit as jest.Mock).mockRejectedValueOnce(new RateLimitError(86400));

    const res = await POST(makeRequest({
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      password: 'SecurePass1!extra',
    }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(429);
  });

  it('returns 409 when user already exists', async () => {
    const { AuthError } = await import('@/types/errors');
    (createUser as jest.Mock).mockRejectedValueOnce(
      new AuthError(AuthErrorCode.DUPLICATE_EMAIL, 'Email exists', 409),
    );

    const res = await POST(makeRequest({
      username: 'testuser',
      email: 'existing@example.com',
      firstName: 'Test',
      lastName: 'User',
      password: 'SecurePass1!extra',
    }) as Parameters<typeof POST>[0]);

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.DUPLICATE_EMAIL);
  });
});
