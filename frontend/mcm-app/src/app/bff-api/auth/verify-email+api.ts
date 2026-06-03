/**
 * BFF /verify-email endpoint (T-050)
 * GET /bff-api/auth/verify-email?token=...
 *
 * Handles email verification link clicks.
 * Keycloak generates the verification token — this endpoint proxies the action.
 * In practice, Keycloak's built-in verification handles token validation.
 * This route is for app-side deep link handling of the verified state.
 */

import { AuthErrorCode } from '@/types/errors';
import type { VerifyEmailResponse } from '@/types/auth';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';

export async function GET(request: Request): Promise<Response> {
  return withRequestContext(() => _get(request));
}

async function _get(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return Response.json(
        {
          error: 'This verification link is invalid or has already been used.',
          code: AuthErrorCode.VERIFICATION_TOKEN_INVALID,
        },
        { status: 400, headers: securityHeaders() },
      );
    }

    // Proxy to Keycloak's verification endpoint
    // Keycloak handles token validation, expiry (24h), single-use enforcement
    const keycloakVerifyUrl = `${process.env['KEYCLOAK_URL']}/realms/${process.env['KEYCLOAK_REALM']}/login-actions/action-token?key=${encodeURIComponent(token)}&client_id=${process.env['KEYCLOAK_CLIENT_ID']}`;

    const keycloakRes = await fetch(keycloakVerifyUrl, {
      method: 'GET',
      redirect: 'manual', // Don't follow — Keycloak redirects on both success AND failure
    });

    // A 302 alone does NOT mean success (009 finding #7): Keycloak redirects to an
    // ERROR page for an invalid/expired/used token too. Distinguish the genuine
    // success redirect from an error redirect by inspecting the Location target.
    const location = keycloakRes.headers.get('location') ?? '';
    const isErrorRedirect = /error/i.test(location) || location.includes('error=');
    const succeeded =
      keycloakRes.ok || (keycloakRes.status === 302 && location !== '' && !isErrorRedirect);

    if (succeeded) {
      const response: VerifyEmailResponse = {
        success: true,
        message: 'Your email has been verified. You can now log in.',
      };
      return Response.json(response, { status: 200, headers: securityHeaders() });
    }

    // Token is invalid or expired (explicit error status, or an error redirect).
    if (keycloakRes.status === 400 || keycloakRes.status === 410 || isErrorRedirect) {
      return Response.json(
        {
          error: 'This verification link has expired. Please request a new one.',
          code: AuthErrorCode.VERIFICATION_TOKEN_EXPIRED,
        },
        { status: 400, headers: securityHeaders() },
      );
    }

    return Response.json(
      {
        error: 'This verification link is invalid or has already been used.',
        code: AuthErrorCode.VERIFICATION_TOKEN_INVALID,
      },
      { status: 400, headers: securityHeaders() },
    );
  } catch {
    return Response.json(
      {
        error: 'An unexpected error occurred. Please try again.',
        code: AuthErrorCode.UNKNOWN,
      },
      { status: 500, headers: securityHeaders() },
    );
  }
}
