/**
 * Unit tests for BFF /resend-verification route (T-056)
 */

jest.mock('@/bff-server/rate-limiter', () => ({
  checkResendVerificationRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/email-service', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/bff-server/keycloak', () => ({
  getUserIdByEmail: jest.fn().mockResolvedValue('user-123'),
}));

import { POST } from '@/app/bff-api/auth/resend-verification+api';
import { checkResendVerificationRateLimit } from '@/bff-server/rate-limiter';
import { sendVerificationEmail } from '@/bff-server/email-service';
import { getUserIdByEmail } from '@/bff-server/keycloak';
import { AuthError, AuthErrorCode, RateLimitError } from '@/types/errors';

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost:8081/bff-api/auth/resend-verification',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0];
}

describe('POST /bff-api/auth/resend-verification', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 for valid unverified email', async () => {
    const res = await POST(makeRequest({ email: 'test@example.com' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(sendVerificationEmail).toHaveBeenCalledWith('user-123', expect.stringContaining('/login?verified=true'));
  });

  it('returns 200 even when email not found (prevents enumeration)', async () => {
    (getUserIdByEmail as jest.Mock).mockResolvedValueOnce(null);

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

  it('returns 400 with ALREADY_VERIFIED when email is already verified', async () => {
    (getUserIdByEmail as jest.Mock).mockRejectedValueOnce(
      new AuthError(AuthErrorCode.ALREADY_VERIFIED, 'Email already verified', 400),
    );

    const res = await POST(makeRequest({ email: 'test@example.com' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.ALREADY_VERIFIED);
  });

  it('returns 502 with KEYCLOAK_UNAVAILABLE when email service fails (e.g. SMTP not configured, invalid redirect_uri)', async () => {
    (sendVerificationEmail as jest.Mock).mockRejectedValueOnce(
      new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to send verification email', 502),
    );

    const res = await POST(makeRequest({ email: 'test@example.com' }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.code).toBe(AuthErrorCode.KEYCLOAK_UNAVAILABLE);
  });
});
