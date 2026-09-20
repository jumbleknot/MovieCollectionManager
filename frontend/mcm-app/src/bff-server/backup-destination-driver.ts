// The backup destination driver interface, its pinned transport, and the factory (feature 073,
// FR-001; research.md §R5).
//
// THIS INTERFACE IS WHAT CONTAINS THE SigV4 DECISION. If the operator later prefers
// @aws-sdk/client-s3, only backup-request-signer.ts and backup-driver-s3.ts change; nothing above
// this line knows that S3 is signed by hand. So it is kept free of S3-shaped assumptions: no
// `bucket` in any signature, no ETag, no multipart, no storage class. A WebDAV server must be
// able to answer every method honestly, and it can.
//
// THE GUARD IS NOT SOMETHING A DRIVER CAN FORGET. A driver never receives a URL — it receives a
// `PinnedTransport` that the factory built by running the resolving guard and pinning the socket
// to the vetted address. There is no code path from a destination document to a socket that
// skips the check, which is a stronger statement than "every driver remembers to call it".

import * as http from 'node:http';
import * as https from 'node:https';

import {
  assertDestinationUrlAllowed,
  createPinnedAgent,
  DestinationUrlNotAllowedError,
  type DestinationLookup,
  type VettedDestination,
} from '@/bff-server/backup-destination-url-guard';
import type {
  BackupDestination,
  BackupObjectInfo,
  BackupProbeOutcome,
} from '@/types/backups';
// STATIC imports, deliberately. `await import()` here read as the tidier way to keep the two
// drivers out of each other's way, and it fails under Jest's CJS runtime with "A dynamic import
// callback was invoked without --experimental-vm-modules" — the same trap mongo-client.ts
// documents at length for the mongodb driver's os adapter. The fix there and here is the same:
// make the dependency static and honest rather than turning on experimental module handling for
// the whole suite. The drivers import only TYPES from this module, so the cycle is erased at
// compile time.
import { createS3Driver } from '@/bff-server/backup-driver-s3';
import { createWebdavDriver } from '@/bff-server/backup-driver-webdav';

/** How long any single request to a destination may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface TransportRequest {
  method: string;
  /** Path relative to the destination origin, un-encoded. */
  path: string;
  /** Raw query string without the leading `?`. */
  query?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface PinnedTransport {
  /** The vetted destination, so a driver can sign against the right host without re-parsing. */
  readonly vetted: VettedDestination;
  request(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * The four operations, and nothing S3-specific.
 *
 * `put` takes the whole body as one buffer rather than a stream. That follows the feature's
 * ratified size-ceiling decision: an artifact too large to hold is a loud failure, not something
 * to stream and hope about. See backup-runner's ceiling.
 */
export interface BackupDestinationDriver {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /**
   * Lexicographic by key. ISO-8601 timestamps in the key make that chronological.
   *
   * `pageSize` exists so paging can be PROVEN without writing a thousand objects: a driver that
   * reads only the first page is indistinguishable from a correct one until a prefix passes the
   * server's page limit, at which point retention silently stops pruning. Drivers whose protocol
   * has no paging (WebDAV PROPFIND returns everything) ignore it.
   */
  list(prefix: string, pageSize?: number): Promise<BackupObjectInfo[]>;
  delete(key: string): Promise<void>;
  /**
   * Distinguishes unreachable from credentials-rejected from authenticated-but-cannot-write
   * (FR-004). "It didn't work" is not an actionable answer: the three have three different fixes.
   */
  testConnection(): Promise<BackupProbeOutcome>;
}

// ─── Pinned transport ──────────────────────────────────────────────────────────

/**
 * Build a transport whose socket can only reach the vetted address.
 *
 * `redirect: manual` in spirit — redirects are NEVER followed. A 30x is returned to the caller as
 * a 30x. Following one would take the request to a URL that never passed the guard, which is the
 * exact bypass the guard exists to prevent, and it is the reason agent-config-probes.ts sets the
 * same policy.
 */
export function createPinnedTransport(vetted: VettedDestination): PinnedTransport {
  const agent = createPinnedAgent(vetted);
  const client = vetted.protocol === 'https:' ? https : http;

  return {
    vetted,
    request(req: TransportRequest): Promise<TransportResponse> {
      return new Promise((resolve, reject) => {
        const path = `${encodePath(req.path)}${req.query ? `?${req.query}` : ''}`;
        const request = client.request(
          {
            // The HOSTNAME, not the address: TLS SNI and certificate verification must see the
            // name the certificate was issued for. The agent's pinned lookup is what sends the
            // socket to the vetted address.
            host: vetted.hostname,
            port: vetted.port,
            method: req.method,
            path,
            headers: req.headers,
            agent,
            timeout: REQUEST_TIMEOUT_MS,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        request.on('timeout', () => request.destroy(new Error('destination request timed out')));
        request.on('error', reject);
        if (req.body) request.write(req.body);
        request.end();
      });
    },
  };
}

/** Encode each path segment, leave the separators. Same rule the signer's canonical URI uses. */
function encodePath(path: string): string {
  return (path.startsWith('/') ? path : `/${path}`)
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export interface DriverOptions {
  /** Resolver seam, so a test can drive the guard without a real DNS record. */
  lookup?: DestinationLookup;
}

/**
 * Build the driver for a destination, running the resolving guard first.
 *
 * `secret` is the DECRYPTED credential, held only for the life of this driver. The caller decrypts
 * it under `backupSecretAad(userId, destinationId)`; the store never holds plaintext and neither
 * does this module beyond the closure it lives in.
 *
 * This is the ONLY place a destination document becomes something that can open a socket, and
 * `type` is switched on HERE and nowhere else — the point of the interface is that no code
 * downstream needs to know which kind it has.
 */
export async function createBackupDriver(
  destination: BackupDestination,
  secret: string,
  options: DriverOptions = {},
): Promise<BackupDestinationDriver> {
  const vetted = await assertDestinationUrlAllowed(destination.endpoint, { lookup: options.lookup });
  const transport = createPinnedTransport(vetted);

  switch (destination.type) {
    case 's3':
      return createS3Driver(destination, secret, transport);
    case 'webdav':
      return createWebdavDriver(destination, secret, transport);
  }
}

export { DestinationUrlNotAllowedError };
