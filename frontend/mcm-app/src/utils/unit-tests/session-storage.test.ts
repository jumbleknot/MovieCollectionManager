/**
 * Unit tests for session storage (T-038)
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

describe('storeTokens (Android — SecureStore path)', () => {
  it('stores all tokens in SecureStore', async () => {
    mockedSecureStore.setItemAsync.mockResolvedValue(undefined);

    await sessionStorage.storeTokens('access-tok', 'refresh-tok', 'session-id');

    expect(mockedSecureStore.setItemAsync).toHaveBeenCalledWith(
      'mcm_access_token',
      'access-tok',
      expect.any(Object),
    );
    expect(mockedSecureStore.setItemAsync).toHaveBeenCalledWith(
      'mcm_refresh_token',
      'refresh-tok',
      expect.any(Object),
    );
    expect(mockedSecureStore.setItemAsync).toHaveBeenCalledWith(
      'mcm_session_id',
      'session-id',
      expect.any(Object),
    );
  });
});

describe('getAccessToken (Android — SecureStore path)', () => {
  it('retrieves access token from SecureStore', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue('stored-access-token');
    const token = await sessionStorage.getAccessToken();
    expect(token).toBe('stored-access-token');
  });

  it('returns null when not stored', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(null);
    const token = await sessionStorage.getAccessToken();
    expect(token).toBeNull();
  });
});

describe('clearTokens (Android — SecureStore path)', () => {
  it('deletes all stored tokens', async () => {
    mockedSecureStore.deleteItemAsync.mockResolvedValue(undefined);
    await sessionStorage.clearTokens();
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalledWith('mcm_access_token');
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalledWith('mcm_refresh_token');
    expect(mockedSecureStore.deleteItemAsync).toHaveBeenCalledWith('mcm_session_id');
  });
});

describe('hasStoredSession', () => {
  it('returns true when session ID is stored', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue('some-session-id');
    const result = await sessionStorage.hasStoredSession();
    expect(result).toBe(true);
  });

  it('returns false when no session ID stored', async () => {
    mockedSecureStore.getItemAsync.mockResolvedValue(null);
    const result = await sessionStorage.hasStoredSession();
    expect(result).toBe(false);
  });
});
