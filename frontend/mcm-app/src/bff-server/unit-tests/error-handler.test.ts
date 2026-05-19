import { handleBffError } from '@/bff-server/error-handler';
import { AuthError, AuthErrorCode, RateLimitError } from '@/types/errors';
import { logger } from '@/bff-server/logger';

jest.mock('@/bff-server/logger', () => ({
  logger: { error: jest.fn() },
}));

const mockedLoggerError = logger.error as jest.MockedFunction<typeof logger.error>;

function makeReq(overrides: Partial<{ method: string; url: string }> = {}) {
  return { method: 'POST', url: '/bff-api/auth/login', ...overrides };
}

function makeRes() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('handleBffError — RateLimitError', () => {
  beforeEach(() => jest.clearAllMocks());

  it('responds 429 with Retry-After header and RATE_LIMIT_EXCEEDED code', () => {
    const res = makeRes();

    handleBffError(new RateLimitError(60), makeReq(), res);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.any(String),
      code: AuthErrorCode.RATE_LIMIT_EXCEEDED,
    });
  });

  it('does not log rate limit errors', () => {
    handleBffError(new RateLimitError(30), makeReq(), makeRes());

    expect(mockedLoggerError).not.toHaveBeenCalled();
  });
});

describe('handleBffError — AuthError', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the error statusCode for the response', () => {
    const res = makeRes();

    handleBffError(new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'internal detail', 401), makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns the safe user-facing message, not the internal error message', () => {
    const res = makeRes();

    handleBffError(new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'raw internal detail', 401), makeReq(), res);

    const body = (res.json as jest.Mock).mock.calls[0][0] as { error: string; code: string };
    expect(body.error).toBe('Your session has expired. Please log in again.');
    expect(body.error).not.toContain('raw internal detail');
    expect(body.code).toBe(AuthErrorCode.TOKEN_EXPIRED);
  });

  it('responds 403 with the FORBIDDEN safe message', () => {
    const res = makeRes();

    handleBffError(new AuthError(AuthErrorCode.FORBIDDEN, 'internal', 403), makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You do not have permission to access this resource.',
      code: AuthErrorCode.FORBIDDEN,
    });
  });

  it('does not call logger.error for known auth errors', () => {
    handleBffError(new AuthError(AuthErrorCode.INVALID_CREDENTIALS, 'internal', 401), makeReq(), makeRes());

    expect(mockedLoggerError).not.toHaveBeenCalled();
  });
});

describe('handleBffError — unknown errors', () => {
  beforeEach(() => jest.clearAllMocks());

  it('responds 500 with generic UNKNOWN message', () => {
    const res = makeRes();

    handleBffError(new Error('database connection failed'), makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'An unexpected error occurred. Please try again.',
      code: AuthErrorCode.UNKNOWN,
    });
  });

  it('does not expose internal error details in 500 response', () => {
    const res = makeRes();

    handleBffError(new Error('secret db password leaked'), makeReq(), res);

    const body = (res.json as jest.Mock).mock.calls[0][0] as { error: string };
    expect(body.error).not.toContain('secret db password leaked');
  });

  it('logs unknown errors with method, path, and error reference', () => {
    const err = new Error('unexpected crash');
    const req = makeReq({ method: 'GET', url: '/bff-api/user' });

    handleBffError(err, req, makeRes());

    expect(mockedLoggerError).toHaveBeenCalledWith(
      'unhandled BFF error',
      expect.objectContaining({
        action: 'unhandled_error',
        method: 'GET',
        path: '/bff-api/user',
        error: err,
      }),
    );
  });
});
