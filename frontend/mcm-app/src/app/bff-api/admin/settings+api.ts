/**
 * BFF /admin/settings endpoint (feature 040 US3 / Item 1).
 * GET  /bff-api/admin/settings   — read global application settings (mc-admin only).
 * PATCH /bff-api/admin/settings  — change the self-registration toggle (mc-admin only).
 *
 * First production use of requireMcAdmin. 401 (no session) / 403 (not mc-admin) are refused
 * BEFORE any store access, and both audit (FR-007). The setting change is audited.
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcAdmin } from '@/bff-server/role-check';
import { extractClientIp } from '@/bff-server/rate-limiter';
import { getAppSettings, setAllowSelfRegistration } from '@/bff-server/app-settings-store';
import { logger } from '@/bff-server/logger';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { AuthError, AuthErrorCode } from '@/types/errors';

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => _get(req));
}

export async function PATCH(req: Request): Promise<Response> {
  return withRequestContext(() => _patch(req));
}

async function _get(req: Request): Promise<Response> {
  const headers = Object.fromEntries(req.headers.entries());
  const ip = extractClientIp(headers);
  try {
    const { user } = await requireAuth(headers);
    requireMcAdmin(user);
    const settings = await getAppSettings();
    return Response.json(settings, { status: 200, headers: securityHeaders() });
  } catch (err) {
    return errorResponse(err, ip, 'read');
  }
}

async function _patch(req: Request): Promise<Response> {
  const headers = Object.fromEntries(req.headers.entries());
  const ip = extractClientIp(headers);
  try {
    const { user } = await requireAuth(headers);
    requireMcAdmin(user);

    const body = (await req.json().catch(() => ({}))) as { allowSelfRegistration?: unknown };
    if (typeof body.allowSelfRegistration !== 'boolean') {
      throw new AuthError(
        AuthErrorCode.INVALID_INPUT,
        'allowSelfRegistration must be a boolean',
        400,
      );
    }

    const settings = await setAllowSelfRegistration(body.allowSelfRegistration, user.id);
    logger.audit('admin_setting_changed', {
      setting: 'allowSelfRegistration',
      value: body.allowSelfRegistration,
      userId: user.id,
      ip,
    });
    return Response.json(settings, { status: 200, headers: securityHeaders() });
  } catch (err) {
    return errorResponse(err, ip, 'write');
  }
}

// Shared error mapper. A 401/403 on this admin surface is a security-relevant access-denied
// event and MUST be audited (constitution §Logging; FR-007) — requireAuth/requireMcAdmin throw
// before the handler can, so we audit here from the caught typed error.
function errorResponse(err: unknown, ip: string | null, action: 'read' | 'write'): Response {
  if (err instanceof AuthError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      logger.audit('admin_access_denied', {
        action: `admin_settings_${action}`,
        code: err.code,
        ip,
      });
    }
    return Response.json(
      { error: err.message, code: err.code },
      { status: err.statusCode, headers: securityHeaders() },
    );
  }
  logger.error('admin-settings: unhandled error', { action: 'admin_settings_error', error: err });
  return Response.json(
    { error: 'An unexpected error occurred.', code: AuthErrorCode.UNKNOWN },
    { status: 500, headers: securityHeaders() },
  );
}
