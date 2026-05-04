/**
 * BFF /register endpoint (T-049)
 * POST /bff-api/auth/register
 *
 * Creates a new user in Keycloak via the Admin API and triggers email verification.
 * Rate limited: 10 requests per email per day.
 */

import { ExpoRequest, ExpoResponse } from 'expo-router/server';
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

export async function POST(request: ExpoRequest): Promise<ExpoResponse> {
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
    await sendVerificationEmail(userId);

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
    await cacheUserProfile(profile);

    const response: RegisterResponse = {
      success: true,
      message: 'Account created. Please check your email to verify your address.',
      userId,
    };

    return ExpoResponse.json(response, { status: 201 });
  } catch (err) {
    // Adapt handleBffError to return ExpoResponse
    const { code, message, status } = extractError(err);
    return ExpoResponse.json({ error: message, code }, { status });
  }
}

function extractError(err: unknown): { code: string; message: string; status: number } {
  if (err instanceof AuthError) {
    const { handleBffError: _ } = require('@/bff-server/error-handler');
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
