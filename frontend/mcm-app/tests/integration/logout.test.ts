/**
 * Integration test for logout flow (T-111)
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);
const LOGOUT_URL = '/bff-api/auth/logout';
const USER_URL = '/bff-api/auth/user';

describe('Logout flow integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns 200 on successful logout', async () => {
    mock.onPost(LOGOUT_URL).reply(200, { success: true, message: 'Logged out successfully.' });

    const res = await axios.post(LOGOUT_URL, {}, { withCredentials: true });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('cannot access protected resources after logout (401)', async () => {
    mock.onPost(LOGOUT_URL).reply(200, { success: true });
    mock.onGet(USER_URL).reply(401, { error: 'Unauthorized.', code: 'UNAUTHORIZED' });

    await axios.post(LOGOUT_URL, {}, { withCredentials: true });

    await expect(axios.get(USER_URL)).rejects.toMatchObject({ response: { status: 401 } });
  });
});
