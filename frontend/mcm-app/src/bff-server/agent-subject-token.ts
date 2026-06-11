/**
 * Agent subject-token mint (T023) — the BFF's RFC 8693 token exchange.
 *
 * SERVER-SIDE ONLY. On each run invocation and each HITL resume the BFF exchanges the
 * user's session access token for a **run-scoped, audience-narrowed delegation token**
 * (short TTL, carrying an agent-origin marker) and hands THAT to the gateway as an
 * ephemeral run value — never the user's full session token (research R3,
 * MCM-Architecture §Token Custody & Propagation). The gateway re-exchanges per tool
 * call to bind each backend audience (T024).
 *
 * Invariants (SC-004): the minted token is never logged, never checkpointed, never
 * returned to the client. It lives only for the active run segment.
 *
 * Configuration (Keycloak 26.5 standard token exchange — T012):
 *   AGENT_SUBJECT_TOKEN_CLIENT_ID     confidential requester client (BFF-owned)
 *   AGENT_SUBJECT_TOKEN_CLIENT_SECRET its secret
 *   AGENT_SUBJECT_TOKEN_AUDIENCE      downscope target (default: the Agent Gateway client)
 * The exchanged-token lifespan is bounded by Keycloak client config; this module also
 * applies a defensive hard ceiling (≤3 min, research R3) to the reported expiry so the
 * in-memory run never treats a token as valid past the architecture's TTL band.
 */

import { env } from '@/config/env';
import { AuthError, AuthErrorCode } from '@/types/errors';
import { getRequestId } from '@/bff-server/request-context';
import { logger } from '@/bff-server/logger';

const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

/** Hard TTL ceiling for the run-scoped subject token (research R3: 2–5 min band). */
export const SUBJECT_TOKEN_MAX_TTL_SECONDS = 180;

const DEFAULT_AUDIENCE = 'agent-gateway';

interface SubjectTokenConfig {
  clientId: string;
  clientSecret: string;
  audience: string;
}

function readConfig(): SubjectTokenConfig {
  return {
    clientId: process.env.AGENT_SUBJECT_TOKEN_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.AGENT_SUBJECT_TOKEN_CLIENT_SECRET?.trim() ?? '',
    audience: process.env.AGENT_SUBJECT_TOKEN_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
  };
}

/**
 * Whether the BFF is configured to mint subject tokens. The tool-free graph runs
 * without one; callers use this to skip the mint until token exchange (T012) is applied.
 */
export function isSubjectTokenExchangeConfigured(): boolean {
  const { clientId, clientSecret } = readConfig();
  return clientId.length > 0 && clientSecret.length > 0;
}

export interface SubjectToken {
  /** The exchanged, run-scoped delegation token. Never log or checkpoint this. */
  token: string;
  /** Effective lifetime in seconds, capped at SUBJECT_TOKEN_MAX_TTL_SECONDS. */
  expiresIn: number;
}

interface TokenExchangeResponse {
  access_token: string;
  expires_in?: number;
}

/**
 * Mint a run-scoped subject token by exchanging the user's session access token.
 * @param userAccessToken the user's validated JWT (from `extractRawToken`).
 * @throws AuthError if token exchange is not configured or Keycloak rejects the exchange.
 */
export async function mintSubjectToken(userAccessToken: string): Promise<SubjectToken> {
  const { clientId, clientSecret, audience } = readConfig();
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new AuthError(
      AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      'Agent subject-token exchange is not configured',
      503,
    );
  }

  const body = new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    client_id: clientId,
    client_secret: clientSecret,
    subject_token: userAccessToken,
    subject_token_type: TOKEN_TYPE_ACCESS,
    requested_token_type: TOKEN_TYPE_ACCESS,
    audience,
  });

  const tokenUrl = `${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/token`;
  const requestId = getRequestId();

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    // Log the failure WITHOUT the subject token or any token material (SC-004).
    logger.error('Agent subject-token exchange failed', {
      action: 'agent_subject_token_mint',
      status: res.status,
    });
    throw new AuthError(
      AuthErrorCode.FORBIDDEN,
      'Failed to mint agent subject token',
      403,
    );
  }

  const data = (await res.json()) as TokenExchangeResponse;
  const reported = typeof data.expires_in === 'number' ? data.expires_in : SUBJECT_TOKEN_MAX_TTL_SECONDS;
  return {
    token: data.access_token,
    expiresIn: Math.min(reported, SUBJECT_TOKEN_MAX_TTL_SECONDS),
  };
}
