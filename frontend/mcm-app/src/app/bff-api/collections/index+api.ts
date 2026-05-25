/**
 * BFF /bff-api/collections route (T050)
 *
 * GET  /bff-api/collections → list all collections for the authenticated user
 * POST /bff-api/collections → create a new collection
 *
 * Both handlers:
 *   1. Validate the JWT via requireAuth (throws UnauthorizedError if missing/invalid)
 *   2. Extract the raw JWT string via extractRawToken (safe after requireAuth validates)
 *   3. Forward the request to mc-service via createMcServiceClient(jwt)
 *   4. Return the mc-service response (status + body) to the client
 *   5. Propagate mc-service error responses (RFC 9457) unchanged
 */

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';

// ─── GET /bff-api/collections ──────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  return withRequestContext(() => _get(req));
}

async function _get(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status, data } = await client.get('/api/v1/collections');
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'collections_list');
  }
}

// ─── POST /bff-api/collections ─────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => _post(req));
}

async function _post(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const body = await req.json();
    const { status, data } = await client.post('/api/v1/collections', body);
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'collections_create');
  }
}
