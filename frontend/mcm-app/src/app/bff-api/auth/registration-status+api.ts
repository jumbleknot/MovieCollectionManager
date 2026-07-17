/**
 * BFF /auth/registration-status endpoint (feature 040 US3 / Item 1).
 * GET /bff-api/auth/registration-status — PUBLIC (unauthenticated).
 *
 * The signed-out (auth) screens have no session and cannot call the admin-gated settings
 * endpoint, so they read this to decide whether to show the "Create Account" entry point.
 * Exposes EXACTLY one boolean — no other administrative data (least-privilege public surface).
 */

import { getAppSettings } from '@/bff-server/app-settings-store';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => _get(req));
}

async function _get(_req: Request): Promise<Response> {
  try {
    const settings = await getAppSettings();
    return Response.json(
      { allowed: settings.allowSelfRegistration },
      { status: 200, headers: securityHeaders() },
    );
  } catch (err) {
    // Never break the login screen on a store hiccup. The AUTHORITATIVE block is server-side at
    // /register (which fails closed); this convenience read defaults to "show the link".
    logger.warn('registration-status: read failed', {
      action: 'registration_status_error',
      error: err,
    });
    return Response.json({ allowed: true }, { status: 200, headers: securityHeaders() });
  }
}
