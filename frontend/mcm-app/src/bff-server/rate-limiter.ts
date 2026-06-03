/**
 * Rate limiting middleware (T-027)
 * Per-endpoint rate limits using Redis counters (sliding window per TTL).
 *
 * Limits (from plan.md SC-003/SC-004):
 *   - /register:             10 requests / email / day (86400s) + 20 / source IP / day
 *   - /login:                5 requests / IP / minute (60s)
 *   - /refresh:              1 request / 30s per session (max 2 retries)
 *   - /verify-email:         1 request / token (single use — handled by token invalidation)
 *   - /resend-verification:  3 requests / email / hour (3600s)
 *
 * Client identity (009 finding #4): the rate-limit key for IP-scoped limits is
 * derived from `X-Forwarded-For` ONLY when running behind a configured trusted
 * proxy (`TRUSTED_PROXY=true`); the real client is then the right-most XFF entry
 * (left entries are client-spoofable). Without a trusted proxy, client-supplied
 * headers are NOT trusted and there is no connection address available to the
 * Expo Router runtime, so the identity is `null` and IP limiting is skipped with
 * a warning — never collapsed into a shared `'unknown'` bucket (which would let a
 * single client lock out everyone).
 */

import { incrementRateLimit } from '@/bff-server/cache-service';
import { logger } from '@/bff-server/logger';
import { env } from '@/config/env';
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
  registerIp: {
    endpoint: 'register-ip',
    limit: 20,
    windowSeconds: 86400,      // 1 day — per source, regardless of email
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
 * Apply an IP-scoped rate limit. When `identity` is null (no trusted client IP),
 * limiting is skipped with a warning instead of locking out all clients.
 */
async function enforceIpLimit(rule: RateLimitRule, identity: string | null): Promise<void> {
  if (identity === null) {
    logger.warn('rate limit skipped: no trusted client identity', {
      action: 'rate_limit_no_identity',
      endpoint: rule.endpoint,
    });
    return;
  }
  const count = await incrementRateLimit(rule.endpoint, identity, rule.windowSeconds);
  if (count > rule.limit) {
    throw new RateLimitError(rule.retryAfterSeconds);
  }
}

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
 * Check and increment the per-source registration limit (009 finding #8).
 * Identifier: client IP. Prevents unlimited unique-email registration spam from
 * one source. Skipped (with warning) when no trusted client IP is available.
 */
export async function checkRegisterIpRateLimit(ip: string | null): Promise<void> {
  await enforceIpLimit(RATE_LIMITS['registerIp']!, ip);
}

/**
 * Check and increment rate limit for /logout endpoint.
 * Identifier: client IP address. Prevents forced session termination DoS.
 */
export async function checkLogoutRateLimit(ip: string | null): Promise<void> {
  await enforceIpLimit(RATE_LIMITS['logout']!, ip);
}

/**
 * Check and increment rate limit for /login endpoint.
 * Identifier: client IP address.
 */
export async function checkLoginRateLimit(ip: string | null): Promise<void> {
  await enforceIpLimit(RATE_LIMITS['login']!, ip);
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
 * Derive the rate-limiting client identity from request headers.
 *
 * Returns the trusted client IP, or `null` when no trustworthy identity can be
 * established (so the caller skips IP limiting rather than sharing one bucket).
 *
 * @param trustProxy whether the deployment runs behind a configured trusted
 *   reverse proxy that sets `X-Forwarded-For` (defaults to `env.trustProxy`).
 */
export function extractClientIp(
  headers: Record<string, string | string[] | undefined>,
  trustProxy: boolean = env.trustProxy,
): string | null {
  if (!trustProxy) {
    // Client-supplied XFF is untrusted and the runtime exposes no socket address.
    return null;
  }
  const forwarded = headers['x-forwarded-for'];
  if (!forwarded) {
    return null;
  }
  const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  const hops = (raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  // With a single trusted proxy, the real peer is the right-most hop (the proxy
  // appends it); left entries may be client-forged.
  return hops.length > 0 ? hops[hops.length - 1]! : null;
}
