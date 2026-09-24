/**
 * Unit tests for the two account-deletion routes (feature 076, T015/T017 — FR-001 to FR-013).
 *
 * These mock `requireAuth` and the stores, so they are unit tests and live here rather than
 * under `tests/integration/`, where the constitution forbids mocking the dependency under test.
 * The real-Keycloak proof that the standing permission is dead is a separate integration test.
 *
 * FR-002 is pinned here rather than left to the design: the userId must come from the validated
 * session and nothing in the request may influence it. The route takes no user parameter today,
 * and this is what notices if one is ever added.
 */

import { UnauthorizedError } from '@/types/errors';
import { ClientRole } from '@/types/auth';
import type { UserProfile } from '@/types/auth';

const mockRequireAuth = jest.fn();
jest.mock('@/bff-server/auth', () => ({
  ...jest.requireActual('@/bff-server/auth'),
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
}));

const mockSetPending = jest.fn();
jest.mock('@/bff-server/cache-service', () => ({
  setPendingAccountDeletion: (...a: unknown[]) => mockSetPending(...a),
  takePendingAccountDeletion: jest.fn(),
}));

const mockVerify = jest.fn();
const mockBuild = jest.fn();
jest.mock('@/bff-server/account-step-up', () => ({
  ...jest.requireActual('@/bff-server/account-step-up'),
  buildStepUpRequest: (...a: unknown[]) => mockBuild(...a),
  verifyStepUpProof: (...a: unknown[]) => mockVerify(...a),
}));

const mockRun = jest.fn();
jest.mock('@/bff-server/account-deletion', () => ({
  runAccountDeletion: (...a: unknown[]) => mockRun(...a),
}));

const mockCountAdmins = jest.fn();
jest.mock('@/bff-server/keycloak', () => ({
  countUsersInClientRole: (...a: unknown[]) => mockCountAdmins(...a),
  exchangeCodeForTokens: jest.fn(),
  decodeJwtPayload: jest.fn(),
}));

const mockRateLimit = jest.fn();
jest.mock('@/bff-server/rate-limiter', () => ({
  extractClientIp: () => '10.0.0.1',
  checkAccountDeletionRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
  getRequestId: () => 'req-1',
}));

jest.mock('@/bff-server/security-headers', () => ({ securityHeaders: () => new Headers() }));

const mockAudit = jest.fn();
jest.mock('@/bff-server/logger', () => ({
  logger: {
    // Wrapped, not passed directly: jest.mock factories are hoisted above the const, so a
    // direct reference captures the TDZ value and logger.audit is undefined at call time.
    audit: (...a: unknown[]) => mockAudit(...a),
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
  },
}));

import { POST as challenge } from '@/app/bff-api/account/delete-challenge+api';
import { GET as callback } from '@/app/bff-api/account/delete+api';

function user(roles: ClientRole[] = [ClientRole.MCUser]): UserProfile {
  return {
    id: 'user-1', username: 'u', email: 'u@example.invalid',
    firstName: 'U', lastName: 'U', roles, emailVerified: true,
  } as UserProfile;
}

const ORIGIN = 'http://localhost:8082';

