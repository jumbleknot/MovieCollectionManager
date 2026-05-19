/**
 * BFF /resend-verification endpoint (T-051)
 * POST /bff-api/auth/resend-verification
 *
 * Resends verification email for unverified accounts.
 * Rate limited: 3 requests per email per hour.
 */

import { checkResendVerificationRateLimit } from '@/bff-server/rate-limiter';
import { sendVerificationEmail } from '@/bff-server/email-service';
import { getUserIdByEmail } from '@/bff-server/keycloak';
import { AuthError, AuthErrorCode } from '@/types/errors';
import { isValidEmail } from '@/utils/validators';
import type { ResendVerificationRequest, ResendVerificationResponse } from '@/types/auth';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  return withRequestContext(() => _post(request));
}

async function _post(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<ResendVerificationRequest>;
    const email = body.email?.trim();

    if (!email || !isValidEmail(email)) {
      return Response.json(
        { error: 'Please enter a valid email address.', code: AuthErrorCode.INVALID_EMAIL },
        { status: 400, headers: securityHeaders() },
      );
    }

    // Rate limit
    await checkResendVerificationRateLimit(email);

    // Lookup user
    const userId = await getUserIdByEmail(email);

    if (!userId) {
      // Return success even when email not found — prevents user enumeration (OWASP A01)
      const response: ResendVerificationResponse = {
        success: true,
        message: 'If that email is registered and unverified, a verification link has been sent.',
      };
      return Response.json(response, { status: 200, headers: securityHeaders() });
    }

    // Send verification email with redirect back to the app login page
    const origin = request.headers.get('origin') ?? 'http://localhost:8081';
    await sendVerificationEmail(userId, `${origin}/login?verified=true`);

    const response: ResendVerificationResponse = {
      success: true,
      message: 'If that email is registered and unverified, a verification link has been sent.',
    };
    return Response.json(response, { status: 200, headers: securityHeaders() });
  } catch (err) {
    if (err instanceof AuthError) {
      const messages: Record<string, string> = {
        [AuthErrorCode.ALREADY_VERIFIED]: 'Your email address has already been verified.',
        [AuthErrorCode.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please try again later.',
        [AuthErrorCode.KEYCLOAK_UNAVAILABLE]: 'The authentication service is temporarily unavailable. Please try again later.',
      };
      return Response.json(
        { error: messages[err.code] ?? 'An unexpected error occurred.', code: err.code },
        { status: err.statusCode, headers: securityHeaders() },
      );
    }
    return Response.json(
      { error: 'An unexpected error occurred. Please try again.', code: AuthErrorCode.UNKNOWN },
      { status: 500, headers: securityHeaders() },
    );
  }
}
