/**
 * BFF GET /bff-api/account/delete (feature 076 — FR-009 to FR-032).
 *
 * THE DESTRUCTIVE ENDPOINT. The callback Keycloak redirects the user's browser to after a
 * step-up authentication. It verifies the proof, then runs the whole ordered deletion.
 *
 * EVERY RESPONSE IS A REDIRECT, never JSON. Keycloak sent the user's browser here, so whatever
 * this returns is what they look at next.
 *
 * IT RUNS TO COMPLETION EVEN IF THE CLIENT GOES AWAY (FR-032). Nothing in the BFF wires an
 * inbound abort signal into a cancellation path — verified by scan, and pinned by an integration
 * test — so a closed tab loses the RESPONSE, not the work. That is deliberate: the point of no
 * return is the confirmation, and a half-finished deletion is a worse state for the user than a
 * finished one.
 *
 * THERE IS NO NON-STEP-UP PATH TO DELETION. No `DELETE` method on this route, no admin variant,
 * and the user id comes from the validated session rather than the query — a deletion is
 * reachable only by completing an authentication at the identity provider.
 */

import { requireAuth, buildClearAuthCookies } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { verifyStepUpProof, type StepUpExchange } from '@/bff-server/account-step-up';
import { runAccountDeletion } from '@/bff-server/account-deletion';
import { exchangeCodeForTokens, decodeJwtPayload } from '@/bff-server/keycloak';
import { extractClientIp } from '@/bff-server/rate-limiter';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import {
  ACCOUNT_DELETED_PATH,
  ACCOUNT_SETTINGS_PATH,
  problemResponse,
  errorStatus,
  redirectTo,
} from '@/bff-server/account-route-support';

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => handle(req));
}

/** The real code exchange, injected so the verifier stays testable without a network. */
const exchange: StepUpExchange = async (code, codeVerifier, redirectUri) => {
  const tokens = await exchangeCodeForTokens(code, codeVerifier, redirectUri);
  return {
    idClaims: (decodeJwtPayload(tokens.id_token) ?? {}) as unknown as Record<string, unknown>,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
};

async function handle(req: Request): Promise<Response> {
  const headers = Object.fromEntries(req.headers.entries());
  const ip = extractClientIp(headers);

  let userId: string;
  try {
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    userId = user.id;
  } catch (err) {
    // Before any verification, and before anything is taken from Redis.
    return problemResponse('Not signed in', errorStatus(err));
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    logger.audit('account_deletion_reauth_rejected', { userId, ip, reason: 'no_pending' });
    return redirectTo(`${ACCOUNT_SETTINGS_PATH}?error=expired`);
  }

  let proof;
  try {
    proof = await verifyStepUpProof({
      // FR-002/FR-010 — the session's identity, never the query string's.
      userId,
      code,
      state,
      now: Math.floor(Date.now() / 1000),
      exchange,
    });
  } catch (err) {
    logger.error('step-up verification failed', {
      action: 'account_deletion_reauth_error', userId, ip, error: err,
    });
    return redirectTo(`${ACCOUNT_SETTINGS_PATH}?error=reauth`);
  }

  if (!proof.ok) {
    logger.audit('account_deletion_reauth_rejected', { userId, ip, reason: proof.reason });
    // A missing request and a bad proof are different things to the user: one means "start
    // again", the other means "we could not confirm it was you".
    const error = proof.reason === 'no_pending' ? 'expired' : 'reauth';
    return redirectTo(`${ACCOUNT_SETTINGS_PATH}?error=${error}`);
  }

  try {
    await runAccountDeletion({
      userId,
      accessToken: proof.accessToken,
      refreshToken: proof.refreshToken,
    });
  } catch (err) {
    // FR-028: the account was NOT deleted. Never a partial success, and never the underlying
    // message — it can carry a hostname or a connection string.
    logger.error('account deletion failed', {
      action: 'account_deletion_error', userId, ip, error: err,
    });
    logger.audit('account_deletion_failed', { userId, ip });
    return redirectTo(`${ACCOUNT_SETTINGS_PATH}?error=failed`);
  }

  // Cookies cleared on the way out: the session records are already gone, and leaving the
  // browser holding them would make a deleted account look signed in until the next request.
  return redirectTo(ACCOUNT_DELETED_PATH, buildClearAuthCookies());
}
