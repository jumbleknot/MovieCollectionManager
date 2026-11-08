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

/** Bound on the exchange call: a hung identity provider is a transient refusal, never a hung turn. */
const EXCHANGE_TIMEOUT_MS = 5000;

/** OAuth error codes that mean "this member's credential is no good", as opposed to an outage. */
const CREDENTIAL_REJECTIONS = new Set(['invalid_token', 'invalid_grant']);

/**
 * Keycloak 26.5's standard token exchange answers a revoked or malformed subject token with
 * `400 invalid_request` and this exact description — measured against the live realm (feature 085
 * T010), not taken from the RFC, which would say `invalid_token`. `invalid_request` alone is not
 * enough: Keycloak also uses it for configuration faults ("Requested audience not available"),
 * which are outages, not a reason to send the member back to sign-in.
 */
const KEYCLOAK_INVALID_SUBJECT_TOKEN = 'Invalid token';

/**
 * A refused mint, classified (feature 085, item #844 — FR-001/FR-002).
 *
 * `auth` means the identity provider rejected the member's credential: a 401 the client's agent
 * transport already answers with one silent renewal, then sign-in. `transient` is everything else —
 * unreachable, timed out, a server error, or a 4xx that is not about the member (a misconfigured
 * exchange client answers 403 `access_denied`). That is a retryable 503: the member is not signed
 * out for an outage, and the turn does not run identity-less, which is what produced the
 * unexplained "No caller identity is available" refusal this replaces.
 */
export class AgentIdentityError extends AuthError {
  constructor(
    public readonly outcome: 'auth' | 'transient',
    public readonly providerStatus: number | null,
  ) {
    super(
      outcome === 'auth'
        ? AuthErrorCode.AGENT_IDENTITY_REJECTED
        : AuthErrorCode.AGENT_IDENTITY_UNAVAILABLE,
      outcome === 'auth'
        ? 'Your session has expired. Please log in again.'
        : 'The assistant is temporarily unavailable. Please try again.',
      outcome === 'auth' ? 401 : 503,
      outcome === 'auth' ? {} : { retryAfterSeconds: 5 },
    );
    this.name = 'AgentIdentityError';
  }
}

/**
 * Log the refusal with its class, the provider's status and its OAuth `error` code (a fixed
 * vocabulary such as `invalid_request`) — never a token, the `error_description` or the body (FR-005).
 */
function refuse(
  outcome: 'auth' | 'transient',
  status: number | null,
  providerError?: string,
): AgentIdentityError {
  const context = { action: 'agent_subject_token_mint', outcome, status, providerError };
  if (outcome === 'auth') logger.warn('agent_identity_refused', context);
  else logger.error('agent_identity_refused', context);
  return new AgentIdentityError(outcome, status);
}

interface OAuthError {
  error?: string;
  description?: string;
}

async function oauthErrorOf(res: Response): Promise<OAuthError> {
  try {
    const body = (await res.json()) as { error?: unknown; error_description?: unknown };
    return {
      error: typeof body.error === 'string' ? body.error : undefined,
      description: typeof body.error_description === 'string' ? body.error_description : undefined,
    };
  } catch {
    return {};
  }
}

function rejectsCredential(status: number, { error, description }: OAuthError): boolean {
  if (status !== 400 && status !== 401) return false;
  if (error && CREDENTIAL_REJECTIONS.has(error)) return true;
  return error === 'invalid_request' && description === KEYCLOAK_INVALID_SUBJECT_TOKEN;
}

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
 * @param userAccessToken the member's server-held access token (from `requireAuth`), already validated.
 * @throws AuthError if token exchange is not configured; AgentIdentityError if Keycloak refuses it.
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

  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    throw refuse('transient', null);
  }

  if (!res.ok) {
    const oauthError = await oauthErrorOf(res);
    throw refuse(
      rejectsCredential(res.status, oauthError) ? 'auth' : 'transient',
      res.status,
      oauthError.error,
    );
  }

  const data = (await res.json()) as TokenExchangeResponse;
  const reported =
    typeof data.expires_in === 'number' ? data.expires_in : SUBJECT_TOKEN_MAX_TTL_SECONDS;
  return {
    token: data.access_token,
    expiresIn: Math.min(reported, SUBJECT_TOKEN_MAX_TTL_SECONDS),
  };
}
