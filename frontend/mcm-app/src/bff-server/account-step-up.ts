/**
 * Step-up re-authentication for account deletion (feature 076, FR-005 through FR-010).
 *
 * WHY A ROUND TRIP AND NOT A PASSWORD FIELD. The constitution forbids the application handling
 * credentials at all, and forbids "any in-application re-authentication flow that does not
 * redirect through the IdP". The app client also has `directAccessGrantsEnabled: false`, so the
 * password grant is not available without weakening it. Sending the user back to the identity
 * provider is both the mandated design and the only one this realm supports.
 *
 * WHY `max_age=0` CARRIES THE SECURITY. Measured against the live realm (T001) with a control
 * leg to prove the SSO session was live and reusable:
 *
 *   authorize WITHOUT max_age  → code returned, no prompt   (the session IS reused)
 *   authorize WITH max_age=0   → login form served again    (the session is NOT reused)
 *
 * So a stolen session cookie cannot complete the step-up. The realm's stock browser flow gates
 * TOTP on `conditional-user-configured`, which means the second factor is demanded exactly when
 * the user has one enrolled — the application never decides the authentication-strength policy,
 * which is what FR-008 requires and what the constitution prohibits it from doing.
 *
 * `amr` IS NOT AVAILABLE. T001 measured that Keycloak does not emit it for this client, so
 * `auth_time` carries the whole requirement. That is sufficient: it is the moment the user
 * actually authenticated, and it advances on a genuine re-authentication.
 */

import { createHash, randomBytes } from 'crypto';
import { env } from '@/config/env';
import { takePendingAccountDeletion } from '@/bff-server/cache-service';

/**
 * The freshness window, shared by the parked request's TTL and the `auth_time` check.
 *
 * Long enough to complete an authentication that requires a second factor, short enough that a
 * captured proof is not useful later. One constant rather than two, so the pending record and
 * the proof it waits for cannot drift apart.
 */
export const STEP_UP_MAX_AGE_SECONDS = 300;

export interface StepUpRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

function authorizeEndpoint(): string {
  return `${env.keycloakPublicUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/auth`;
}

/**
 * Build the authorization request that forces a fresh authentication.
 *
 * The caller parks `state`, `codeVerifier` and `redirectUri` server-side and returns ONLY
 * `authorizationUrl` to the browser. A verifier the browser holds is one an attacker holding the
 * authorization code can also use, which is the attack PKCE exists to prevent.
 *
 * `redirectUri` is passed in rather than derived here because the SAME value must appear on both
 * OAuth legs — the authorize request and the code exchange — or Keycloak rejects the exchange
 * with `invalid_grant`. Recomputing it on the callback would silently differ if the two legs
 * ever arrived on different origins, which is measurably the case here: the same image serves
 * :8082 and :8443.
 */
export async function buildStepUpRequest(redirectUri: string): Promise<StepUpRequest> {
  const codeVerifier = randomBytes(40).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const params = new URLSearchParams({
    client_id: env.keycloakClientId,
    response_type: 'code',
    // `openid` ONLY. The backup-consent flow asks for `offline_access` because it is establishing
    // a standing permission that must outlive the session. This flow establishes proof of
    // presence, and minting a non-expiring token inside the flow whose purpose is to destroy one
    // would be perverse.
    scope: 'openid',
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Both, deliberately. `prompt=login` asks for a fresh authentication; `max_age=0` makes any
    // existing authentication too old to satisfy the request. Keycloak honours either, and
    // sending both means neither a prompt-ignoring client config nor a clock nuance can quietly
    // turn this back into a silent SSO reuse.
    prompt: 'login',
    max_age: '0',
  });

  return {
    authorizationUrl: `${authorizeEndpoint()}?${params}`,
    state,
    codeVerifier,
    redirectUri,
  };
}

// ─── Verification (FR-009, FR-010, FR-012) ────────────────────────────────────────────────────

/**
 * Why a proof was refused. Enumerated rather than free-text so a refusal can be counted, and so
 * no message from Keycloak can leak into the audit stream.
 */
export type StepUpRejectionReason =
  | 'no_pending'
  | 'state_mismatch'
  | 'subject_mismatch'
  | 'missing_auth_time'
  | 'stale_auth';

export type StepUpVerification =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; reason: StepUpRejectionReason };

export interface StepUpExchangeResult {
  idClaims: Record<string, unknown>;
  accessToken: string;
  refreshToken: string;
}

export type StepUpExchange = (
  code: string,
  codeVerifier: string,
  redirectUri: string,
) => Promise<StepUpExchangeResult>;

interface PendingDeletionRecord {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authTimeFloor: number;
}

/**
 * Verify that the user really did just re-authenticate, before anything is destroyed.
 *
 * THE PENDING RECORD IS CONSUMED FIRST, whatever the outcome. A proof that fails its checks must
 * not be retryable against the same request — otherwise an attacker who can reach the callback
 * gets unlimited attempts at the state value.
 *
 * ABSENT `auth_time` IS A REFUSAL, never a pass. This is the check most likely to be written the
 * wrong way round: `if (authTime && isStale(authTime))` reads naturally and lets a token with no
 * `auth_time` at all straight through. A missing claim must never read as a satisfied
 * requirement, so the presence check is separate and comes first.
 *
 * TWO FRESHNESS TESTS, not one. The proof must be recent (within the window) AND must postdate
 * the authentication the session was established with. T001 measured that `auth_time` advances
 * on a genuine re-authentication, so the second test is what distinguishes a real step-up from
 * a token minted off the original login.
 */
export async function verifyStepUpProof(input: {
  userId: string;
  code: string;
  state: string;
  now: number;
  exchange: StepUpExchange;
}): Promise<StepUpVerification> {
  const { userId, code, state, now, exchange } = input;

  const stored = await takePendingAccountDeletion(userId);
  if (!stored) return { ok: false, reason: 'no_pending' };

  const pending = JSON.parse(stored) as PendingDeletionRecord;

  // Before the exchange, so a forged callback never causes a token to be minted at all.
  if (state !== pending.state) return { ok: false, reason: 'state_mismatch' };

  const { idClaims, accessToken, refreshToken } = await exchange(
    code,
    pending.codeVerifier,
    pending.redirectUri,
  );

  if (idClaims['sub'] !== userId) return { ok: false, reason: 'subject_mismatch' };

  const authTime = idClaims['auth_time'];
  if (typeof authTime !== 'number') return { ok: false, reason: 'missing_auth_time' };

  const withinWindow = now - authTime < STEP_UP_MAX_AGE_SECONDS;
  const advanced = authTime > pending.authTimeFloor;
  if (!withinWindow || !advanced) return { ok: false, reason: 'stale_auth' };

  return { ok: true, accessToken, refreshToken };
}
