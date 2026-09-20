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

const BASE_URL = process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081';

/** Registered on the Keycloak client by `/bff-api/auth/init` (T056). */
export const CONSENT_REDIRECT_URI = `${BASE_URL}/bff-api/backups/consent`;

interface PendingConsent {
  state: string;
  codeVerifier: string;
}

export async function GET(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_consent', async ({ userId }) => {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');

    if (code) return completeConsentCallback(userId, code, url);
    if (url.searchParams.has('start')) return startConsent(userId);
    return json(await offlineToken.describeConsent(userId));
  });
}

async function startConsent(userId: string): Promise<Response> {
  const { authorizationUrl, state, codeVerifier } = await offlineToken.buildConsentRequest(
    CONSENT_REDIRECT_URI,
  );
  const pending: PendingConsent = { state, codeVerifier };
  await setBackupConsentRequest(userId, JSON.stringify(pending));
  logger.audit('backup_schedule_consent_started', { userId });
  // Only the URL. The verifier stays server-side — a verifier the browser holds is one an
  // attacker holding the authorization code can also use, which is the attack PKCE exists for.
  return json({ authorizationUrl });
}

async function completeConsentCallback(userId: string, code: string, url: URL): Promise<Response> {
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

  await offlineToken.completeConsent(userId, code, pending.codeVerifier, CONSENT_REDIRECT_URI);

  // A REDIRECT, not JSON. Keycloak sent the user's BROWSER here, so whatever this returns is
  // what they look at next — and a page of JSON is not an answer to "did my backup schedule
  // get turned on?". They go back to the screen they started from, where the status now reads
  // as granted.
  return new Response(null, {
    status: 302,
    headers: { ...securityHeaders(), Location: `${BASE_URL}/settings/backups?consent=granted` },
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
