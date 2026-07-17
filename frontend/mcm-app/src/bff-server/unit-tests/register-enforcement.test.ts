/**
 * Unit tests for the self-registration gate on POST /register (feature 040 US3 / Item 1, T030).
 * Verifies: disabled ⇒ 403 + audit + NO user created; enabled ⇒ proceeds (201). Fail-closed.
 */

const mockGetAppSettings = jest.fn();
jest.mock('@/bff-server/app-settings-store', () => ({
  getAppSettings: (...args: unknown[]) => mockGetAppSettings(...args),
}));

const mockCreateUser = jest.fn();
const mockAssignRole = jest.fn();
const mockSendVerify = jest.fn();
jest.mock('@/bff-server/keycloak', () => ({
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  assignMcUserRole: (...args: unknown[]) => mockAssignRole(...args),
  sendVerificationEmail: (...args: unknown[]) => mockSendVerify(...args),
}));

jest.mock('@/bff-server/rate-limiter', () => ({
  checkRegisterRateLimit: jest.fn(),
  checkRegisterIpRateLimit: jest.fn(),
  extractClientIp: () => '10.0.0.2',
}));

jest.mock('@/bff-server/cache-service', () => ({ cacheUserProfile: jest.fn() }));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/bff-server/security-headers', () => ({ securityHeaders: () => new Headers() }));

const mockAudit = jest.fn();
jest.mock('@/bff-server/logger', () => ({
  logger: { audit: (...a: unknown[]) => mockAudit(...a), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { POST } from '@/app/bff-api/auth/register+api';

function req(body: unknown): Request {
  return {
    json: () => Promise.resolve(body),
    headers: {
      get: () => null,
      entries: () => Object.entries({})[Symbol.iterator](),
    },
  } as unknown as Request;
}

const VALID = {
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  password: 'Abcdef1!ghij',
};

beforeEach(() => jest.clearAllMocks());

it('refuses registration with 403 + audit and creates NO user when disabled', async () => {
  mockGetAppSettings.mockResolvedValue({ allowSelfRegistration: false, updatedBy: 'a', updatedAt: 't' });
  const res = await POST(req(VALID));
  expect(res.status).toBe(403);
  expect(mockCreateUser).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith('registration_refused_disabled', expect.objectContaining({ ip: '10.0.0.2' }));
});

it('proceeds to create the user (201) when enabled', async () => {
  mockGetAppSettings.mockResolvedValue({ allowSelfRegistration: true, updatedBy: null, updatedAt: null });
  mockCreateUser.mockResolvedValue('new-user-id');
  mockAssignRole.mockResolvedValue(undefined);
  mockSendVerify.mockResolvedValue(undefined);
  const res = await POST(req(VALID));
  expect(res.status).toBe(201);
  expect(mockCreateUser).toHaveBeenCalledTimes(1);
});

it('fails closed: a store error refuses registration (no user created)', async () => {
  mockGetAppSettings.mockRejectedValue(new Error('mongo down'));
  const res = await POST(req(VALID));
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(mockCreateUser).not.toHaveBeenCalled();
});
