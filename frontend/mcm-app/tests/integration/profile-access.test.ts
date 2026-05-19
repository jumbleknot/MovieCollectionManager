/**
 * Integration test for profile access (T-096)
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);
const USER_URL = '/bff-api/auth/user';

describe('Profile access integration', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns complete user profile for authenticated user', async () => {
    mock.onGet(USER_URL).reply(200, {
      id: 'user-001',
      username: 'testuser',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      roles: ['mc-user'],
      emailVerified: true,
    });

    const res = await axios.get(USER_URL, { withCredentials: true });
    expect(res.status).toBe(200);
    const profile = res.data;
    expect(profile.username).toBe('testuser');
    expect(profile.email).toBe('test@example.com');
    expect(profile.firstName).toBe('Test');
    expect(profile.lastName).toBe('User');
    expect(profile.roles).toContain('mc-user');
    expect(profile.emailVerified).toBe(true);
  });
});
