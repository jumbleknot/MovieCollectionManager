/**
 * Placeholder server-held tokens for in-process session tests (feature 085).
 *
 * `createSession` now REQUIRES the member's tokens, which it seals beside the session — no code
 * path can create a tokenless session. Tests that exercise only the session record (cap, eviction,
 * expiry) seal these placeholders, which are never presented to anything. They are deliberately
 * not JWT-shaped, so a store dump that contained them in clear would still be caught as a leak.
 */
import type { SessionTokens } from '@/bff-server/session-tokens';

export function placeholderSessionTokens(): SessionTokens {
  const now = Date.now();
  return {
    accessToken: 'placeholder-access-token',
    refreshToken: 'placeholder-refresh-token',
    accessExpiresAt: now + 300_000,
    refreshExpiresAt: now + 1_800_000,
  };
}
