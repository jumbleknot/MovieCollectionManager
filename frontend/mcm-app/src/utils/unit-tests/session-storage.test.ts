/**
 * Unit tests for session storage (T-038; BFF cookie model — session id only).
 */

import * as SecureStore from 'expo-secure-store';
import * as sessionStorage from '@/utils/session-storage';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  ALWAYS: 'always',
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, // Default to non-web (SecureStore path)
}));

const mockedSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('storeSession (Android — SecureStore path)', () => {
  it('stores ONLY the opaque session id (no raw tokens)', async () => {
    mockedSecureStore.setItemAsync.mockResolvedValue(undefined);

    await sessionStorage.storeSession('session-id');

    expect(mockedSecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(mockedSecureStore.setItemAsync).toHaveBeenCalledWith(
      'mcm_session_id',
      'session-id',
      expect.any(Object),
    );
    // No access/refresh token is ever persisted under the cookie model.
    expect(mockedSecureStore.setItemAsync).not.toHaveBeenCalledWith(
      'mcm_access_token',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('clearSession (Android — SecureStore path)', () => {
  it('deletes the stored session id', async () => {
    mockedSecureStore.deleteItemAsync.mockResolvedValue(undefined);
    await sessionStorage.clearSession();
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalledWith('mcm_session_id');
  });
});

describe('hasStoredSession', () => {
  it('returns true when a session id is stored', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue('some-session-id');
    expect(await sessionStorage.hasStoredSession()).toBe(true);
  });

  it('returns false when no session id is stored', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(null);
    expect(await sessionStorage.hasStoredSession()).toBe(false);
  });
});
