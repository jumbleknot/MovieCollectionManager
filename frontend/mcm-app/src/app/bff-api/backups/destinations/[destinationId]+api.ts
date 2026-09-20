/**
 * BFF /bff-api/backups/destinations/{destinationId} (feature 073, FR-002/003/006/034).
 *
 * GET / PATCH / DELETE, all scoped to the caller. A destination that is not this caller's
 * answers 404 — never 403 — and so does one that does not exist. The two are indistinguishable
 * on purpose: a 403 would confirm the id names something real, which turns guessing into an
 * existence oracle. The store makes that the natural outcome rather than something this handler
 * has to remember, because every query it issues is filtered by userId.
 */
import { assertDestinationUrlAllowed } from '@/bff-server/backup-destination-url-guard';
import * as store from '@/bff-server/backup-destination-store';
import {
  withBackupRoute,
  parseJsonBody,
  destinationUpdateSchema,
  firstIssue,
  json,
  problem,
  notFound,
} from '@/bff-server/backup-route-support';
import { logger } from '@/bff-server/logger';

// Expo Router hands the dynamic segment to the handler as its second argument, named after the
// file — the same seam collections/[collectionId] uses. An earlier draft re-parsed it off the
// URL, which works and is one more place to get path handling wrong.
type Params = { destinationId: string };

export async function GET(req: Request, { destinationId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_destination_get', async (userId) => {
    const found = await store.getDestination(userId, destinationId);
    return found ? json(found) : notFound();
  });
}

export async function PATCH(req: Request, { destinationId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_destination_update', async (userId) => {
    const body = await parseJsonBody(req);
    if (!body.ok) return body.response;

    // An update needs to know the existing type to validate against the right half of the
    // union, and it is also the ownership check — a foreign id stops here as a 404.
    const existing = await store.getDestination(userId, destinationId);
    if (!existing) return notFound();

    const parsed = destinationUpdateSchema.safeParse({ type: existing.type, ...(body.value as object) });
    if (!parsed.success) return problem('Invalid destination', 400, firstIssue(parsed.error));
    if (parsed.data.endpoint) await assertDestinationUrlAllowed(parsed.data.endpoint);

    const updated = await store.updateDestination(userId, destinationId, parsed.data);
    if (!updated) return notFound();
    logger.audit('backup_destination_updated', { userId, destinationId });
    return json(updated);
  });
}

export async function DELETE(req: Request, { destinationId }: Params): Promise<Response> {
  return withBackupRoute(req, 'backup_destination_delete', async (userId) => {
    const deleted = await store.deleteDestination(userId, destinationId);
    if (!deleted) return notFound();
    // Recorded because deleting a destination also DISABLES every job that used it (FR-006) —
    // a consequence the user did not ask for explicitly and may need to see later.
    logger.audit('backup_destination_deleted', { userId, destinationId });
    return new Response(null, { status: 204 });
  });
}
