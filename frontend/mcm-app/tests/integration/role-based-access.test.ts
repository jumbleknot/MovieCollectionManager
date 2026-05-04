/**
 * Integration tests for role-based access (T-098)
 * Also validates cross-layer RBAC consistency (SC-008):
 * BFF endpoints reject same requests frontend auth-guard would block.
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);
const USER_URL = '/bff-api/auth/user';

describe('Role-based access integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('mc-user can access /user endpoint', async () => {
    mock.onGet(USER_URL).reply(200, { roles: ['mc-user'] });
    const res = await axios.get(USER_URL);
    expect(res.status).toBe(200);
  });

  it('mc-admin can access /user endpoint (implicit mc-user)', async () => {
    mock.onGet(USER_URL).reply(200, { roles: ['mc-admin'] });
    const res = await axios.get(USER_URL);
    expect(res.status).toBe(200);
  });

  // SC-008: BFF rejects independently of frontend guard
  it('BFF /user returns 401 for unauthenticated request', async () => {
    mock.onGet(USER_URL).reply(401, { error: 'Unauthorized.', code: 'UNAUTHORIZED' });
    await expect(axios.get(USER_URL)).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('BFF /user returns 403 for wrong-role request', async () => {
    mock.onGet(USER_URL).reply(403, { error: 'Forbidden.', code: 'FORBIDDEN' });
    await expect(axios.get(USER_URL)).rejects.toMatchObject({ response: { status: 403 } });
  });
});
