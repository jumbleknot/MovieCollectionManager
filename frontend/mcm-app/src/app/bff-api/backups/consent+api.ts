/**
 * BFF /bff-api/backups/consent (feature 073, T053 — FR-022/FR-023).
 *
 * ONE ROUTE, THREE JOBS, distinguished by the query string:
 *   GET  ?start        → begin the consent round trip; returns the authorization URL to open
 *   GET  ?code=…&state → the callback Keycloak redirects the browser to; stores the grant
 *   GET  (neither)     → report whether a grant exists, and when it was made
 *   DELETE             → give the grant up, revoking it at the identity provider
 *
 * WHY A SEPARATE ROUND TRIP AT ALL. The user is already logged in, but that session was
 * established WITHOUT `offline_access`, and the BFF holds no refresh token from it to promote —
 * the session record is tokenless by constitution v2.0.0. There is nothing to shortcut, and
 * that is the right shape anyway: standing permission to act while the user is away should be
 * something they grant deliberately, not something that happened to them during login.
 *
 * THE CALLBACK IS AUTHENTICATED LIKE EVERY OTHER ROUTE. Keycloak redirects the user's own
 * browser here, so the session cookie is present and `withBackupRoute` applies unchanged. The
 * PKCE verifier never leaves the server, and the pending request is keyed by the authenticated
 * user — so a callback can only ever complete the consent that that same user started.
 */
import * as offlineToken from '@/bff-server/backup-offline-token';
import {
  withBackupRoute,
  json,
  problem,
} from '@/bff-server/backup-route-support';
import { securityHeaders } from '@/bff-server/security-headers';
import { setBackupConsentRequest, takeBackupConsentRequest } from '@/bff-server/cache-service';
import { logger } from '@/bff-server/logger';

/**
 * The consent callback, on the origin THIS REQUEST arrived at.
 *
 * DERIVED FROM THE REQUEST, not from a build-time base URL, and that is a correctness fix
 * rather than a preference. The same image serves the dev container on :8082 and the TLS proxy
 * on :8443, while `EXPO_PUBLIC_BFF_BASE_URL` is frequently unset and falls back to :8081. A
 * fixed base URL therefore sends the user's browser to a port with no BFF on it after they
 * sign in: the callback never arrives, the grant is never stored, and the schedule silently
 * never turns on. Measured exactly that way against the dev container.
 *
 * SAFE AGAINST A SPOOFED HOST HEADER because Keycloak only honours redirect URIs registered on
 * the client. An attacker who could forge the Host would produce an unregistered URI, and
 * Keycloak refuses the authorization request outright rather than redirecting anywhere.
 *
 * The same URI must be sent on BOTH legs — the authorize request and the code exchange — or
 * the exchange fails `invalid_grant`, which is why it is computed once per request and passed.
 */
function consentRedirectUri(req: Request): string {
  return `${new URL(req.url).origin}/bff-api/backups/consent`;
}

interface PendingConsent {
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export async function GET(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_consent', async ({ userId }) => {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');

    if (code) return completeConsentCallback(userId, code, url, consentRedirectUri(req));
    if (url.searchParams.has('start')) return startConsent(userId, consentRedirectUri(req));
    return json(await offlineToken.describeConsent(userId));
  });
}

async function startConsent(userId: string, redirectUri: string): Promise<Response> {
  const { authorizationUrl, state, codeVerifier } = await offlineToken.buildConsentRequest(
    redirectUri,
  );
  // The redirect URI is stashed WITH the verifier: the exchange must present the identical
  // value the authorize request used, and recomputing it on the callback would silently differ
  // if the two legs ever arrived on different origins.
  const pending: PendingConsent = { state, codeVerifier, redirectUri };
  await setBackupConsentRequest(userId, JSON.stringify(pending));
  logger.audit('backup_schedule_consent_started', { userId });
  // Only the URL. The verifier stays server-side — a verifier the browser holds is one an
  // attacker holding the authorization code can also use, which is the attack PKCE exists for.
  return json({ authorizationUrl });
}

async function completeConsentCallback(
  userId: string,
  code: string,
  url: URL,
  fallbackRedirectUri: string,
): Promise<Response> {
  const stashed = await takeBackupConsentRequest(userId);
  if (!stashed) {
    return problem('No consent request is pending', 400, 'Start again from the schedule settings.');
  }
  const pending = JSON.parse(stashed) as PendingConsent;

  // CSRF on the callback: a `state` that does not match the one this user started with means
  // the code did not come from their round trip. Single-use above, compared here.
  if (url.searchParams.get('state') !== pending.state) {
    return problem('That consent request did not match', 400, 'Start again from the schedule settings.');
  }

  await offlineToken.completeConsent(
    userId,
    code,
    pending.codeVerifier,
    pending.redirectUri ?? fallbackRedirectUri,
  );

  // A REDIRECT, not JSON. Keycloak sent the user's BROWSER here, so whatever this returns is
  // what they look at next — and a page of JSON is not an answer to "did my backup schedule
  // get turned on?". They go back to the screen they started from, where the status now reads
  // as granted.
  return new Response(null, {
    status: 302,
    headers: {
      ...securityHeaders(),
      Location: `${new URL(url.toString()).origin}/settings/backups?consent=granted`,
    },
  });
}

/**
 * Give the standing permission up (FR-023).
 *
 * A revocation failure is a 502 and the grant is KEPT, so a later attempt can still find it —
 * reporting success here while a live, non-expiring token stayed out there is the exact failure
 * SC-012 exists to prevent.
 */
export async function DELETE(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_consent_revoke', async ({ userId }) => {
    try {
      await offlineToken.revokeOfflineToken(userId);
    } catch (err) {
      if (err instanceof offlineToken.OfflineTokenRevocationError) {
        return problem('The permission could not be revoked', 502, err.message);
      }
      throw err;
    }
    return json({ granted: false });
  });
}
