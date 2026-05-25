/**
 * BFF /bff-api/collections/[collectionId]/movies/filter-options route (T121)
 *
 * GET /bff-api/collections/:id/movies/filter-options → proxy to mc-service filter-options
 *
 * Handler:
 *   1. Validate the JWT via requireAuth (throws UnauthorizedError if missing/invalid)
 *   2. Extract the raw JWT string via extractRawToken (safe after requireAuth validates)
 *   3. Forward the request to mc-service via createMcServiceClient(jwt)
 *   4. Return the mc-service response (FilterOptionsDto) to the client
 *   5. Propagate mc-service error responses (RFC 9457) unchanged
 *
 * Response shape (FilterOptionsDto):
 *   { genres, contentTypes, rated, languages, decades, ownedMedia, ripQuality }
 */

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';

// ─── GET /bff-api/collections/:id/movies/filter-options ───────────────────────

export async function GET(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _get(req, collectionId));
}

async function _get(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const { status, data } = await client.get(
      `/api/v1/collections/${collectionId}/movies/filter-options`,
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'movie_filter_options');
  }
}
