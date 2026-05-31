/**
 * token-service integration tests (T005) — US1.
 *
 * Validates the BFF token-validation module against a REAL Keycloak instance and
 * its live JWKS endpoint — no mocking (constitution v1.3.0). Tokens are acquired
 * via the ROPC direct grant on the test-only `mcm-bff-test` client.
 *
 * NOTE: The PKCE code exchange step (keycloak.exchangeCode) is out of scope for
 * integration tests. It is covered by the Playwright global setup in feature 003.
 * These tests begin after token acquisition: real signature + claims validation.
 *
 * Actual token-service exports: validateJwt (NOT validateToken), extractRoles,
 * isTokenExpired, isTokenExpiringSoon, validateAtHash.
 */
import {
  getTestTokens,
  createTestUser,
  deleteTestUser,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { validateJwt, extractRoles } from '@/bff-server/token-service';
import { AuthError, AuthErrorCode } from '@/types/errors';

const APP_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'movie-collection-manager';

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
}

describe('token-service — integration (real Keycloak JWKS)', () => {
  let roleUser: TestUser;
  let noRoleUser: TestUser;
  let accessToken: string;
  let noRoleAccessToken: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();

    roleUser = await createTestUser('int-token');
    await assignRole(roleUser.userId, 'mc-user');
    ({ accessToken } = await getTestTokens(roleUser.username, roleUser.password));

    noRoleUser = await createTestUser('int-token-norole');
    ({ accessToken: noRoleAccessToken } = await getTestTokens(
      noRoleUser.username,
      noRoleUser.password,
    ));
  });

  afterAll(async () => {
    await deleteTestUser(roleUser?.userId);
    await deleteTestUser(noRoleUser?.userId);
  });

  it('validates a real Keycloak JWT and extracts standard claims (US1-AC1)', async () => {
    const { payload, header } = await validateJwt(accessToken);
    expect(header.alg).toBe('RS256');
    expect(typeof payload.sub).toBe('string');
    expect(payload.iss).toContain('/realms/');
    // aud includes the app client (via the audience mapper on the test client)
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    expect(aud.includes(APP_CLIENT_ID) || payload.azp === APP_CLIENT_ID).toBe(true);
    // the assigned mc-user role is present
    expect(extractRoles(payload, APP_CLIENT_ID)).toContain('mc-user');
  });

  it('rejects an expired JWT with TOKEN_EXPIRED (US1-AC2)', async () => {
    // Forge an expired token: keep header/signature, set exp in the past. The
    // expiry check runs before signature verification, so this exercises the
    // typed expired-token path against real claim parsing.
    const [h, p, s] = accessToken.split('.');
    const payload = decodePayload(accessToken);
    payload.exp = Math.floor(Date.now() / 1000) - 100;
    const expired = `${h}.${b64urlJson(payload)}.${s}`;

    await expect(validateJwt(expired)).rejects.toMatchObject({
      code: AuthErrorCode.TOKEN_EXPIRED,
    });
  });

  it('rejects a tampered JWT (bad signature) (US1-AC3)', async () => {
    // Flip the last char of the signature so issuer/aud/exp still pass but the
    // RSA signature verification against the real JWKS fails.
    const [h, p, s] = accessToken.split('.');
    const flipped = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    const tampered = `${h}.${p}.${flipped}`;

    // token-service throws AuthErrorCode.UNAUTHORIZED ("Invalid token signature")
    // for a bad signature (there is no separate INVALID_TOKEN code in this codebase).
    await expect(validateJwt(tampered)).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });
  });

  it('returns empty mc-user roles for a user without the role (US1-AC4)', async () => {
    const { payload } = await validateJwt(noRoleAccessToken);
    expect(extractRoles(payload, APP_CLIENT_ID)).not.toContain('mc-user');
  });

  it('throws a typed AuthError (not a generic Error) on malformed input', async () => {
    await expect(validateJwt('not.a.jwt')).rejects.toBeInstanceOf(AuthError);
  });
});