function challengeReq(): Request {
  return new Request(`${ORIGIN}/bff-api/account/delete-challenge`, { method: 'POST' });
}
function callbackReq(qs: string): Request {
  return new Request(`${ORIGIN}/bff-api/account/delete?${qs}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ user: user() });
  mockRateLimit.mockResolvedValue(undefined);
  mockCountAdmins.mockResolvedValue(3);
  mockBuild.mockResolvedValue({
    authorizationUrl: 'http://kc/auth?x=1',
    state: 'st', codeVerifier: 'vf', redirectUri: `${ORIGIN}/bff-api/account/delete`,
  });
  mockVerify.mockResolvedValue({ ok: true, accessToken: 'at', refreshToken: 'rt' });
  mockRun.mockResolvedValue({ collectionsDeleted: 2 });
});

describe('POST /bff-api/account/delete-challenge', () => {
  it('refuses without a session', async () => {
    mockRequireAuth.mockRejectedValue(new UnauthorizedError('no session'));

    expect((await challenge(challengeReq())).status).toBe(401);
    expect(mockSetPending).not.toHaveBeenCalled();
  });

  it('returns the authorization URL', async () => {
    const res = await challenge(challengeReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorizationUrl: 'http://kc/auth?x=1' });
  });

  it('never returns the PKCE verifier to the browser', async () => {
    const body = await (await challenge(challengeReq())).text();

    expect(body).not.toContain('vf');
    expect(body).not.toContain('codeVerifier');
  });

  it('parks the pending request under the SESSION user id, not anything from the request', async () => {
    await challenge(challengeReq());

    const [userId, payload] = mockSetPending.mock.calls[0];
    expect(userId).toBe('user-1');
    const parked = JSON.parse(payload as string);
    expect(parked).toMatchObject({ state: 'st', codeVerifier: 'vf' });
    expect(typeof parked.authTimeFloor).toBe('number');
  });

  it('derives the redirect URI from the request origin', async () => {
    await challenge(challengeReq());

    expect(mockBuild).toHaveBeenCalledWith(`${ORIGIN}/bff-api/account/delete`);
  });

  it('audits the request', async () => {
    await challenge(challengeReq());

    expect(mockAudit).toHaveBeenCalledWith('account_deletion_requested',
      expect.objectContaining({ userId: 'user-1' }));
  });

  it('refuses the last remaining administrator with 409', async () => {
    mockRequireAuth.mockResolvedValue({ user: user([ClientRole.MCUser, ClientRole.MCAdmin]) });
    mockCountAdmins.mockResolvedValue(1);

    const res = await challenge(challengeReq());

    expect(res.status).toBe(409);
    expect(mockSetPending).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith('account_deletion_refused_last_admin',
      expect.objectContaining({ userId: 'user-1' }));
  });

  it('allows an administrator who is not the last one', async () => {
    mockRequireAuth.mockResolvedValue({ user: user([ClientRole.MCUser, ClientRole.MCAdmin]) });
    mockCountAdmins.mockResolvedValue(2);

    expect((await challenge(challengeReq())).status).toBe(200);
  });

  it('does not count administrators for a non-admin user', async () => {
    await challenge(challengeReq());

    expect(mockCountAdmins).not.toHaveBeenCalled();
  });

  it('applies the rate limit before doing any work', async () => {
    mockRateLimit.mockRejectedValue(Object.assign(new Error('slow down'), { status: 429 }));

    const res = await challenge(challengeReq());

    expect(res.status).toBe(429);
    expect(mockBuild).not.toHaveBeenCalled();
  });
});

describe('GET /bff-api/account/delete', () => {
  it('deletes and redirects to the public confirmation on success', async () => {
    const res = await callback(callbackReq('code=c&state=st'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/account-deleted');
    expect(mockRun).toHaveBeenCalled();
  });

  it('clears the auth cookies on success', async () => {
    const res = await callback(callbackReq('code=c&state=st'));

    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('mcm_session_id=');
  });

  it('redirects with error=reauth and destroys NOTHING when the proof is refused', async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: 'stale_auth' });

    const res = await callback(callbackReq('code=c&state=st'));

    expect(res.headers.get('Location')).toBe('/settings/account?error=reauth');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('audits the refusal with its enumerated reason', async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: 'subject_mismatch' });

    await callback(callbackReq('code=c&state=st'));

    expect(mockAudit).toHaveBeenCalledWith('account_deletion_reauth_rejected',
      expect.objectContaining({ userId: 'user-1', reason: 'subject_mismatch' }));
  });

  it('redirects with error=expired when no request is pending', async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: 'no_pending' });

    const res = await callback(callbackReq('code=c&state=st'));

    expect(res.headers.get('Location')).toBe('/settings/account?error=expired');
  });

  it('reports NOT deleted, never partial success, when a step throws', async () => {
    mockRun.mockRejectedValue(new Error('mc-service unreachable'));

    const res = await callback(callbackReq('code=c&state=st'));

    expect(res.headers.get('Location')).toBe('/settings/account?error=failed');
  });

  it('leaves the failure audit to the pipeline, which knows which step failed', async () => {
    mockRun.mockRejectedValue(new Error('mc-service unreachable'));

    await callback(callbackReq('code=c&state=st'));

    // Auditing here too would double-count every failure and record the weaker entry.
    expect(mockAudit).not.toHaveBeenCalledWith('account_deletion_failed', expect.anything());
  });

  it('does not leak the internal failure into the redirect', async () => {
    mockRun.mockRejectedValue(new Error('mongodb://secret-host:27017 refused'));

    const res = await callback(callbackReq('code=c&state=st'));

    expect(res.headers.get('Location')).not.toContain('mongodb');
    expect(res.headers.get('Location')).not.toContain('secret-host');
  });

  it('refuses without a session before verifying anything', async () => {
    mockRequireAuth.mockRejectedValue(new UnauthorizedError('no session'));

    const res = await callback(callbackReq('code=c&state=st'));

    expect(res.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('refuses a callback with no code', async () => {
    const res = await callback(callbackReq('state=st'));

    expect(mockRun).not.toHaveBeenCalled();
    expect(res.headers.get('Location')).toBe('/settings/account?error=expired');
  });

  it('verifies against the SESSION user id, not anything in the query', async () => {
    await callback(callbackReq('code=c&state=st&userId=someone-else'));

    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });
});
