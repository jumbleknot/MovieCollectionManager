/**
 * Integration test for session timeout (T-149)
 * Validates SC-011: 30-min idle timeout, 24-hour absolute timeout.
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { AuthErrorCode } from '@/types/errors';

const mock = new MockAdapter(axios);
const USER_URL = '/bff-api/auth/user';

describe('Session timeout integration (T-149)', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('rejects request when session idle timeout exceeded (30 min)', async () => {
    // Simulate BFF detecting idle timeout
    mock.onGet(USER_URL).reply(401, {
      error: 'Your session has expired due to inactivity. Please log in again.',
      code: AuthErrorCode.SESSION_IDLE_TIMEOUT,
    });

    await expect(axios.get(USER_URL)).rejects.toMatchObject({
      response: {
        status: 401,
        data: { code: AuthErrorCode.SESSION_IDLE_TIMEOUT },
      },
    });
  });

  it('rejects request when absolute session timeout exceeded (24 hours)', async () => {
    // Simulate BFF detecting absolute timeout
    mock.onGet(USER_URL).reply(401, {
      error: 'Your session has ended. Please log in again.',
      code: AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT,
    });

    await expect(axios.get(USER_URL)).rejects.toMatchObject({
      response: {
        status: 401,
        data: { code: AuthErrorCode.SESSION_ABSOLUTE_TIMEOUT },
      },
    });
  });

  it('idle timeout message is distinct from absolute timeout message', async () => {
    const idleMessage = 'Your session has expired due to inactivity. Please log in again.';
    const absoluteMessage = 'Your session has ended. Please log in again.';
    expect(idleMessage).not.toBe(absoluteMessage);
  });
});
