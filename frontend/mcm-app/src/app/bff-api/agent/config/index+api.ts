/**
 * BFF /bff-api/agent/config route (feature 018).
 *
 * GET    → non-secret view of the caller's assistant config (FR-011/018). Never a secret.
 * PUT    → validate-on-save + encrypt + upsert (FR-012/013) — added in US2 (T026).
 * DELETE → clear: disable + wipe secrets, keep non-secret settings (FR-016, R9) + audit.
 *
 * Auth is enforced per-handler (requireAuth → requireMcUser); the owning userId comes from
 * the validated session, NEVER the request body (FR-017). Registered in the AGENT_ROUTES
 * allowlist (route-coverage auth test).
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { logger } from '@/bff-server/logger';
import * as service from '@/bff-server/agent-config-service';

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => _get(req));
}

async function _get(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const view = await service.getNonSecretView(user.id);
    return Response.json(view, { status: 200, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'agent_config_get');
  }
}

export async function DELETE(req: Request): Promise<Response> {
  return withRequestContext(() => _delete(req));
}

async function _delete(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const view = await service.clear(user.id);
    logger.audit('assistant_config_cleared', { userId: user.id });
    return Response.json(view, { status: 200, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'agent_config_clear');
  }
}
