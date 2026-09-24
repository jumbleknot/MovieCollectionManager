/**
 * BFF POST /bff-api/account/delete-challenge (feature 076 — FR-001, FR-002, FR-005, FR-013).
 *
 * Begins the deletion round trip. DESTROYS NOTHING — it parks a short-lived request and returns
 * the URL to send the user to. The destructive endpoint is the callback, and the only way to
 * reach it is by completing an authentication at the identity provider.
 *
 * THE RESPONSE CARRIES ONLY THE URL. The PKCE verifier stays server-side: a verifier the browser
 * holds is one an attacker holding the authorization code can also use, which is the attack PKCE
 * exists to prevent.
 *
 * THE REDIRECT URI IS DERIVED FROM THE REQUEST ORIGIN, never a build-time base URL. The same
 * image serves the dev container on :8082 and the TLS proxy on :8443, while
 * `EXPO_PUBLIC_BFF_BASE_URL` is frequently unset and falls back to :8081 — a fixed base would
 * send the browser to a port with no BFF on it, and the callback would simply never arrive. This
 * is safe against a forged `Host` because Keycloak only honours redirect URIs registered on the
 * client: an unregistered URI is refused outright rather than redirected to.
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser, isAdmin } from '@/bff-server/role-check';
import { countUsersInClientRole } from '@/bff-server/keycloak';
import { buildStepUpRequest, buildNativeStepUpRequest } from '@/bff-server/account-step-up';
import { setPendingAccountDeletion } from '@/bff-server/cache-service';
import { checkAccountDeletionRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { deletionCallbackUri, problemResponse, errorStatus } from '@/bff-server/account-route-support';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => handle(req));
}

async function handle(req: Request): Promise<Response> {
  const headers = Object.fromEntries(req.headers.entries());
  const ip = extractClientIp(headers);

  try {
    await checkAccountDeletionRateLimit(ip);

    const { user } = await requireAuth(headers);
    requireMcUser(user);

    // FR-013. Counted only for an administrator, so an ordinary deletion costs no admin round
    // trip. A failure to count THROWS rather than returning 0 — see countUsersInClientRole.
    if (isAdmin(user) && (await countUsersInClientRole('mc-admin')) <= 1) {
      logger.audit('account_deletion_refused_last_admin', { userId: user.id, ip });
      return problemResponse(
        'You are the only administrator',
        409,
        'Give another account the administrator role before deleting this one.',
      );
    }

    const authTimeFloor = Math.floor(Date.now() / 1000);

    // NATIVE. The constitution is explicit that the BFF cannot redirect a native app, so the
    // device runs the OIDC flow itself and expo-auth-session mints the PKCE verifier there. All
    // this route can do is issue the `state` — which is still minted and parked server-side, so
    // it remains the CSRF binding and the single-use marker even though the verifier is not here.
    const body = await req.json().catch(() => ({}));
    const native = (body as { platform?: string })?.platform === 'native';

    if (native) {
      const { state, authorizationParams } = buildNativeStepUpRequest();
      await setPendingAccountDeletion(
        user.id,
        JSON.stringify({ state, authTimeFloor, requestedAt: authTimeFloor, native: true }),
      );
      logger.audit('account_deletion_requested', { userId: user.id, ip, platform: 'native' });
      // No authorizationUrl: the device builds its own request, because only it can bind the
      // request to a verifier it holds.
      return Response.json({ state, authorizationParams }, { status: 200, headers: securityHeaders() });
    }

    const redirectUri = deletionCallbackUri(req);
    const { authorizationUrl, state, codeVerifier } = await buildStepUpRequest(redirectUri);

    // `authTimeFloor` is what makes the step-up a step-up rather than a token minted off the
    // original login: the returned auth_time must be strictly greater than this.
    await setPendingAccountDeletion(
      // FR-002 — the ONLY identity this route ever uses. Nothing is read from the request.
      user.id,
      JSON.stringify({
        state,
        codeVerifier,
        redirectUri,
        authTimeFloor,
        requestedAt: authTimeFloor,
      }),
    );

    logger.audit('account_deletion_requested', { userId: user.id, ip });

    return Response.json({ authorizationUrl }, { status: 200, headers: securityHeaders() });
  } catch (err) {
    logger.error('account deletion challenge failed', {
      action: 'account_deletion_challenge_error', ip, error: err,
    });
    return problemResponse('Could not start account deletion', errorStatus(err));
  }
}
