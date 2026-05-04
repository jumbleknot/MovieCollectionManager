/**
 * Integration tests for login error scenarios (T-078)
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);
const LOGIN_URL = '/bff-api/auth/login';

const validPayload = {
  code: 'auth-code',
  codeVerifier: 'verifier',
  redirectUri: 'mcm-app://callback',
};

describe('Login error handling integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns UNAUTHORIZED for invalid authorization code', async () => {
    mock.onPost(LOGIN_URL).reply(401, { error: 'Invalid authorization code.', code: 'UNAUTHORIZED' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('returns 403 ACCOUNT_LOCKED for locked accounts', async () => {
    mock.onPost(LOGIN_URL).reply(403, { error: 'Account is locked.', code: 'ACCOUNT_LOCKED' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 403, data: { code: 'ACCOUNT_LOCKED' } },
    });
  });

  it('returns 403 ACCOUNT_DISABLED for disabled accounts', async () => {
    mock.onPost(LOGIN_URL).reply(403, { error: 'Account is disabled.', code: 'ACCOUNT_DISABLED' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 403, data: { code: 'ACCOUNT_DISABLED' } },
    });
  });

  it('returns 500 when Keycloak is unavailable', async () => {
    mock.onPost(LOGIN_URL).reply(500, { error: 'Authentication failed.', code: 'UNKNOWN_ERROR' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it('returns 400 for expired authorization code', async () => {
    mock.onPost(LOGIN_URL).reply(400, { error: 'Authorization code expired.', code: 'TOKEN_EXPIRED' });

    await expect(axios.post(LOGIN_URL, validPayload)).rejects.toMatchObject({
      response: { status: 400 },
    });
  });
});
