/**
 * Unit tests for rate limiter (T-040)
 */

import { checkLoginRateLimit, checkRegisterRateLimit, checkRefreshRateLimit, checkResendVerificationRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { RateLimitError } from '@/types/errors';

// Mock cache service
jest.mock('@/bff-server/cache-service', () => ({
  incrementRateLimit: jest.fn(),
}));

import { incrementRateLimit } from '@/bff-server/cache-service';
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

describe('extractClientIp', () => {
  it('extracts IP from X-Forwarded-For header', () => {
    expect(extractClientIp({ 'x-forwarded-for': '10.0.0.1, 192.168.1.1' })).toBe('10.0.0.1');
  });

  it('returns unknown when no headers', () => {
    expect(extractClientIp({})).toBe('unknown');
  });
});
