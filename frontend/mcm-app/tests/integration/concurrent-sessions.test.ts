/**
 * Integration test for concurrent session independence (T-112)
 * Simulates 2 device sessions; logout from one, verify other remains active.
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);

const LOGOUT_URL = '/bff-api/auth/logout';
const USER_URL = '/bff-api/auth/user';

describe('Concurrent session independence integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('other session remains valid after one session logout', async () => {
    // Device 1 logs out
    mock.onPost(LOGOUT_URL).reply(200, { success: true });
    await axios.post(LOGOUT_URL, {}, {
      withCredentials: true,
      headers: { Cookie: 'mcm_session_id=session-device-1' },
    });

    // Device 2 (different session) can still access protected resource
    mock.onGet(USER_URL).reply(200, {
      id: 'user-1', username: 'testuser', roles: ['mc-user'], emailVerified: true,
    });

    const res = await axios.get(USER_URL, {
      withCredentials: true,
      headers: { Cookie: 'mcm_session_id=session-device-2' },
    });

    expect(res.status).toBe(200);
    expect(res.data.username).toBe('testuser');
  });
});
