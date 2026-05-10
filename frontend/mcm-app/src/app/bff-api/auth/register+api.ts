/**
 * BFF /register endpoint (T-049)
 * POST /bff-api/auth/register
 *
 * Creates a new user in Keycloak via the Admin API and triggers email verification.
 * Rate limited: 10 requests per email per day.
 */

import { checkRegisterRateLimit, extractClientIp } from '@/bff-server/rate-limiter';
import { createUser, assignMcUserRole, sendVerificationEmail } from '@/bff-server/keycloak';
import { cacheUserProfile } from '@/bff-server/cache-service';
import { handleBffError } from '@/bff-server/error-handler';
import { AuthError, AuthErrorCode } from '@/types/errors';
import {
  isValidEmail,
  isValidUsername,
  isValidPassword,
} from '@/utils/validators';
import type { RegisterRequest, RegisterResponse, UserProfile } from '@/types/auth';

export async function POST(request: Request): Promise<Response> {
  const headers = Object.fromEntries(request.headers.entries());

  try {
    const body = (await request.json()) as Partial<RegisterRequest>;

    const { username, email, firstName, lastName, password } = body;

    // ─── Input validation ──────────────────────────────────────────────────

    if (!username || !email || !firstName || !lastName || !password) {
      throw new AuthError(AuthErrorCode.INVALID_INPUT, 'All fields are required', 400);
    }

    if (!isValidEmail(email)) {
      throw new AuthError(AuthErrorCode.INVALID_EMAIL, 'Invalid email format', 400);
    }

    if (!isValidUsername(username)) {
      throw new AuthError(
        AuthErrorCode.INVALID_INPUT,
        'Username must be 3–20 alphanumeric characters or underscores',
        400,
      );
    }

    if (!isValidPassword(password)) {
      throw new AuthError(AuthErrorCode.WEAK_PASSWORD, 'Password does not meet policy', 400);
    }

    // ─── Rate limit ────────────────────────────────────────────────────────
    await checkRegisterRateLimit(email);

    // ─── Create user in Keycloak ───────────────────────────────────────────
    const userId = await createUser({ username, email, firstName, lastName, password });

    // ─── Assign mc-user role ───────────────────────────────────────────────
    await assignMcUserRole(userId);

    // ─── Send verification email ───────────────────────────────────────────
    // Pass redirect_uri so Keycloak sends the user back to the app login page
    // after they click the verification link.
    // Non-fatal: SMTP may not be configured in dev. User was created successfully.
    const origin = request.headers.get('origin') ?? 'http://localhost:8081';
    const verificationRedirectUri = `${origin}/(auth)/login?verified=true`;
    try {
      await sendVerificationEmail(userId, verificationRedirectUri);
    } catch (emailErr) {
      console.warn('[BFF /register] Failed to send verification email:', emailErr);
    }

    // ─── Cache user profile (10-min TTL) ──────────────────────────────────
    const profile: UserProfile = {
      id: userId,
      username,
      email,
      firstName,
      lastName,
      roles: ['mc-user'],
      emailVerified: false,
      accountStatus: 'active',
      createdAt: new Date().toISOString(),
    };
    // Non-fatal: cache miss is recoverable.
    try {
      await cacheUserProfile(profile);
    } catch (cacheErr) {
      console.warn('[BFF /register] Failed to cache user profile:', cacheErr);
    }

    const response: RegisterResponse = {
      success: true,
      message: 'Account created. Please check your email to verify your address.',
      userId,
    };

    return Response.json(response, { status: 201 });
  } catch (err) {
    // Adapt handleBffError to return Response
    const { code, message, status } = extractError(err);
    return Response.json({ error: message, code }, { status });
  }
}

function extractError(err: unknown): { code: string; message: string; status: number } {
  if (err instanceof AuthError) {
    return {
      code: err.code,
      message: getUserMessage(err.code),
      status: err.statusCode,
    };
  }
  return {
    code: AuthErrorCode.UNKNOWN,
    message: 'An unexpected error occurred. Please try again.',
    status: 500,
  };
}

function getUserMessage(code: string): string {
  const messages: Record<string, string> = {
    [AuthErrorCode.WEAK_PASSWORD]: 'Password must be at least 12 characters and include uppercase, lowercase, numbers, and symbols.',
    [AuthErrorCode.DUPLICATE_USERNAME]: 'That username is already taken. Please choose another.',
    [AuthErrorCode.DUPLICATE_EMAIL]: 'An account with that email already exists.',
    [AuthErrorCode.INVALID_EMAIL]: 'Please enter a valid email address.',
    [AuthErrorCode.INVALID_INPUT]: 'The provided information is invalid. Please check your input.',
    [AuthErrorCode.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please try again later.',
    [AuthErrorCode.KEYCLOAK_UNAVAILABLE]: 'The authentication service is temporarily unavailable. Please try again later.',
    [AuthErrorCode.UNKNOWN]: 'An unexpected error occurred. Please try again.',
  };
  return messages[code] ?? messages[AuthErrorCode.UNKNOWN]!;
}
