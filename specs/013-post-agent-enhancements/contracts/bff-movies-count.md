# Contract: BFF movie count route (new)

**Endpoint (new)**: `GET /bff-api/collections/{collectionId}/movies/count`
**Proxies**: mc-service `GET /api/v1/collections/{collectionId}/movies/count` (existing).

## Auth / pattern

Standard BFF protected proxy (identical to the sibling movie routes):

```
const { user } = await requireAuth(headers);
requireMcUser(user);                 // 403 if not mc-user / mc-admin
const jwt = extractRawToken(headers)!;
const client = createMcServiceClient(jwt);
// GET …/movies/count?<forwarded filter params>
catch (err) { return handleMcApiError(err, 'movies_count'); }
```

- Joins the BFF protected-route set and the `route-coverage-map` (a justified test/exclusion entry is required, like every `+api.ts`).
- Not an agent route — no `/ui-action` involvement.

## Request

Forwards the same filter query params as the list route (`search, contentType, genre, childrens, rated, language, decade, owned, ownedMedia, ripped, ripQuality`). Ignores `cursor`, `sortBy`, `sortDir` (count is order/page independent).

## Response

```
200 { "count": <number> }                    // honours the forwarded filter
4xx application/problem+json (via handleMcApiError; warn-logged)
```

## Frontend usage (count info line)

- **Numerator (filtered)**: count request WITH the active filter params.
- **Denominator (total)**: when a filter is active, a second count request WITH NO filter params. When no filter is active, reuse the single result as the total.
- Display: `total` when unfiltered; `filtered/total` when filtered.
- Re-fetch on: list reload, movie add/edit/delete (`useFocusEffect`), and approved assistant writes (`useAssistantDataRefresh` revision bump).
