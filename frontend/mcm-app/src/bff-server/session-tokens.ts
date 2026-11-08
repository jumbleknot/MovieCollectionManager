/**
 * The member's tokens, held by the server (feature 085 US6 — FR-016..FR-019).
 *
 * The client holds only the opaque session reference. The access and refresh tokens Keycloak
 * issues live beside the session in Redis, sealed with AES-256-GCM and bound to that session and
 * its owner, and the server renews them itself when a request finds the access token due.
 *
 * Renewal happens AT MOST ONCE per session at a time. Keycloak rotates refresh tokens: a second
 * request renewing with the same refresh token would be refused, and that refusal ends the
 * member's session. So the first request takes a short lock and renews; a concurrent one waits for
 * the renewed tokens to land and uses them (it never renews on its own).
 */
import { randomUUID } from 'crypto';

import { env } from '@/config/env';
import { decryptSecret, encryptSecret, sessionTokensAad } from '@/bff-server/agent-config-crypto';
import {
  cacheSessionTokens,
  deleteSession,
  getSessionTokensRecord,
  releaseLockIfHeld,
  setLockIfAbsent,
} from '@/bff-server/cache-service';
import { refreshTokens, revokeToken, type KeycloakTokenResponse } from '@/bff-server/keycloak';
import { validateJwt } from '@/bff-server/token-service';
import { logger } from '@/bff-server/logger';
import type { Session } from '@/types/auth';
import { AuthError, AuthErrorCode } from '@/types/errors';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/**
 * The stored shape. The expiry times are deliberately in CLEAR and outside the AAD
 * (data-model.md): they are not secret, a test can age a session without the key, and editing
 * them cannot extend a token's life — the JWT's own `exp` is validated on every request.
 */
interface SealedRecord {
  v: 1;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  blob: string;
}

/** Renew when less than this much access-token lifetime remains (clock drift + one round trip). */
const RENEW_SKEW_MS = 30_000;
/** Above Keycloak's 5 s refresh timeout plus the write, so the lock outlives a slow renewal. */
const RENEW_LOCK_TTL_SECONDS = 15;
const RENEW_WAIT_POLL_MS = 100;
const RENEW_WAIT_ATTEMPTS = 50;

type SessionIdentity = Pick<Session, 'sessionId' | 'userId'>;

export function sealSessionTokens(session: SessionIdentity, tokens: SessionTokens): string {
  const record: SealedRecord = {
    v: 1,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    blob: encryptSecret(
      JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
      env.agentConfigEncKey,
      sessionTokensAad(session.sessionId, session.userId),
    ),
  };
  return JSON.stringify(record);
}

/** Throws when the record is malformed or was not sealed for this session and owner. */
export function openSessionTokens(session: SessionIdentity, raw: string): SessionTokens {
  const record = JSON.parse(raw) as Partial<SealedRecord>;
  if (record.v !== 1 || typeof record.blob !== 'string')
    throw new Error('Unrecognised session token record');
  const { accessToken, refreshToken } = JSON.parse(
    decryptSecret(
      record.blob,
      env.agentConfigEncKey,
      sessionTokensAad(session.sessionId, session.userId),
    ),
  ) as { accessToken: string; refreshToken: string };
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: Number(record.accessExpiresAt),
    refreshExpiresAt: Number(record.refreshExpiresAt),
  };
}

export function tokensFromGrant(grant: KeycloakTokenResponse, now = Date.now()): SessionTokens {
  return {
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token,
    accessExpiresAt: now + grant.expires_in * 1000,
    refreshExpiresAt: now + grant.refresh_expires_in * 1000,
  };
}

/**
 * The session's tokens, renewed first if the access token is due (or always, with `force` — the
 * client's own renewal request, FR-021). A rejected renewal ends the session (401); an unreachable
 * identity provider keeps it (503, retryable) — FR-019.
 */
export async function ensureFreshTokens(
  session: Session,
  tokens: SessionTokens,
  { force = false }: { force?: boolean } = {},
): Promise<SessionTokens> {
  if (!force && tokens.accessExpiresAt - Date.now() > RENEW_SKEW_MS) return tokens;

  const lock = `session-renew:${session.sessionId}`;
  const holder = randomUUID();
  if (!(await setLockIfAbsent(lock, holder, RENEW_LOCK_TTL_SECONDS))) {
    return waitForRenewal(session, tokens);
  }
  try {
    return await renew(session, tokens);
  } finally {
    await releaseLockIfHeld(lock, holder).catch(() => {});
  }
}

async function renew(session: Session, tokens: SessionTokens): Promise<SessionTokens> {
  let grant: KeycloakTokenResponse;
  try {
    grant = await refreshTokens(tokens.refreshToken);
  } catch (err) {
    if (err instanceof AuthError && err.statusCode === 401) {
      await deleteSession(session.sessionId, session.userId);
      logger.audit('session_renewal_rejected', { userId: session.userId });
    }
    throw err;
  }

  const renewed = tokensFromGrant(grant);
  // FR-006 by construction AND by check: the refresh token came from this session, so its owner
  // should be the session's. If it is not, the record is corrupt or tampered — nothing is kept.
  const { payload } = await validateJwt(renewed.accessToken);
  if (payload.sub !== session.userId) {
    await Promise.allSettled([
      revokeToken(renewed.refreshToken, 'refresh_token'),
      deleteSession(session.sessionId, session.userId),
    ]);
    logger.audit('session_refresh_owner_mismatch', { userId: session.userId });
    throw new AuthError(AuthErrorCode.SESSION_OWNER_MISMATCH, 'Session could not be renewed.', 401);
  }

  await cacheSessionTokens(session, sealSessionTokens(session, renewed));
  logger.info('session_renewed', { action: 'session_renewed', userId: session.userId });
  return renewed;
}

/** Another request holds the renewal: wait for its result rather than renewing a second time. */
async function waitForRenewal(session: Session, stale: SessionTokens): Promise<SessionTokens> {
  for (let attempt = 0; attempt < RENEW_WAIT_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, RENEW_WAIT_POLL_MS));
    const raw = await getSessionTokensRecord(session.sessionId);
    if (!raw) {
      throw new AuthError(
        AuthErrorCode.SESSION_NOT_FOUND,
        'Your session has ended. Please log in again.',
        401,
      );
    }
    const current = openSessionTokens(session, raw);
    if (current.accessExpiresAt > stale.accessExpiresAt) return current;
  }
  throw new AuthError(
    AuthErrorCode.SESSION_RENEWAL_PENDING,
    'Your session is being renewed.',
    503,
    {
      retryAfterSeconds: 1,
    },
  );
}
