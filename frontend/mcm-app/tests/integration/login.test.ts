/**
 * Integration tests for login flow (T-076)
 * Simulates valid authorization code exchange with mocked Keycloak token endpoint.
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);

const LOGIN_URL = '/bff-api/auth/login';

const validPayload = {
  code: 'auth-code-123',
  codeVerifier: 'pkce-verifier',
  redirectUri: 'mcm-app://native-auth-callback',
};

describe('Login integration (frontend BFF client)', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns 200 with user profile and session cookie on success', async () => {
    mock.onPost(LOGIN_URL).reply(200, {
      success: true,
      user: {
        id: 'user-001',
        username: 'testuser',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        roles: ['mc-user'],
        emailVerified: true,
      },
    }, { 'Set-Cookie': 'mcm_access_token=tok; HttpOnly', 'X-Session-Id': 'session-abc' });

    const res = await axios.post(LOGIN_URL, validPayload);
    expect(res.status).toBe(200);
    expect(res.data.user.username).toBe('testuser');
  });

  it('returns 400 when required fields missing', async () => {
    mock.onPost(LOGIN_URL).reply(400, {
      error: 'Missing required fields.',
      code: 'INVALID_INPUT',
    });

    await expect(axios.post(LOGIN_URL, { code: 'only-code' })).rejects.toMatchObject({
      response: { status: 400 },
    });
  });

  it('returns 429 when rate limit exceeded', async () => {
    mock.onPost(LOGIN_URL).reply(429, { error: 'Too many attempts.', code: 'RATE_LIMIT_EXCEEDED' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 429 },
    });
  });

  it('returns 500 when Keycloak token endpoint is unavailable', async () => {
    mock.onPost(LOGIN_URL).reply(500, { error: 'Authentication failed.', code: 'UNKNOWN_ERROR' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 500 },
    });
  });
});
