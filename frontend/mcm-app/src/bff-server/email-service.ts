/**
 * Email service (T-023)
 * Triggers email verification flows via Keycloak's Admin API.
 * Keycloak handles actual SMTP delivery based on realm email configuration.
 */

import { keycloakConfig } from '@/config/keycloak';
import { AuthError, AuthErrorCode } from '@/types/errors';

// ─── Admin token helper (duplicated from keycloak.ts to avoid circular deps) ──

async function getAdminToken(): Promise<string> {
  const { env } = await import('@/config/env');

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: env.keycloakAdminUser,
    password: env.keycloakAdminPassword,
  });

  const res = await fetch(
    `${env.keycloakUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );

  if (!res.ok) {
    throw new AuthError(AuthErrorCode.KEYCLOAK_UNAVAILABLE, 'Failed to obtain admin token', 503);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ─── Email service ─────────────────────────────────────────────────────────────

/**
 * Send (or resend) a verification email for the given Keycloak user ID.
 * Delegates SMTP delivery to Keycloak (configured via Realm Settings → Email).
 */
export async function sendVerificationEmail(userId: string): Promise<void> {
  const adminToken = await getAdminToken();

  const res = await fetch(
    `${keycloakConfig.adminApiBase}/users/${userId}/send-verify-email`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
    },
  );

  if (!res.ok) {
    if (res.status === 400) {
      // User already verified
      throw new AuthError(AuthErrorCode.ALREADY_VERIFIED, 'Email already verified', 400);
    }
    throw new AuthError(
      AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      'Failed to send verification email',
      502,
    );
  }
}

/**
 * Check if a Keycloak user's email has been verified.
 */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const adminToken = await getAdminToken();

  const res = await fetch(
    `${keycloakConfig.adminApiBase}/users/${userId}`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );

  if (!res.ok) {
    throw new AuthError(AuthErrorCode.UNAUTHORIZED, 'User not found', 404);
  }

  const user = (await res.json()) as { emailVerified?: boolean };
  return user.emailVerified === true;
}
