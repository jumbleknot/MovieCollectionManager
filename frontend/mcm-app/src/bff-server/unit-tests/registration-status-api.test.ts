/**
 * Unit tests for the PUBLIC registration-status route (feature 040 US3 / Item 1, T029).
 * Verifies it exposes ONLY { allowed }, reflects the toggle, and never breaks on a store error.
 */

const mockGetAppSettings = jest.fn();
jest.mock('@/bff-server/app-settings-store', () => ({
  getAppSettings: (...args: unknown[]) => mockGetAppSettings(...args),
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/bff-server/security-headers', () => ({
  securityHeaders: () => new Headers(),
}));

jest.mock('@/bff-server/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), audit: jest.fn() },
}));

import { GET } from '@/app/bff-api/auth/registration-status+api';

function req(): Request {
  return { headers: { entries: () => Object.entries({})[Symbol.iterator]() } } as unknown as Request;
}

beforeEach(() => jest.clearAllMocks());

it('returns ONLY { allowed:true } when enabled', async () => {
  mockGetAppSettings.mockResolvedValue({ allowSelfRegistration: true, updatedBy: 'a', updatedAt: 't' });
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ allowed: true });
  expect(Object.keys(body)).toEqual(['allowed']); // no updatedBy/updatedAt leaked
});

it('reflects a disabled toggle', async () => {
  mockGetAppSettings.mockResolvedValue({ allowSelfRegistration: false, updatedBy: null, updatedAt: null });
  expect(await (await GET(req())).json()).toEqual({ allowed: false });
});

it('defaults to allowed on a store error (never breaks the login screen)', async () => {
  mockGetAppSettings.mockRejectedValue(new Error('mongo down'));
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ allowed: true });
});
