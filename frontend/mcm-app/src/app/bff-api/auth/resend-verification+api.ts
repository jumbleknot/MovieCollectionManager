/**
 * BFF /resend-verification endpoint (T-051)
 * POST /bff-api/auth/resend-verification
 *
 * Resends verification email for unverified accounts.
 * Rate limited: 3 requests per email per hour.
 */

import { checkResendVerificationRateLimit } from '@/bff-server/rate-limiter';
import { sendVerificationEmail } from '@/bff-server/email-service';
import { AuthError, AuthErrorCode } from '@/types/errors';
import { isValidEmail } from '@/utils/validators';
import type { ResendVerificationRequest, ResendVerificationResponse } from '@/types/auth';

// ─── Lookup user ID by email via Keycloak Admin API ───────────────────────────

async function getUserIdByEmail(email: string): Promise<string | null> {
  const adminToken = await getAdminToken();

  const res = await fetch(
    `${process.env['KEYCLOAK_URL']}/admin/realms/${process.env['KEYCLOAK_REALM']}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );

  if (!res.ok) return null;

  const users = (await res.json()) as Array<{
    id: string;
    email: string;
    emailVerified: boolean;
  }>;

  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return null;
  if (user.emailVerified) throw new AuthError(AuthErrorCode.ALREADY_VERIFIED, 'Email already verified', 400);

  return user.id;
}

async function getAdminToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env['KEYCLOAK_ADMIN_USER'] ?? 'admin',
    password: process.env['KEYCLOAK_ADMIN_PASSWORD'] ?? '',
  });

  const res = await fetch(
    `${process.env['KEYCLOAK_URL']}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );

  if (!res.ok) throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Admin token failed', 503);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as Partial<ResendVerificationRequest>;
    const email = body.email?.trim();

    if (!email || !isValidEmail(email)) {
      return Response.json(
        { error: 'Please enter a valid email address.', code: AuthErrorCode.INVALID_EMAIL },
        { status: 400 },
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
      return Response.json(response, { status: 200 });
    }

    // Send verification email
    await sendVerificationEmail(userId);

    const response: ResendVerificationResponse = {
      success: true,
      message: 'If that email is registered and unverified, a verification link has been sent.',
    };
    return Response.json(response, { status: 200 });
  } catch (err) {
    if (err instanceof AuthError) {
      const messages: Record<string, string> = {
        [AuthErrorCode.ALREADY_VERIFIED]: 'Your email address has already been verified.',
        [AuthErrorCode.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please try again later.',
        [AuthErrorCode.KEYCLOAK_UNAVAILABLE]: 'The authentication service is temporarily unavailable. Please try again later.',
      };
      return Response.json(
        { error: messages[err.code] ?? 'An unexpected error occurred.', code: err.code },
        { status: err.statusCode },
      );
    }
    return Response.json(
      { error: 'An unexpected error occurred. Please try again.', code: AuthErrorCode.UNKNOWN },
      { status: 500 },
    );
  }
}
