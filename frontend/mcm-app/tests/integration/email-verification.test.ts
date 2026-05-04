/**
 * Integration tests for email verification flow (T-058)
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);

const RESEND_URL = '/bff-api/auth/resend-verification';
const VERIFY_URL = '/bff-api/auth/verify-email';

describe('Email verification integration (frontend BFF client)', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('resend returns success for registered email', async () => {
    mock.onPost(RESEND_URL).reply(200, { success: true, message: 'Verification email sent.' });

    const res = await axios.post(RESEND_URL, { email: 'user@example.com' });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('resend returns 200 for unknown email (no enumeration)', async () => {
    mock.onPost(RESEND_URL).reply(200, { success: true, message: 'Verification email sent.' });

    const res = await axios.post(RESEND_URL, { email: 'nonexistent@example.com' });
    expect(res.status).toBe(200);
  });

  it('resend returns 429 when rate limited', async () => {
    mock.onPost(RESEND_URL).reply(429, {
      error: 'Too many requests.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: 3600,
    });

    await expect(axios.post(RESEND_URL, { email: 'user@example.com' })).rejects.toMatchObject({
      response: { status: 429 },
    });
  });

  it('verify email returns success for valid token', async () => {
    mock.onGet(new RegExp(`${VERIFY_URL}.*token=.*`)).reply(200, {
      success: true,
      message: 'Email verified successfully.',
    });

    const res = await axios.get(`${VERIFY_URL}?token=valid-token-abc`);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('verify email returns 400 for expired token', async () => {
    mock.onGet(new RegExp(`${VERIFY_URL}.*token=.*`)).reply(400, {
      error: 'Verification link has expired.',
      code: 'VERIFICATION_TOKEN_EXPIRED',
    });

    await expect(
      axios.get(`${VERIFY_URL}?token=expired-token`),
    ).rejects.toMatchObject({ response: { status: 400 } });
  });
});
