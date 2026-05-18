/**
 * Unit tests for use-keycloak-auth hook (T-070)
 */

import { renderHook, act } from '@testing-library/react-native';
import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import { useKeycloakAuth } from '@/hooks/use-keycloak-auth';

jest.mock('expo-auth-session', () => ({
  useAuthRequest: jest.fn(),
  makeRedirectUri: jest.fn(() => 'http://localhost:8081/auth-callback'),
  CodeChallengeMethod: { S256: 'S256' },
  ResponseType: { Code: 'code' },
}));

const mockedUseAuthRequest = AuthSession.useAuthRequest as jest.Mock;

function makeRequest(codeVerifier = 'test-verifier') {
  return { codeVerifier };
}

describe('useKeycloakAuth', () => {
  let savedOS: typeof Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    savedOS = Platform.OS;
  });

  afterEach(() => {
    (Platform as { OS: typeof Platform.OS }).OS = savedOS;
  });

  // Success and error paths in the hook only run on web (Platform.OS === 'web').
  // On native, the deep-link callback screen owns the code exchange.
  it('calls onCode with code and codeVerifier on success', async () => {
    (Platform as { OS: typeof Platform.OS }).OS = 'web';
    const onCode = jest.fn().mockResolvedValue(undefined);
    const promptAsync = jest.fn();

    mockedUseAuthRequest.mockReturnValue([
      makeRequest(),
      { type: 'success', params: { code: 'auth-code-123' } },
      promptAsync,
    ]);

    renderHook(() => useKeycloakAuth({ onCode }));

    // Allow useEffect to run
    await act(async () => {});

    expect(onCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth-code-123', codeVerifier: 'test-verifier' }),
    );
  });

  it('calls onCancel when response type is cancel', async () => {
    const onCode = jest.fn();
    const onCancel = jest.fn();

    mockedUseAuthRequest.mockReturnValue([
      makeRequest(),
      { type: 'cancel' },
      jest.fn(),
    ]);

    renderHook(() => useKeycloakAuth({ onCode, onCancel }));
    await act(async () => {});

    expect(onCancel).toHaveBeenCalled();
    expect(onCode).not.toHaveBeenCalled();
  });

  it('calls onError when response has error', async () => {
    const onCode = jest.fn();
    const onError = jest.fn();

    mockedUseAuthRequest.mockReturnValue([
      makeRequest(),
      { type: 'error', error: { message: 'access_denied' } },
      jest.fn(),
    ]);

    renderHook(() => useKeycloakAuth({ onCode, onError }));
    await act(async () => {});

    expect(onError).toHaveBeenCalledWith('access_denied');
  });

  it('calls onError when code is missing from success response', async () => {
    (Platform as { OS: typeof Platform.OS }).OS = 'web';
    const onCode = jest.fn();
    const onError = jest.fn();

    mockedUseAuthRequest.mockReturnValue([
      makeRequest(),
      { type: 'success', params: { code: '' } },
      jest.fn(),
    ]);

    renderHook(() => useKeycloakAuth({ onCode, onError }));
    await act(async () => {});

    expect(onError).toHaveBeenCalled();
    expect(onCode).not.toHaveBeenCalled();
  });

  it('isLoading is false when request and discovery are ready', () => {
    mockedUseAuthRequest.mockReturnValueOnce([makeRequest(), null, jest.fn()]);

    const { result } = renderHook(() =>
      useKeycloakAuth({ onCode: jest.fn() }),
    );

    expect(result.current.isLoading).toBe(false);
  });
});
