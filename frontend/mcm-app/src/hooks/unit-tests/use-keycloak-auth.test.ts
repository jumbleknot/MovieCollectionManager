/**
 * Unit tests for use-keycloak-auth hook (T-070)
 */

import { renderHook, act } from '@testing-library/react-native';
import * as AuthSession from 'expo-auth-session';
import { useKeycloakAuth } from '@/hooks/use-keycloak-auth';

jest.mock('expo-auth-session', () => ({
  useAutoDiscovery: jest.fn().mockReturnValue({ authorizationEndpoint: 'http://kc/auth' }),
  useAuthRequest: jest.fn(),
  CodeChallengeMethod: { S256: 'S256' },
  ResponseType: { Code: 'code' },
}));

const mockedUseAuthRequest = AuthSession.useAuthRequest as jest.Mock;

function makeRequest(codeVerifier = 'test-verifier') {
  return { codeVerifier };
}

describe('useKeycloakAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls onCode with code and codeVerifier on success', async () => {
    const onCode = jest.fn().mockResolvedValue(undefined);
    const promptAsync = jest.fn();

    mockedUseAuthRequest.mockReturnValueOnce([
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

    mockedUseAuthRequest.mockReturnValueOnce([
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

    mockedUseAuthRequest.mockReturnValueOnce([
      makeRequest(),
      { type: 'error', error: { message: 'access_denied' } },
      jest.fn(),
    ]);

    renderHook(() => useKeycloakAuth({ onCode, onError }));
    await act(async () => {});

    expect(onError).toHaveBeenCalledWith('access_denied');
  });

  it('calls onError when code is missing from success response', async () => {
    const onCode = jest.fn();
    const onError = jest.fn();

    mockedUseAuthRequest.mockReturnValueOnce([
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
