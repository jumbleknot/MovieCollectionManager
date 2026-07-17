/**
 * Unit tests for the admin settings route (feature 040 US3 / Item 1, T028).
 * The RBAC gate (requireMcAdmin) is REAL; requireAuth + the store + logger are mocked.
 * Verifies: 401 unauth, 403 non-admin (both audited), 200 GET default, 200 PATCH persists +
 * audit, 400 invalid body.
 */

import { AuthError, AuthErrorCode, UnauthorizedError } from '@/types/errors';
import { ClientRole } from '@/types/auth';
import type { UserProfile } from '@/types/auth';

const mockRequireAuth = jest.fn();
jest.mock('@/bff-server/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

const mockGetAppSettings = jest.fn();
const mockSetAllow = jest.fn();
jest.mock('@/bff-server/app-settings-store', () => ({
  getAppSettings: (...args: unknown[]) => mockGetAppSettings(...args),
  setAllowSelfRegistration: (...args: unknown[]) => mockSetAllow(...args),
}));

jest.mock('@/bff-server/rate-limiter', () => ({
  extractClientIp: () => '10.0.0.1',
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/bff-server/security-headers', () => ({
  securityHeaders: () => new Headers(),
}));

const mockAudit = jest.fn();
jest.mock('@/bff-server/logger', () => ({
  logger: {
    audit: (...args: unknown[]) => mockAudit(...args),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import { GET, PATCH } from '@/app/bff-api/admin/settings+api';

function admin(): UserProfile {
  return {
    id: 'admin-uuid',
    username: 'boss',
    email: 'boss@example.com',
    firstName: 'B',
    lastName: 'S',
    roles: [ClientRole.MCAdmin],
    emailVerified: true,
    accountStatus: 'active',
    createdAt: new Date().toISOString(),
  };
}

function nonAdmin(): UserProfile {
  return { ...admin(), id: 'user-uuid', roles: [ClientRole.MCUser] };
}

function req(body?: unknown): Request {
  return {
    json: () => Promise.resolve(body ?? {}),
    headers: { entries: () => Object.entries({})[Symbol.iterator]() },
  } as unknown as Request;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /admin/settings', () => {
  it('401 (audited) when unauthenticated', async () => {
    mockRequireAuth.mockRejectedValue(new UnauthorizedError());
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockAudit).toHaveBeenCalledWith('admin_access_denied', expect.objectContaining({ code: AuthErrorCode.UNAUTHORIZED }));
  });

  it('403 (audited) when authenticated but not mc-admin', async () => {
    mockRequireAuth.mockResolvedValue({ user: nonAdmin() });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockAudit).toHaveBeenCalledWith('admin_access_denied', expect.objectContaining({ code: AuthErrorCode.FORBIDDEN }));
    expect(mockGetAppSettings).not.toHaveBeenCalled();
  });

  it('200 returns settings for an admin', async () => {
    mockRequireAuth.mockResolvedValue({ user: admin() });
    mockGetAppSettings.mockResolvedValue({ allowSelfRegistration: true, updatedBy: null, updatedAt: null });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowSelfRegistration: true, updatedBy: null, updatedAt: null });
  });
});

describe('PATCH /admin/settings', () => {
  it('403 for a non-admin, no write', async () => {
    mockRequireAuth.mockResolvedValue({ user: nonAdmin() });
    const res = await PATCH(req({ allowSelfRegistration: false }));
    expect(res.status).toBe(403);
    expect(mockSetAllow).not.toHaveBeenCalled();
  });

  it('400 when body is not a boolean', async () => {
    mockRequireAuth.mockResolvedValue({ user: admin() });
    const res = await PATCH(req({ allowSelfRegistration: 'nope' }));
    expect(res.status).toBe(400);
    expect(mockSetAllow).not.toHaveBeenCalled();
  });

  it('200 persists and audits the change', async () => {
    mockRequireAuth.mockResolvedValue({ user: admin() });
    mockSetAllow.mockResolvedValue({ allowSelfRegistration: false, updatedBy: 'admin-uuid', updatedAt: 'ts' });
    const res = await PATCH(req({ allowSelfRegistration: false }));
    expect(res.status).toBe(200);
    expect(mockSetAllow).toHaveBeenCalledWith(false, 'admin-uuid');
    expect(mockAudit).toHaveBeenCalledWith(
      'admin_setting_changed',
      expect.objectContaining({ setting: 'allowSelfRegistration', value: false, userId: 'admin-uuid' }),
    );
  });
});
