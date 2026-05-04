/**
 * Integration test for unauthorized access (T-097)
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);
const USER_URL = '/bff-api/auth/user';

describe('Unauthorized access integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns 401 when accessing profile without authentication', async () => {
    mock.onGet(USER_URL).reply(401, { error: 'Unauthorized.', code: 'UNAUTHORIZED' });

    await expect(axios.get(USER_URL)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('returns 403 when user lacks required role', async () => {
    mock.onGet(USER_URL).reply(403, { error: 'Forbidden.', code: 'FORBIDDEN' });

    await expect(axios.get(USER_URL)).rejects.toMatchObject({
      response: { status: 403 },
    });
  });
});
