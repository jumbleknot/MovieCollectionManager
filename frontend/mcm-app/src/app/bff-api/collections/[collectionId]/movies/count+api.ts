/**
 * BFF /bff-api/collections/[collectionId]/movies/count route (013 US2 / T023)
 *
 * GET /bff-api/collections/:id/movies/count → total movie count for the collection,
 * honouring the same filter params as the list route (order/page independent).
 *
 * Standard protected proxy (identical to the sibling movie routes):
 *   1. requireAuth (401 if missing/invalid)
 *   2. requireMcUser (403 if not mc-user / mc-admin)
 *   3. forward the filter query params to mc-service GET …/movies/count
 *   4. return { count } unchanged; errors via handleMcApiError
 *
 * Forwards the filter params only — cursor/sortBy/sortDir are irrelevant to a count.
 *
 * NOTE (Expo Router shadowing): in practice this file is NOT the handler that serves
 * `…/movies/count` — the sibling dynamic `[movieId]+api.ts` catches the `count` segment
 * (movieId="count") first, exactly as it does for `…/movies/filter-options`. That route
 * forwards the same filter query params to the same upstream `/movies/count` path (mc-service
 * static-routes it to the count handler), so the behaviour is identical. This file is kept as
 * the declared route contract + route-coverage home; the live filter-forwarding lives in
 * `[movieId]+api.ts` GET.
 */

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { validateObjectId } from '@/bff-server/resource-id';

// ─── Filter query params forwarded for the count (no cursor/sort — count is order-free) ──

const COUNT_QUERY_PARAMS = [
  'search', 'contentType', 'genre', 'childrens', 'rated',
  'language', 'decade', 'owned', 'ownedMedia', 'ripped', 'ripQuality',
] as const;

// ─── GET /bff-api/collections/:id/movies/count ────────────────────────────────

export async function GET(req: Request, { collectionId }: { collectionId: string }): Promise<Response> {
  return withRequestContext(() => _get(req, collectionId));
}

async function _get(req: Request, collectionId: string): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);
    validateObjectId(collectionId, 'collectionId');
    const jwt = extractRawToken(headers)!;
    const client = createMcServiceClient(jwt);

    const url = new URL(req.url);
    const queryParams: Record<string, string | string[]> = {};
    for (const key of COUNT_QUERY_PARAMS) {
      const all = url.searchParams.getAll(key);
      if (all.length === 1) queryParams[key] = all[0];
      else if (all.length > 1) queryParams[key] = all;
    }

    const { status, data } = await client.get(
      `/api/v1/collections/${collectionId}/movies/count`,
      { params: queryParams },
    );
    return Response.json(data, { status, headers: securityHeaders() });
  } catch (err) {
    return handleMcApiError(err, 'movies_count');
  }
}
