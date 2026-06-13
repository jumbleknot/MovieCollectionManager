import axios, { type InternalAxiosRequestConfig, type AxiosError } from 'axios';
import { silentRefresh, isRefreshInProgress, waitForRefresh } from '@/utils/token-refresh';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('axios', () => {
  const instance = Object.assign(jest.fn(), {
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    defaults: { headers: { common: {} } },
  });
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), {
      create: jest.fn().mockReturnValue(instance),
    }),
  };
});

jest.mock('@/utils/token-refresh', () => ({
  silentRefresh: jest.fn(),
  isRefreshInProgress: jest.fn(),
  waitForRefresh: jest.fn(),
}));

jest.mock('@/config/bff-url', () => ({ BFF_BASE_URL: 'http://test.api' }));

// ─── Module under test — imported AFTER mocks so createApiClient() sees them ──

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@/bff-server/api-client');

// ─── Capture interceptors registered during createApiClient() ─────────────────

const mockAxiosInstance = (axios.create as jest.Mock).mock.results[0].value as jest.Mock & {
  interceptors: {
    request: { use: jest.Mock };
    response: { use: jest.Mock };
  };
};

// Callbacks passed to interceptors.response.use (no request interceptor under the cookie model)
const responseSuccessFn = mockAxiosInstance.interceptors.response.use.mock.calls[0][0] as (
  res: unknown,
) => unknown;

const responseErrorFn = mockAxiosInstance.interceptors.response.use.mock.calls[0][1] as (
  error: unknown,
) => Promise<unknown>;

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const mockedSilentRefresh = silentRefresh as jest.MockedFunction<typeof silentRefresh>;
const mockedIsRefreshInProgress = isRefreshInProgress as jest.MockedFunction<typeof isRefreshInProgress>;
const mockedWaitForRefresh = waitForRefresh as jest.MockedFunction<typeof waitForRefresh>;

function makeConfig(url = '/bff-api/user', retryCount?: number): InternalAxiosRequestConfig {
  return {
    url,
    headers: { set: jest.fn() },
    _retryCount: retryCount,
  } as unknown as InternalAxiosRequestConfig;
}

function make401Error(url = '/bff-api/user', retryCount?: number): AxiosError {
  return {
    response: { status: 401 },
    config: makeConfig(url, retryCount),
    isAxiosError: true,
    name: 'AxiosError',
    message: '401',
    toJSON: jest.fn(),
  } as unknown as AxiosError;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('api-client response interceptor', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes successful responses through unchanged', () => {
    const response = { status: 200, data: { user: 'alice' } };

    expect(responseSuccessFn(response)).toBe(response);
  });

  it('passes through non-401 errors without attempting a refresh', async () => {
    const error = {
      response: { status: 500 },
      config: makeConfig(),
      isAxiosError: true,
    } as unknown as AxiosError;

    await expect(responseErrorFn(error)).rejects.toBe(error);
    expect(mockedSilentRefresh).not.toHaveBeenCalled();
  });

  it('retries the request after a successful token refresh on 401', async () => {
    mockedIsRefreshInProgress.mockReturnValue(false);
    mockedSilentRefresh.mockResolvedValueOnce(true);
    const retryResponse = { status: 200, data: 'ok' };
    mockAxiosInstance.mockResolvedValueOnce(retryResponse);

    const result = await responseErrorFn(make401Error());

    expect(mockedSilentRefresh).toHaveBeenCalledTimes(1);
    expect(result).toBe(retryResponse);
  });

  it('rejects on 401 when token refresh fails', async () => {
    mockedIsRefreshInProgress.mockReturnValue(false);
    mockedSilentRefresh.mockResolvedValueOnce(false);
    const error = make401Error();

    await expect(responseErrorFn(error)).rejects.toBe(error);
    expect(mockAxiosInstance).not.toHaveBeenCalled();
  });

  it('does not retry the login endpoint on 401 — auth codes are single-use', async () => {
    const error = make401Error('/bff-api/auth/login');

    await expect(responseErrorFn(error)).rejects.toBe(error);
    expect(mockedSilentRefresh).not.toHaveBeenCalled();
  });

  it('does not retry when the request has already been retried once', async () => {
    const error = make401Error('/bff-api/user', 1);

    await expect(responseErrorFn(error)).rejects.toBe(error);
    expect(mockedSilentRefresh).not.toHaveBeenCalled();
  });

  it('waits for an in-flight refresh instead of starting a new one', async () => {
    mockedIsRefreshInProgress.mockReturnValue(true);
    mockedWaitForRefresh.mockResolvedValueOnce(true);
    const retryResponse = { status: 200 };
    mockAxiosInstance.mockResolvedValueOnce(retryResponse);

    const result = await responseErrorFn(make401Error());

    expect(mockedSilentRefresh).not.toHaveBeenCalled();
    expect(mockedWaitForRefresh).toHaveBeenCalledTimes(1);
    expect(result).toBe(retryResponse);
  });

  it('rejects on 401 when an in-flight refresh ultimately fails', async () => {
    mockedIsRefreshInProgress.mockReturnValue(true);
    mockedWaitForRefresh.mockResolvedValueOnce(false);
    const error = make401Error();

    await expect(responseErrorFn(error)).rejects.toBe(error);
    expect(mockAxiosInstance).not.toHaveBeenCalled();
  });
});
