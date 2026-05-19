/**
 * Unit tests for BFF /verify-email route (T-055)
 */

global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

import { GET } from '@/app/bff-api/auth/verify-email+api';
import { AuthErrorCode } from '@/types/errors';

function makeRequest(token: string | null): Parameters<typeof GET>[0] {
  const url = token
    ? `http://localhost:8081/bff-api/auth/verify-email?token=${encodeURIComponent(token)}`
    : `http://localhost:8081/bff-api/auth/verify-email`;

  return {
    url,
    headers: new Headers(),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof GET>[0];
}

function jsonRes(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    headers: new Headers({ Location: '/verified' }),
  } as unknown as Response;
}

describe('GET /bff-api/auth/verify-email', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when token is missing', async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.VERIFICATION_TOKEN_INVALID);
  });

  it('returns 200 when Keycloak confirms verification (302 redirect)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(302));

    const res = await GET(makeRequest('valid-token-abc'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('returns 400 with VERIFICATION_TOKEN_EXPIRED when token expired (410)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(410));

    const res = await GET(makeRequest('expired-token'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.VERIFICATION_TOKEN_EXPIRED);
  });

  it('returns 400 for invalid token (400 from Keycloak)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonRes(400));

    const res = await GET(makeRequest('bad-token'));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.VERIFICATION_TOKEN_EXPIRED);
  });
});
