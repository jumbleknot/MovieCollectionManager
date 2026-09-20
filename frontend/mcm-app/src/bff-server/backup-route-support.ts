// Shared request-handling support for the backups routes (feature 073).
//
// WHY THIS EXISTS. Every backups route repeats the same four steps: enter the request context,
// authenticate, authorise, parse. Repeating them by hand in a dozen handlers is how one of them
// eventually ships without the authorisation line — and a handler missing that line looks
// exactly like the others. So the sequence lives here once and a route cannot express itself
// without it: `withBackupRoute` takes a body that only ever receives an ALREADY-AUTHENTICATED
// user id. There is no way to write a handler that forgot.
//
// This is the same requireAuth → requireMcUser pair the rest of the BFF uses; what is different
// is that opting out is not expressible rather than merely discouraged.

import { z } from 'zod';

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { securityHeaders } from '@/bff-server/security-headers';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { BackupDestinationInputError } from '@/bff-server/backup-destination-store';
import { BackupJobInputError } from '@/bff-server/backup-job-store';
import { DestinationUrlNotAllowedError } from '@/bff-server/backup-destination-url-guard';

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: securityHeaders() });

/** RFC 9457-shaped, matching what the rest of the BFF returns. Never carries an upstream body. */
export const problem = (title: string, status: number, detail?: string): Response =>
  Response.json(
    { type: 'about:blank', title, status, ...(detail ? { detail } : {}) },
    { status, headers: securityHeaders() },
  );

/**
 * 404 for "not yours" as well as "not there" (FR-034).
 *
 * A 403 would confirm the resource exists, and that confirmation IS the leak: it turns guessing
 * an id into an existence oracle. The two cases must be indistinguishable from outside, which
 * is why the store filters by userId rather than reading and then comparing.
 */
export const notFound = (): Response => problem('Not found', 404);

/**
 * What a handler body is given, and the only identity it has.
 *
 * `jwt` is the caller's own token, carried so that reads and writes against mc-service happen
 * AS THEM — this feature never acts with a service identity, so DAC, validation and audit
 * apply to a backup exactly as they do to any other request the user makes.
 */
export interface BackupRouteContext {
  userId: string;
  jwt: string;
}

export async function withBackupRoute(
  req: Request,
  action: string,
  body: (ctx: BackupRouteContext) => Promise<Response>,
): Promise<Response> {
  return withRequestContext(async () => {
    try {
      const headers = Object.fromEntries(req.headers.entries());
      const { user } = await requireAuth(headers);
      requireMcUser(user);
      // The ONLY identity any handler ever sees. Nothing downstream can read a userId from the
      // path, the query or the body, because nothing downstream is given one.
      return await body({ userId: user.id, jwt: extractRawToken(headers)! });
    } catch (err) {
      if (err instanceof BackupDestinationInputError) return problem('Invalid destination', 400, err.message);
      if (err instanceof BackupJobInputError) return problem('Invalid backup job', 400, err.message);
      if (err instanceof DestinationUrlNotAllowedError) return problem('Address not allowed', 400, err.reason);
      return handleMcApiError(err, action);
    }
  });
}

/** Parse a JSON body, returning a 400 rather than throwing on malformed input. */
export async function parseJsonBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false, response: problem('Malformed request body', 400) };
  }
}

// ─── Destination schemas ───────────────────────────────────────────────────────
//
// A DISCRIMINATED union on `type`, so an `s3` body cannot carry a `username` and a `webdav` body
// cannot carry a `bucket`. `.strict()` is what makes that true rather than merely stated: without
// it, an unknown key is silently dropped and the two shapes become interchangeable in practice.
// It is also what makes a spoofed `userId` in the body a 400 rather than something quietly
// ignored — being explicit about rejecting it is better than relying on it being unread.

const label = z.string().trim().min(1).max(64);
const endpoint = z.string().trim().url();
const basePath = z.string().trim().max(256).optional();
// A secret is write-only and, when present, must be non-empty: an empty string is REJECTED
// rather than treated as "clear the stored one", because silently blanking a credential is
// indistinguishable from a UI bug that dropped the field.
const secret = z.string().min(1, 'A destination secret cannot be empty');

const s3Fields = {
  type: z.literal('s3'),
  label,
  endpoint,
  basePath,
  bucket: z.string().trim().min(1),
  region: z.string().trim().min(1).default('us-east-1'),
  pathStyle: z.boolean().default(true),
  accessKeyId: z.string().trim().min(1),
};

const webdavFields = {
  type: z.literal('webdav'),
  label,
  endpoint,
  basePath,
  username: z.string().trim().min(1),
};

export const destinationCreateSchema = z.discriminatedUnion('type', [
  z.object({ ...s3Fields, secret }).strict(),
  z.object({ ...webdavFields, secret }).strict(),
]);

// On update every field is optional — an omitted field is PRESERVED (FR-003) — but `type` stays
// required so the union still discriminates and an s3 destination cannot be patched into
// carrying webdav fields.
export const destinationUpdateSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('s3'),
      label: label.optional(),
      endpoint: endpoint.optional(),
      basePath,
      bucket: z.string().trim().min(1).optional(),
      region: z.string().trim().min(1).optional(),
      pathStyle: z.boolean().optional(),
      accessKeyId: z.string().trim().min(1).optional(),
      secret: secret.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('webdav'),
      label: label.optional(),
      endpoint: endpoint.optional(),
      basePath,
      username: z.string().trim().min(1).optional(),
      secret: secret.optional(),
    })
    .strict(),
]);

/** The probe accepts a saved id OR an unsaved draft, so a user verifies BEFORE committing. */
export const destinationProbeSchema = z.union([
  z.object({ destinationId: z.string().min(1) }).strict(),
  destinationCreateSchema,
]);

export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request body';
}

// ─── Job schemas ───────────────────────────────────────────────────────────────

const iana = z.string().trim().min(1).refine(
  (zone) => {
    // Validated against the RUNTIME's zone list rather than a hard-coded set: an unknown zone
    // accepted here becomes a job that throws on every schedule computation, for ever, and the
    // error surfaces nowhere near the form that accepted it.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown time zone' },
);

export const scheduleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    timeZone: iana,
  })
  .strict();

export const jobCreateSchema = z
  .object({
    destinationId: z.string().min(1),
    label: z.string().trim().min(1).max(64),
    collectionIds: z.array(z.string().min(1)).default([]),
    keepLast: z.number().int().min(1).max(365).default(7),
    enabled: z.boolean().default(true),
    schedule: scheduleSchema.optional(),
  })
  .strict();

export const jobUpdateSchema = z
  .object({
    destinationId: z.string().min(1).optional(),
    label: z.string().trim().min(1).max(64).optional(),
    collectionIds: z.array(z.string().min(1)).optional(),
    keepLast: z.number().int().min(1).max(365).optional(),
    enabled: z.boolean().optional(),
    schedule: scheduleSchema.nullable().optional(),
  })
  .strict();
