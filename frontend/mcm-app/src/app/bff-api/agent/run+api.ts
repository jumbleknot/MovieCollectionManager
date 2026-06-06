/**
 * BFF /bff-api/agent/run route (T028).
 *
 * Secure AG-UI PROXY (constitution: the BFF is a proxy, NOT a translator). It:
 *   1. Validates the JWT via requireAuth (401 UNAUTHORIZED if missing/invalid)
 *   2. Enforces RBAC via requireMcUser (403 FORBIDDEN if lacking mc-user/mc-admin)
 *   3. Forwards the AG-UI request to the Agent Gateway and streams the AG-UI response
 *      back UNCHANGED — no event-shape transformation.
 *
 * The gateway and agent-db are private-network only; this route is the sole ingress.
 * Auth is per-handler (requireAuth/requireMcUser) consistent with all existing BFF
 * routes — see T028a (agent-route-auth.integration.test.ts), the compensating control
 * for the documented Expo-Router middleware-gap deviation.
 *
 * TODO(T023): mint a run-scoped RFC 8693 subject token and forward it to the gateway.
 *   Not required yet for transport: the current supervisor graph makes no backend tool
 *   calls, so no downscoped token is needed until movie-mcp writes land (US1).
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';

const GATEWAY_URL = process.env.AGENT_GATEWAY_URL ?? 'http://localhost:8123';
const AGENT_PATH = '/agent/movie-assistant';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

async function _post(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);

    const body = await req.text();
    const upstream = await fetch(`${GATEWAY_URL}${AGENT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': req.headers.get('content-type') ?? 'application/json' },
      body,
    });

    // Stream the gateway's native AG-UI response straight through — no translation.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...securityHeaders(),
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      },
    });
  } catch (err) {
    return handleMcApiError(err, 'agent_run');
  }
}
