/**
 * BFF /bff-api/agent/config/test route (feature 018, US3).
 *
 * POST → re-probe the caller's already-stored, server-decrypted credentials (FR-013/015) and
 * return a per-credential status map (`{ ollama: "ok", tmdb: { reason } }`). No request body,
 * no secret entered, no secret returned (FR-018). 409 when there is nothing on file to test.
 *
 * Auth is enforced per-handler (requireAuth → requireMcUser); the owning userId comes from the
 * validated session, NEVER the request body (FR-017). Registered in the AGENT_ROUTES allowlist.
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { logger } from '@/bff-server/logger';
import * as service from '@/bff-server/agent-config-service';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

async function _post(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);

    const result = await service.testStored(user.id);
    if (!result.ok) {
      return Response.json(
        { type: 'about:blank', title: 'No stored credentials to test', status: result.status },
        { status: result.status, headers: securityHeaders() },
      );
    }
    logger.audit('assistant_config_tested', { userId: user.id });
    return Response.json(result.results, { status: 200, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'agent_config_test');
  }
}
