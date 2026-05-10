/**
 * Unit tests for email service (T-154)
 *
 * Covers:
 *   - Send verification email success (Keycloak returns 200)
 *   - Keycloak SMTP error → failure (KEYCLOAK_UNAVAILABLE)
 *   - Resend with valid unverified email → succeeds
 *   - Admin token acquisition failure → propagates error
 *   - Already verified user → ALREADY_VERIFIED error
 *   - isEmailVerified: verified / not verified / user not found
 */

import { sendVerificationEmail, isEmailVerified } from '@/bff-server/email-service';
import { AuthErrorCode } from '@/types/errors';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

// ─── Mock config/env (used by getAdminToken via dynamic import) ───────────────

jest.mock('@/config/env', () => ({
  env: {
    keycloakUrl: 'http://localhost:8099',
    keycloakAdminUser: 'admin',
    keycloakAdminPassword: 'admin-secret',
    keycloakRealm: 'jumbleknot',
    keycloakClientId: 'movie-collection-manager',
    keycloakClientSecret: '',
  },
}));

// ─── Mock keycloak config ─────────────────────────────────────────────────────

jest.mock('@/config/keycloak', () => ({
  keycloakConfig: {
    issuer: 'http://localhost:8099/realms/jumbleknot',
    adminApiBase: 'http://localhost:8099/admin/realms/jumbleknot',
    clientId: 'movie-collection-manager',
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    headers: new Headers(),
  } as unknown as Response;
}

/** Sets up admin token + email endpoint responses in sequence. */
function mockAdminTokenThenEmail(emailStatus: number): void {
  mockedFetch
    .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token-value' })) // getAdminToken
    .mockResolvedValueOnce(emptyResponse(emailStatus));                          // send-verify-email
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── sendVerificationEmail ────────────────────────────────────────────────────

describe('sendVerificationEmail', () => {
  it('sends verification email successfully when Keycloak returns 200', async () => {
    mockAdminTokenThenEmail(200);

    await expect(sendVerificationEmail('user-abc-123')).resolves.toBeUndefined();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const [, emailCall] = mockedFetch.mock.calls;
    expect(emailCall?.[0] as string).toContain('user-abc-123/send-verify-email');
    expect((emailCall?.[1] as RequestInit)?.method).toBe('PUT');
  });

  it('passes the admin token as Authorization Bearer header', async () => {
    mockAdminTokenThenEmail(200);
    await sendVerificationEmail('user-abc');

    const [, emailCall] = mockedFetch.mock.calls;
    const headers = (emailCall?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers?.['Authorization']).toBe('Bearer admin-token-value');
  });

  it('throws KEYCLOAK_UNAVAILABLE when Keycloak SMTP returns a server error (5xx)', async () => {
    mockAdminTokenThenEmail(500);

    await expect(sendVerificationEmail('user-xyz')).rejects.toMatchObject({
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      statusCode: 502,
    });
  });

  it('throws ALREADY_VERIFIED when Keycloak returns 400 (email already verified)', async () => {
    mockAdminTokenThenEmail(400);

    await expect(sendVerificationEmail('user-verified')).rejects.toMatchObject({
      code: AuthErrorCode.ALREADY_VERIFIED,
    });
  });

  it('resend succeeds for a valid unverified email (second call also resolves)', async () => {
    // Simulate two sequential resend requests for the same user
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token-1' }))
      .mockResolvedValueOnce(emptyResponse(200))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token-2' }))
      .mockResolvedValueOnce(emptyResponse(200));

    await expect(sendVerificationEmail('user-unverified')).resolves.toBeUndefined();
    await expect(sendVerificationEmail('user-unverified')).resolves.toBeUndefined();

    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it('throws KEYCLOAK_UNAVAILABLE when the admin token request fails', async () => {
    mockedFetch.mockResolvedValueOnce(emptyResponse(503)); // getAdminToken fails

    await expect(sendVerificationEmail('user-abc')).rejects.toMatchObject({
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      statusCode: 503,
    });
  });
});

// ─── isEmailVerified ──────────────────────────────────────────────────────────

describe('isEmailVerified', () => {
  it('returns true when Keycloak user has emailVerified = true', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token' }))
      .mockResolvedValueOnce(jsonResponse({ emailVerified: true }));

    await expect(isEmailVerified('user-123')).resolves.toBe(true);
  });

  it('returns false when Keycloak user has emailVerified = false', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token' }))
      .mockResolvedValueOnce(jsonResponse({ emailVerified: false }));

    await expect(isEmailVerified('user-456')).resolves.toBe(false);
  });

  it('returns false when emailVerified property is absent in response', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'user-789' })); // no emailVerified field

    await expect(isEmailVerified('user-789')).resolves.toBe(false);
  });

  it('throws UNAUTHORIZED when Keycloak returns 404 (user not found)', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'admin-token' }))
      .mockResolvedValueOnce(emptyResponse(404));

    await expect(isEmailVerified('nonexistent-user')).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });
  });
});
