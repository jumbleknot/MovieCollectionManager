/**
 * BFF /init endpoint
 * GET /bff-api/auth/init
 *
 * Called once on app mount to ensure Keycloak is configured correctly for the
 * current environment. Registers required redirect URIs on the Keycloak client
 * so the PKCE login and email verification flows work correctly.
 *
 * This is a no-op if the URIs are already configured. Non-destructive.
 */

import { ensureClientRedirectUris } from '@/bff-server/keycloak';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';

const BASE_URL = process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081';

export async function GET(_req: Request): Promise<Response> {
  return withRequestContext(() => _get());
}

async function _get(): Promise<Response> {
  // ALL FIVE, every time. This function replaces the list it is given, so dropping one of the
  // others here is how this goes wrong — the app would keep working until someone hit
  // the flow whose URI went missing.
  await ensureClientRedirectUris([
    `${BASE_URL}/auth-callback`,        // web OAuth PKCE callback
    `${BASE_URL}/login?verified=true`,  // email verification redirect
    'mcm-app://native-auth-callback',   // native OAuth PKCE callback
    // Feature 073 (T056): the backup-schedule consent callback. A SEPARATE URI from the login
    // callback on purpose — its result is stored as a standing permission and never turned
    // into a session, and sharing the login URI would blur two flows that must stay distinct.
    `${BASE_URL}/bff-api/backups/consent`,
    // Feature 076 (T002): the account-deletion step-up callback. A SEPARATE URI again, for the
    // same reason as the consent one — this round trip proves presence before an irreversible
    // delete and never establishes a session. Without it registered, Keycloak refuses the
    // authorization request outright, which is also what makes deriving the redirect URI from
    // the request origin safe against a forged Host header.
    `${BASE_URL}/bff-api/account/delete`,
  ]);
  return Response.json({ ok: true }, { headers: securityHeaders() });
}
