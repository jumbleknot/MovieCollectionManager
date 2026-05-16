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

const BASE_URL = process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081';

export async function GET(_req: Request): Promise<Response> {
  await ensureClientRedirectUris([
    `${BASE_URL}/auth-callback`,        // web OAuth PKCE callback
    `${BASE_URL}/login?verified=true`,  // email verification redirect
    'mcm-app://bff-api/auth/callback',  // native OAuth PKCE callback
  ]);
  return Response.json({ ok: true });
}
