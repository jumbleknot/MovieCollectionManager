/**
 * Unit tests for token service (T-035)
 * Tests JWT utilities that don't require network calls.
 */

import { generateKeyPairSync, createSign } from 'crypto';
import {
  isTokenExpired,
  isTokenExpiringSoon,
  extractRoles,
  validateJwt,
  validateAtHash,
  __clearJwksCache,
} from '@/bff-server/token-service';
import { AuthErrorCode } from '@/types/errors';
import type { JWTPayload } from '@/types/auth';

// ─── validateJwt test infrastructure ─────────────────────────────────────────

// Generate a test RSA-2048 key pair once for all validateJwt tests.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
const TEST_KID = 'test-kid-1';

function buildJwks() {
  return {
    keys: [{ kid: TEST_KID, kty: 'RSA', alg: 'RS256', use: 'sig', n: publicJwk.n, e: publicJwk.e }],
  };
}

function signJwt(payload: object): string {
  const header = { alg: 'RS256', kid: TEST_KID, typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${signer.sign(privateKey, 'base64url')}`;
}

function validPayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    iss: 'http://localhost:8099/realms/jumbleknot',
    aud: ['account'],
    azp: 'movie-collection-manager',
    exp: now + 900,
    iat: now,
    jti: 'jti-1',
    auth_time: now,
    scope: 'openid profile email',
    preferred_username: 'testuser',
    email: 'test@example.com',
    email_verified: true,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    resource_access: { 'movie-collection-manager': { roles: ['mc-user'] } },
    ...overrides,
  };
}

function jwksResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(buildJwks()),
  } as unknown as Response;
}

global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  jest.clearAllMocks();
  __clearJwksCache();
  mockedFetch.mockResolvedValue(jwksResponse());
});

// ─── validateJwt ──────────────────────────────────────────────────────────────

describe('validateJwt', () => {
  it('accepts a valid token where client ID is in azp (real Keycloak format)', async () => {
    const token = signJwt(validPayload());
    const { payload } = await validateJwt(token);
    expect(payload.sub).toBe('user-123');
  });

  it('accepts a valid token where client ID is in aud array', async () => {
    const token = signJwt(validPayload({ aud: ['movie-collection-manager'], azp: undefined }));
    const { payload } = await validateJwt(token);
    expect(payload.sub).toBe('user-123');
  });

  it('rejects token when client ID is in neither aud nor azp', async () => {
    const token = signJwt(validPayload({ aud: ['account'], azp: 'other-client' }));
    await expect(validateJwt(token)).rejects.toMatchObject({ code: AuthErrorCode.UNAUTHORIZED });
  });

  it('rejects token with wrong issuer', async () => {
    const token = signJwt(validPayload({ iss: 'http://evil.example.com/realms/bad' }));
    await expect(validateJwt(token)).rejects.toMatchObject({ code: AuthErrorCode.UNAUTHORIZED });
  });

  it('rejects expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(validPayload({ exp: now - 10 }));
    await expect(validateJwt(token)).rejects.toMatchObject({ code: AuthErrorCode.TOKEN_EXPIRED });
  });

  it('rejects token with tampered payload (invalid signature)', async () => {
    const token = signJwt(validPayload());
    const [h, , s] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
    await expect(validateJwt(`${h}.${tamperedPayload}.${s}`)).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });
  });

  it('rejects malformed token (not 3 parts)', async () => {
    await expect(validateJwt('not.a.valid.jwt.token')).rejects.toMatchObject({
      code: AuthErrorCode.UNAUTHORIZED,
    });
  });

  it('throws KEYCLOAK_UNAVAILABLE when JWKS fetch fails with a network error', async () => {
    mockedFetch.mockRejectedValue(new TypeError('fetch failed'));
    const token = signJwt(validPayload());
    await expect(validateJwt(token)).rejects.toMatchObject({
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
    });
  });

  it('throws KEYCLOAK_UNAVAILABLE when JWKS endpoint returns a non-200 status', async () => {
    mockedFetch.mockResolvedValue(jwksResponse(503));
    const token = signJwt(validPayload());
    await expect(validateJwt(token)).rejects.toMatchObject({
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
    });
  });
});

// ─── validateAtHash ───────────────────────────────────────────────────────────

describe('validateAtHash', () => {
  it('returns true when at_hash is absent (optional per OIDC spec)', () => {
    const payload = validPayload({ at_hash: undefined });
    expect(validateAtHash(payload, 'any-access-token')).toBe(true);
  });

  it('returns true when at_hash matches the access token hash', () => {
    const { createHash } = require('crypto') as typeof import('crypto');
    const accessToken = 'some.access.token';
    const hash = createHash('sha256').update(Buffer.from(accessToken)).digest();
    const expectedAtHash = hash.subarray(0, 16).toString('base64url');
    const payload = validPayload({ at_hash: expectedAtHash });
    expect(validateAtHash(payload, accessToken)).toBe(true);
  });

  it('returns false when at_hash does not match the access token', () => {
    const payload = validPayload({ at_hash: 'wrong-hash' });
    expect(validateAtHash(payload, 'some.access.token')).toBe(false);
  });
});

function makePayload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    sub: 'user-123',
    iss: 'http://localhost:8099/realms/jumbleknot',
    aud: ['account'],
    azp: 'movie-collection-manager',
    exp: nowSeconds + 900, // 15 min from now
    iat: nowSeconds,
    jti: 'jwt-id-123',
    auth_time: nowSeconds,
    scope: 'openid profile email',
    preferred_username: 'testuser',
    email: 'test@example.com',
    email_verified: true,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    ...overrides,
  };
}

describe('isTokenExpired', () => {
  it('returns false for unexpired token', () => {
    const payload = makePayload();
    expect(isTokenExpired(payload)).toBe(false);
  });

  it('returns true for expired token', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds - 1 });
    expect(isTokenExpired(payload)).toBe(true);
  });
});

describe('isTokenExpiringSoon', () => {
  it('returns false when token expires well in the future', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds + 500 });
    expect(isTokenExpiringSoon(payload, 60)).toBe(false);
  });

  it('returns true when token is within threshold', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds + 30 });
    expect(isTokenExpiringSoon(payload, 60)).toBe(true);
  });

  it('returns true for already-expired token', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = makePayload({ exp: nowSeconds - 1 });
    expect(isTokenExpiringSoon(payload, 60)).toBe(true);
  });
});

describe('extractRoles', () => {
  it('extracts client roles from resource_access', () => {
    const payload = makePayload({
      resource_access: {
        'movie-collection-manager': { roles: ['mc-user'] },
      },
    });
    expect(extractRoles(payload, 'movie-collection-manager')).toEqual(['mc-user']);
  });

  it('returns empty array when no resource_access', () => {
    const payload = makePayload();
    expect(extractRoles(payload, 'movie-collection-manager')).toEqual([]);
  });

  it('returns empty array when client not in resource_access', () => {
    const payload = makePayload({
      resource_access: {
        'other-client': { roles: ['some-role'] },
      } as JWTPayload['resource_access'],
    });
    expect(extractRoles(payload, 'movie-collection-manager')).toEqual([]);
  });
});
