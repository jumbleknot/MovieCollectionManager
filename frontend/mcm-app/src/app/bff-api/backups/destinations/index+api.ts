/**
 * BFF /bff-api/backups/destinations (feature 073, FR-001..FR-006, FR-034).
 *
 * GET  → this caller's destinations. Never a secret: the STORE's read projection excludes it,
 *        so this handler could not leak one even by returning the document wholesale.
 * POST → create. Body is a zod DISCRIMINATED union on `type`, so an s3 destination cannot carry
 *        a username. The address passes the resolving guard before anything is stored, because
 *        a destination that could never be written to is not worth persisting.
 *
 * Auth is the shared requireAuth → requireMcUser sequence inside `withBackupRoute`, and the
 * owning userId is the one it yields — there is no path, query or body parameter for it
 * anywhere in this feature's contract.
 */
import { assertDestinationUrlAllowed } from '@/bff-server/backup-destination-url-guard';
import * as store from '@/bff-server/backup-destination-store';
import {
  withBackupRoute,
  parseJsonBody,
  destinationCreateSchema,
  firstIssue,
  json,
  problem,
} from '@/bff-server/backup-route-support';
import { logger } from '@/bff-server/logger';

export async function GET(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_destination_list', async (userId) =>
    json(await store.listDestinations(userId)),
  );
}

export async function POST(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_destination_create', async (userId) => {
    const body = await parseJsonBody(req);
    if (!body.ok) return body.response;

    const parsed = destinationCreateSchema.safeParse(body.value);
    if (!parsed.success) return problem('Invalid destination', 400, firstIssue(parsed.error));

    // Guard on SAVE as well as on every use. Storing an address that is refused at write time
    // would hand the user a destination that looks configured and fails at 3am.
    await assertDestinationUrlAllowed(parsed.data.endpoint);

    const created = await store.createDestination(userId, parsed.data);
    logger.audit('backup_destination_created', {
      userId,
      destinationId: created.id,
      destinationType: created.type,
    });
    return json(created, 201);
  });
}
