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

const BASE_URL = process.env['EXPO_PUBLIC_BFF_BASE_URL'] ?? 'http://localhost:8081';
const isDev = process.env['NODE_ENV'] !== 'production';

const DEV_NATIVE_URIS = isDev ? [
  'mcm-app://bff-api/auth/callback',
  // Legacy exp:// patterns kept for backward compatibility during transition.
  'exp://localhost:8081/--/bff-api/auth/callback',
  'exp://127.0.0.1:8081/--/bff-api/auth/callback',
  'exp://10.0.2.2:8081/--/bff-api/auth/callback',
] : [];

export async function GET(_req: Request): Promise<Response> {
  await ensureClientRedirectUris([
    `${BASE_URL}/auth-callback`,
    `${BASE_URL}/login`,
    `${BASE_URL}/login?verified=true`,
    ...DEV_NATIVE_URIS,
  ]);
  return Response.json({ ok: true });
}
