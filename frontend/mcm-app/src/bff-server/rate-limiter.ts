/**
 * Rate limiting middleware (T-027)
 * Per-endpoint rate limits using Redis counters (sliding window per TTL).
 *
 * Limits (from plan.md SC-003/SC-004):
 *   - /register:             10 requests / email / day (86400s)
 *   - /login:                5 requests / IP / minute (60s)
 *   - /refresh:              1 request / 30s per session (max 2 retries)
 *   - /verify-email:         1 request / token (single use — handled by token invalidation)
 *   - /resend-verification:  3 requests / email / hour (3600s)
 */

import { incrementRateLimit } from '@/bff-server/cache-service';
import { RateLimitError } from '@/types/errors';

// ─── Rate limit config ─────────────────────────────────────────────────────────

interface RateLimitRule {
  endpoint: string;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number;
}

const RATE_LIMITS: Record<string, RateLimitRule> = {
  register: {
    endpoint: 'register',
    limit: 10,
    windowSeconds: 86400,      // 1 day
    retryAfterSeconds: 86400,
  },
  login: {
    endpoint: 'login',
    limit: 5,
    windowSeconds: 60,         // 1 minute
    retryAfterSeconds: 60,
  },
  logout: {
    endpoint: 'logout',
    limit: 10,
    windowSeconds: 60,         // 1 minute
    retryAfterSeconds: 60,
  },
  refresh: {
    endpoint: 'refresh',
    limit: 2,
    windowSeconds: 30,         // 30 seconds
    retryAfterSeconds: 30,
  },
  resendVerification: {
    endpoint: 'resend-verification',
    limit: 3,
    windowSeconds: 3600,       // 1 hour
    retryAfterSeconds: 3600,
  },
};

// ─── Rate limit enforcement ────────────────────────────────────────────────────

/**
 * Check and increment rate limit for /register endpoint.
 * Identifier: email address (normalised to lowercase).
 */
export async function checkRegisterRateLimit(email: string): Promise<void> {
  const rule = RATE_LIMITS['register']!;
  const count = await incrementRateLimit(rule.endpoint, email.toLowerCase(), rule.windowSeconds);
  if (count > rule.limit) {
    throw new RateLimitError(rule.retryAfterSeconds);
  }
}

/**
 * Check and increment rate limit for /logout endpoint.
 * Identifier: client IP address. Prevents forced session termination DoS.
 */
export async function checkLogoutRateLimit(ip: string): Promise<void> {
  const rule = RATE_LIMITS['logout']!;
  const count = await incrementRateLimit(rule.endpoint, ip, rule.windowSeconds);
  if (count > rule.limit) {
    throw new RateLimitError(rule.retryAfterSeconds);
  }
}

/**
 * Check and increment rate limit for /login endpoint.
 * Identifier: client IP address.
 */
export async function checkLoginRateLimit(ip: string): Promise<void> {
  const rule = RATE_LIMITS['login']!;
  const count = await incrementRateLimit(rule.endpoint, ip, rule.windowSeconds);
  if (count > rule.limit) {
    throw new RateLimitError(rule.retryAfterSeconds);
  }
}

/**
 * Check and increment rate limit for /refresh endpoint.
 * Identifier: session ID.
 */
export async function checkRefreshRateLimit(sessionId: string): Promise<void> {
  const rule = RATE_LIMITS['refresh']!;
  const count = await incrementRateLimit(rule.endpoint, sessionId, rule.windowSeconds);
  if (count > rule.limit) {
    throw new RateLimitError(rule.retryAfterSeconds);
  }
}

/**
 * Check and increment rate limit for /resend-verification endpoint.
 * Identifier: email address (normalised to lowercase).
 */
export async function checkResendVerificationRateLimit(email: string): Promise<void> {
  const rule = RATE_LIMITS['resendVerification']!;
  const count = await incrementRateLimit(rule.endpoint, email.toLowerCase(), rule.windowSeconds);
  if (count > rule.limit) {
    throw new RateLimitError(rule.retryAfterSeconds);
  }
}

/**
 * Extract client IP from request headers.
 * Respects X-Forwarded-For for reverse proxy deployments.
 */
export function extractClientIp(headers: Record<string, string | string[] | undefined>): string {
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (ip?.split(',')[0] ?? '').trim() || 'unknown';
  }
  return 'unknown';
}
