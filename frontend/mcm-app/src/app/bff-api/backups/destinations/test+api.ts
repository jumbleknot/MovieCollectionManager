/**
 * BFF /bff-api/backups/destinations/test (feature 073, FR-004).
 *
 * A server-side probe of reachability, credentials and write permission, reporting WHICH of the
 * three failed. Accepts either a saved destinationId or an unsaved draft, so a user can verify
 * before committing a credential — and so re-testing a saved destination does not require
 * resending a secret they no longer have, because it is never returned to them.
 *
 * THE GUARD RUNS HERE TOO. It is enforced by `createBackupDriver`, which cannot be reached
 * without it. Without that, this route would be a general-purpose "make my server fetch this
 * URL" primitive sitting next to the save path that carefully refuses one — strictly more
 * useful to an attacker than the thing it guards.
 *
 * Outcomes are NORMALISED: `{ ok }` plus a safe reason, never the upstream body. An S3 error
 * document echoes the request and a WebDAV one can carry the auth realm, and this response goes
 * to the browser and into the destination document.
 *
 * Note this route is `destinations/test+api.ts` and sits beside `[destinationId]+api.ts`. Expo
 * Router resolves the static segment first, so `/destinations/test` is never read as a
 * destination whose id is "test".
 */
import { createBackupDriver } from '@/bff-server/backup-destination-driver';
import * as store from '@/bff-server/backup-destination-store';
import {
  withBackupRoute,
  parseJsonBody,
  destinationProbeSchema,
  firstIssue,
  json,
  problem,
  notFound,
} from '@/bff-server/backup-route-support';
import { logger } from '@/bff-server/logger';
import type { BackupDestination, BackupTestResult } from '@/types/backups';

export async function POST(req: Request): Promise<Response> {
  return withBackupRoute(req, 'backup_destination_test', async (userId) => {
    const body = await parseJsonBody(req);
    if (!body.ok) return body.response;

    const parsed = destinationProbeSchema.safeParse(body.value);
    if (!parsed.success) return problem('Invalid destination', 400, firstIssue(parsed.error));

    let destination: BackupDestination;
    let secret: string;
    let savedId: string | null = null;

    if ('destinationId' in parsed.data) {
      const saved = await store.getDestination(userId, parsed.data.destinationId);
      // 404 for a foreign id exactly as the other routes do — the probe must not become the one
      // place where a wrong id is answered differently.
      if (!saved) return notFound();
      const storedSecret = await store.getDestinationSecret(userId, parsed.data.destinationId);
      if (storedSecret === null) {
        return json({ ok: false, reason: 'No credential is stored for that destination' });
      }
      savedId = saved.id;
      secret = storedSecret;
      destination = { ...saved, _id: saved.id, userId } as unknown as BackupDestination;
    } else {
      const draft = parsed.data;
      secret = draft.secret;
      destination = {
        ...draft,
        _id: 'draft',
        userId,
        basePath: draft.basePath || 'mcm-backups',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as BackupDestination;
    }

    // Throws DestinationUrlNotAllowedError for a blocked address, which withBackupRoute turns
    // into a 400 — deliberately NOT an `{ ok: false }` probe result. A refused address is a
    // rejected request, not a destination that happens to be down.
    const driver = await createBackupDriver(destination, secret);
    const outcome = await driver.testConnection();

    const result: BackupTestResult = outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason ?? 'That destination could not be verified' };
    if (savedId) await store.recordTestResult(userId, savedId, result);

    // The FAILURE CLASS is logged, never the reason string and never the endpoint: the class is
    // what makes a support question answerable, and the other two are where a credential or an
    // internal address would leak into a log.
    logger.audit('backup_destination_tested', {
      userId,
      destinationId: savedId ?? 'draft',
      outcome: outcome.ok ? 'ok' : (outcome.failure ?? 'failed'),
    });
    return json(result);
  });
}
