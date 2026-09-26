/**
 * The platform branch (feature 076 — FR-005, research R10).
 *
 * The two paths differ in mechanism and must not differ in guarantee. What is asserted here is
 * the part that is easy to get wrong when adding native as an afterthought:
 *
 *   `max_age=0` and `prompt=login` are sent on BOTH. T001 measured that max_age=0 re-prompts
 *   even when the SSO session is live and would otherwise be reused, so a native path that
 *   dropped it would silently reuse the session — the re-authentication would look present and
 *   buy nothing.
 *
 *   The native path uses the state the BFF PARKED, not one expo-auth-session invents, or the
 *   callback could never be matched to the request that started it.
 *
 *   Neither path asks for `offline_access`.
 */

const mockPost = jest.fn();
jest.mock('@/utils/api-client', () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a) },
}));

let mockPlatformOS = 'web';
jest.mock('react-native', () => ({
  get Platform() {
    return { OS: mockPlatformOS };
  },
}));

const mockPromptAsync = jest.fn();
const mockAuthRequestCtor = jest.fn();
jest.mock('expo-auth-session', () => ({
  AuthRequest: class {
    codeVerifier = 'device-verifier';
    constructor(config: unknown) {
      mockAuthRequestCtor(config);
    }
    promptAsync(...a: unknown[]) {
      return mockPromptAsync(...a);
    }
  },
  ResponseType: { Code: 'code' },
  CodeChallengeMethod: { S256: 'S256' },
  Prompt: { Login: 'login' },
}));

jest.mock('@/config/keycloak', () => ({
  keycloakConfig: { clientId: 'movie-collection-manager', issuer: 'http://kc/realms/r' },
}));

import { renderHook, act } from '@testing-library/react-native';
import { useAccountDeletion } from '@/hooks/use-account-deletion';

const mockAssign = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatformOS = 'web';
  Object.defineProperty(window, 'location', {
    value: { assign: mockAssign, origin: 'http://localhost:8082' },
    writable: true,
  });
});

describe('web', () => {
  it('asks the BFF for the URL and navigates the browser to it', async () => {
    mockPost.mockResolvedValue({ data: { authorizationUrl: 'http://kc/auth?max_age=0' } });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    expect(mockPost).toHaveBeenCalledWith('/bff-api/account/delete-challenge', {});
    expect(mockAssign).toHaveBeenCalledWith('http://kc/auth?max_age=0');
  });

  it('never constructs a device auth request', async () => {
    mockPost.mockResolvedValue({ data: { authorizationUrl: 'http://kc/auth' } });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    // The verifier stays server-side on web. A device request here would move it to the client
    // for no reason and weaken the stronger of the two paths.
    expect(mockAuthRequestCtor).not.toHaveBeenCalled();
  });
});

describe('native', () => {
  const challenge = {
    data: {
      state: 'parked-state',
      authorizationParams: { scope: 'openid', prompt: 'login', max_age: '0' },
    },
  };

  beforeEach(() => {
    mockPlatformOS = 'android';
  });

  it('tells the BFF it is native, so the parked record is marked accordingly', async () => {
    mockPost.mockResolvedValueOnce(challenge);
    mockPromptAsync.mockResolvedValue({ type: 'cancel', params: {} });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    expect(mockPost).toHaveBeenNthCalledWith(1, '/bff-api/account/delete-challenge', {
      platform: 'native',
    });
  });

  it('forces a fresh authentication with prompt=login and max_age=0', async () => {
    mockPost.mockResolvedValueOnce(challenge);
    mockPromptAsync.mockResolvedValue({ type: 'cancel', params: {} });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    const config = mockAuthRequestCtor.mock.calls[0][0];
    expect(config.prompt).toBe('login');
    expect(config.extraParams).toMatchObject({ max_age: '0' });
    expect(config.codeChallengeMethod).toBe('S256');
  });

  it('uses the state the BFF parked, not one of its own', async () => {
    mockPost.mockResolvedValueOnce(challenge);
    mockPromptAsync.mockResolvedValue({ type: 'cancel', params: {} });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    expect(mockAuthRequestCtor.mock.calls[0][0].state).toBe('parked-state');
  });

  it('asks for openid only — never an offline token', async () => {
    mockPost.mockResolvedValueOnce(challenge);
    mockPromptAsync.mockResolvedValue({ type: 'cancel', params: {} });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    expect(mockAuthRequestCtor.mock.calls[0][0].scopes).toEqual(['openid']);
  });

  it('posts the code and the DEVICE verifier back, and reports the deletion', async () => {
    mockPost
      .mockResolvedValueOnce(challenge)
      .mockResolvedValueOnce({ data: { deleted: true } });
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'the-code' } });

    const { result } = renderHook(() => useAccountDeletion());
    let outcome;
    await act(async () => {
      outcome = await result.current.start();
    });

    expect(mockPost).toHaveBeenNthCalledWith(2, '/bff-api/account/delete', {
      code: 'the-code',
      state: 'parked-state',
      codeVerifier: 'device-verifier',
      redirectUri: 'mcm-app://account-delete-callback',
    });
    expect(outcome).toEqual({ deleted: true });
  });

  it('deletes nothing when the user cancels at the identity provider', async () => {
    mockPost.mockResolvedValueOnce(challenge);
    mockPromptAsync.mockResolvedValue({ type: 'cancel', params: {} });

    const { result } = renderHook(() => useAccountDeletion());
    let outcome;
    await act(async () => {
      outcome = await result.current.start();
    });

    // Only the challenge was posted — the completion endpoint is never reached.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ deleted: false });
  });

  it('uses a deletion-specific redirect, not the login callback', async () => {
    mockPost.mockResolvedValueOnce(challenge);
    mockPromptAsync.mockResolvedValue({ type: 'cancel', params: {} });

    const { result } = renderHook(() => useAccountDeletion());
    await act(async () => {
      await result.current.start();
    });

    // Sharing `mcm-app://native-auth-callback` would route the deletion code into the login
    // callback screen, which exchanges it for a SESSION — turning a deletion into a sign-in.
    const uri = mockAuthRequestCtor.mock.calls[0][0].redirectUri;
    expect(uri).toBe('mcm-app://account-delete-callback');
    expect(uri).not.toBe('mcm-app://native-auth-callback');
  });
});
