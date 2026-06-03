/**
 * Unit tests for rate limiter (T-040)
 */

import { checkLoginRateLimit, checkRegisterRateLimit, checkRegisterIpRateLimit, checkRefreshRateLimit, checkResendVerificationRateLimit, checkLogoutRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { RateLimitError } from '@/types/errors';

import { incrementRateLimit } from '@/bff-server/cache-service';

// Mock cache service
jest.mock('@/bff-server/cache-service', () => ({
  incrementRateLimit: jest.fn(),
}));
const mockedIncrement = incrementRateLimit as jest.MockedFunction<typeof incrementRateLimit>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkLoginRateLimit', () => {
  it('allows requests within limit', async () => {
    mockedIncrement.mockResolvedValue(3);
    await expect(checkLoginRateLimit('192.168.1.1')).resolves.toBeUndefined();
    expect(mockedIncrement).toHaveBeenCalledWith('login', '192.168.1.1', 60);
  });

  it('throws RateLimitError when limit exceeded', async () => {
    mockedIncrement.mockResolvedValue(6); // > 5 limit
    await expect(checkLoginRateLimit('192.168.1.1')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('checkRegisterRateLimit', () => {
  it('allows requests within limit', async () => {
    mockedIncrement.mockResolvedValue(5);
    await expect(checkRegisterRateLimit('user@example.com')).resolves.toBeUndefined();
    expect(mockedIncrement).toHaveBeenCalledWith('register', 'user@example.com', 86400);
  });

  it('normalises email to lowercase', async () => {
    mockedIncrement.mockResolvedValue(1);
    await checkRegisterRateLimit('User@Example.COM');
    expect(mockedIncrement).toHaveBeenCalledWith('register', 'user@example.com', 86400);
  });

  it('throws RateLimitError when limit exceeded', async () => {
    mockedIncrement.mockResolvedValue(11); // > 10 limit
    await expect(checkRegisterRateLimit('user@example.com')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('checkRefreshRateLimit', () => {
  it('allows within limit', async () => {
    mockedIncrement.mockResolvedValue(1);
    await expect(checkRefreshRateLimit('session-abc')).resolves.toBeUndefined();
  });

  it('throws RateLimitError when limit exceeded', async () => {
    mockedIncrement.mockResolvedValue(3); // > 2 limit
    await expect(checkRefreshRateLimit('session-abc')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('checkResendVerificationRateLimit', () => {
  it('allows within limit', async () => {
    mockedIncrement.mockResolvedValue(2);
    await expect(checkResendVerificationRateLimit('user@example.com')).resolves.toBeUndefined();
  });

  it('throws RateLimitError when limit exceeded', async () => {
    mockedIncrement.mockResolvedValue(4); // > 3 limit
    await expect(checkResendVerificationRateLimit('user@example.com')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('checkLogoutRateLimit', () => {
  it('allows requests within limit', async () => {
    mockedIncrement.mockResolvedValue(5);
    await expect(checkLogoutRateLimit('192.168.1.1')).resolves.toBeUndefined();
    expect(mockedIncrement).toHaveBeenCalledWith('logout', '192.168.1.1', 60);
  });

  it('throws RateLimitError when limit exceeded', async () => {
    mockedIncrement.mockResolvedValue(11); // > 10 limit
    await expect(checkLogoutRateLimit('192.168.1.1')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('checkRegisterIpRateLimit', () => {
  it('allows requests within the per-source limit', async () => {
    mockedIncrement.mockResolvedValue(5);
    await expect(checkRegisterIpRateLimit('1.2.3.4')).resolves.toBeUndefined();
    expect(mockedIncrement).toHaveBeenCalledWith('register-ip', '1.2.3.4', 86400);
  });

  it('throws RateLimitError when the per-source limit is exceeded', async () => {
    mockedIncrement.mockResolvedValue(21); // > 20 limit
    await expect(checkRegisterIpRateLimit('1.2.3.4')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('skips limiting (no throw, no increment) when identity is null', async () => {
    await expect(checkRegisterIpRateLimit(null)).resolves.toBeUndefined();
    expect(mockedIncrement).not.toHaveBeenCalled();
  });
});

describe('IP-scoped checks skip when identity is null (no shared lockout bucket)', () => {
  it('checkLoginRateLimit(null) does not increment', async () => {
    await expect(checkLoginRateLimit(null)).resolves.toBeUndefined();
    expect(mockedIncrement).not.toHaveBeenCalled();
  });
});

describe('extractClientIp', () => {
  it('returns the right-most XFF hop behind a trusted proxy (spoofed left entries ignored)', () => {
    // Client may forge the left entries; the trusted proxy appends the real peer last.
    expect(extractClientIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 10.0.0.1' }, true)).toBe('10.0.0.1');
  });

  it('returns null behind a trusted proxy when XFF is absent', () => {
    expect(extractClientIp({}, true)).toBeNull();
  });

  it('returns null (untrusted) when not behind a trusted proxy, even with XFF present', () => {
    expect(extractClientIp({ 'x-forwarded-for': '10.0.0.1' }, false)).toBeNull();
  });
});
