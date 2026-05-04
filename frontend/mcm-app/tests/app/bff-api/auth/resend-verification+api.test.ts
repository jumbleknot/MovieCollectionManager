/**
 * Unit tests for BFF /resend-verification route (T-056)
 */

global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

jest.mock('@/bff-server/rate-limiter', () => ({
  checkResendVerificationRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/email-service', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/bff-api/auth/resend-verification+api';
import { checkResendVerificationRateLimit } from '@/bff-server/rate-limiter';
import { sendVerificationEmail } from '@/bff-server/email-service';
import { AuthErrorCode, RateLimitError } from '@/types/errors';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost:8081/bff-api/auth/resend-verification',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0];
}

function mockAdminToken() {
  mockedFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ access_token: 'admin-tok' }),
  } as unknown as Response);
}

function mockUserFound(emailVerified: boolean) {
  mockAdminToken();
  mockedFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve([
        { id: 'user-123', email: 'test@example.com', emailVerified },
      ]),
  } as unknown as Response);
}

describe('POST /bff-api/auth/resend-verification', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 for valid unverified email', async () => {
    mockUserFound(false);

    const res = await POST(makeRequest({ email: 'test@example.com' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(sendVerificationEmail).toHaveBeenCalledWith('user-123');
  });

  it('returns 200 even when email not found (prevents enumeration)', async () => {
    mockAdminToken();
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as unknown as Response);

    const res = await POST(makeRequest({ email: 'notfound@example.com' }));
    expect(res.status).toBe(200);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid email', async () => {
    const res = await POST(makeRequest({ email: 'not-valid' }));
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate limit exceeded', async () => {
    (checkResendVerificationRateLimit as jest.Mock).mockRejectedValueOnce(
      new RateLimitError(3600),
    );

    const res = await POST(makeRequest({ email: 'test@example.com' }));
    expect(res.status).toBe(429);
  });
});
