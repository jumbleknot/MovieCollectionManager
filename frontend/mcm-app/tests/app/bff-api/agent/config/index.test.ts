/**
 * T011 — /bff-api/agent/config GET + DELETE route unit tests (US1, FR-001/016/017/018).
 *
 * GET returns the non-secret view (disabled default for a new user) and NEVER a secret.
 * DELETE clears (disable + wipe secrets) and audits. Both enforce auth (401) + mc-user (403),
 * and derive the userId from the validated session, never the request body.
 */

jest.mock('@/bff-server/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock('@/bff-server/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), audit: jest.fn() },
}));
jest.mock('@/bff-server/security-headers', () => ({ securityHeaders: jest.fn(() => new Headers()) }));
jest.mock('@/bff-server/agent-config-service', () => ({
  getNonSecretView: jest.fn(),
  clear: jest.fn(),
}));

import { GET, DELETE } from '@/app/bff-api/agent/config/index+api';
import { requireAuth } from '@/bff-server/auth';
import * as service from '@/bff-server/agent-config-service';
import { logger } from '@/bff-server/logger';
import { UnauthorizedError } from '@/types/errors';

const mockUser = { id: 'user-42', username: 'u', roles: ['mc-user'], accountStatus: 'active' as const, createdAt: '2026-01-01T00:00:00.000Z' };
const noRoleUser = { ...mockUser, roles: [] as string[] };

const DISABLED_VIEW = {
  enabled: false, provider: 'ollama', ollamaBaseUrl: null,
  hasAnthropicKey: false, hasTmdbKey: false, costLimitUsd: null,
  escalationAvailable: false, updatedAt: null,
};

function makeReq(): Request {
  return { headers: new Headers({ cookie: 'mcm_access_token=tok' }) } as unknown as Request;
}

describe('GET /bff-api/agent/config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: { sub: 'user-42' }, user: mockUser });
    (service.getNonSecretView as jest.Mock).mockResolvedValue(DISABLED_VIEW);
  });

  it('returns the disabled default view for a new user', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DISABLED_VIEW);
    expect(service.getNonSecretView).toHaveBeenCalledWith('user-42');
  });

  it('never returns a secret field', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).not.toHaveProperty('anthropicKey');
    expect(body).not.toHaveProperty('tmdbKey');
    expect(body).not.toHaveProperty('anthropicKeyEnc');
    expect(body).not.toHaveProperty('tmdbKeyEnc');
  });

  it('returns 401 when unauthenticated', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    expect((await GET(makeReq())).status).toBe(401);
  });

  it('returns 403 when the user lacks mc-user/mc-admin', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: {}, user: noRoleUser });
    expect((await GET(makeReq())).status).toBe(403);
  });
});

describe('DELETE /bff-api/agent/config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: { sub: 'user-42' }, user: mockUser });
    (service.clear as jest.Mock).mockResolvedValue(DISABLED_VIEW);
  });

  it('clears the config (scoped to the session user) and audits', async () => {
    const res = await DELETE(makeReq());
    expect(res.status).toBe(200);
    expect(service.clear).toHaveBeenCalledWith('user-42');
    expect(logger.audit).toHaveBeenCalledWith('assistant_config_cleared', expect.objectContaining({ userId: 'user-42' }));
  });

  it('returns 403 when the user lacks mc-user/mc-admin', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: {}, user: noRoleUser });
    expect((await DELETE(makeReq())).status).toBe(403);
    expect(service.clear).not.toHaveBeenCalled();
  });
});
