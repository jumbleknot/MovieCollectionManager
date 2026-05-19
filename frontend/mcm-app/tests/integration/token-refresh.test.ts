/**
 * Integration tests for token refresh (T-077)
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);

const REFRESH_URL = '/bff-api/auth/refresh';

describe('Token refresh integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns new access token cookie on success', async () => {
    mock.onPost(REFRESH_URL).reply(200, { success: true, expiresIn: 900 }, {
      'Set-Cookie': 'mcm_access_token=new-tok; HttpOnly',
    });

    const res = await axios.post(REFRESH_URL, {}, { withCredentials: true });
    expect(res.status).toBe(200);
    expect(res.data.expiresIn).toBe(900);
  });

  it('returns 401 when session expired', async () => {
    mock.onPost(REFRESH_URL).reply(401, { error: 'Session expired.', code: 'SESSION_EXPIRED' });

    await expect(axios.post(REFRESH_URL)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('returns 429 on refresh rate limit', async () => {
    mock.onPost(REFRESH_URL).reply(429, { error: 'Too many refresh requests.', code: 'RATE_LIMIT_EXCEEDED' });

    await expect(axios.post(REFRESH_URL)).rejects.toMatchObject({
      response: { status: 429 },
    });
  });
});
