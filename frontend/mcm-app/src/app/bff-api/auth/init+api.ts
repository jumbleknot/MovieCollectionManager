/**
 * BFF /init endpoint
 * GET /bff-api/auth/init
 *
 * Called once on app mount to ensure Keycloak is configured correctly for the
 * current environment. Adds the web redirect URI (http://...) to the Keycloak
 * client's allowed redirect URIs so the PKCE login flow works in web browsers.
 *
 * This is a no-op if the URIs are already configured. Non-destructive.
 */

import { ensureClientRedirectUris } from '@/bff-server/keycloak';

const WEB_REDIRECT_URI = `${process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081'}/auth-callback`;

export async function GET(_req: Request): Promise<Response> {
  await ensureClientRedirectUris([WEB_REDIRECT_URI]);
  return Response.json({ ok: true });
}
