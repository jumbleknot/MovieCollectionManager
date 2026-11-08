/**
 * Reach into the dev BFF's session store from an E2E spec (feature 085).
 *
 * Since 085 the member's tokens are held server-side, so "the access token expired mid-session"
 * can no longer be staged by deleting a browser cookie — there is no token cookie. The data model
 * keeps each session's token expiry times in CLEAR beside the sealed tokens precisely so a test can
 * age them without the encryption key (specs/085-bff-auth-fail-closed/data-model.md). The dev BFF's
 * Redis is published on localhost:6379, db 0 (the same store the integration suite reads).
 */
import Redis from 'ioredis';

const REDIS_URL = process.env['E2E_BFF_REDIS_URL'] ?? 'redis://localhost:6379/0';

/** Mark the session's server-held access token as expired, so the next request must renew it. */
export async function ageServerHeldAccessToken(sessionId: string): Promise<{ before: number }> {
  const redis = new Redis(REDIS_URL);
  try {
    const key = `session-tokens:${sessionId}`;
    const raw = await redis.get(key);
    if (!raw)
      throw new Error(
        `no server-held tokens for session ${sessionId} — is this the dev BFF's store?`,
      );
    const record = JSON.parse(raw) as { accessExpiresAt: number };
    const ttl = await redis.ttl(key);
    await redis.set(
      key,
      JSON.stringify({ ...record, accessExpiresAt: 0 }),
      'EX',
      Math.max(ttl, 60),
    );
    return { before: record.accessExpiresAt };
  } finally {
    redis.disconnect();
  }
}

/** The session's server-held access-token expiry (clear field), or null when the session is gone. */
export async function serverHeldAccessExpiry(sessionId: string): Promise<number | null> {
  const redis = new Redis(REDIS_URL);
  try {
    const raw = await redis.get(`session-tokens:${sessionId}`);
    return raw ? (JSON.parse(raw) as { accessExpiresAt: number }).accessExpiresAt : null;
  } finally {
    redis.disconnect();
  }
}
