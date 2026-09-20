// S3 destination driver (feature 073, FR-001/FR-004/FR-011).
//
// Speaks S3 over the pinned transport using the hand-written SigV4 signer. Only four operations
// exist here, which is the whole argument for not taking @aws-sdk/client-s3: PUT, GET, LIST,
// DELETE. No multipart, no presigning, no storage classes, no ETag semantics.
//
// Verified twice, against two independent external oracles: the signer against AWS's published
// vectors, and this driver against a real MinIO. Neither alone would be enough — vectors prove
// the algorithm but not that a server accepts it, and a server test would pass against a signer
// that was subtly wrong in a way MinIO happens to tolerate.

import { XMLParser } from 'fast-xml-parser';

import { signRequest, sha256Hex, type SigningCredentials } from '@/bff-server/backup-request-signer';
import type {
  BackupDestinationDriver,
  PinnedTransport,
  TransportResponse,
} from '@/bff-server/backup-destination-driver';
import type { BackupObjectInfo, BackupProbeOutcome, S3BackupDestination } from '@/types/backups';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_KEYS_PER_PAGE = 1000;

// `isArray` matters: a ListBucketResult with ONE object parses `Contents` as an object rather
// than an array, so a driver written against a multi-object response crashes — or worse, reads
// `.length` as undefined and reports zero — exactly when a bucket holds its first backup.
const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'Contents',
});

export function createS3Driver(
  destination: S3BackupDestination,
  secret: string,
  transport: PinnedTransport,
): BackupDestinationDriver {
  const credentials: SigningCredentials = {
    accessKeyId: destination.accessKeyId,
    secretAccessKey: secret,
    region: destination.region || 'us-east-1',
    service: 's3',
  };

  // Path-style (`/bucket/key`) rather than virtual-host style. MinIO and most self-hosted stores
  // need it, and a bucket name containing a dot breaks virtual-host style under TLS anyway.
  const bucketPath = destination.pathStyle === false ? '' : `/${destination.bucket}`;
  const objectPath = (key: string) => `${bucketPath}/${key}`;

  async function send(
    method: string,
    path: string,
    query: string,
    body?: Buffer,
    contentType?: string,
  ): Promise<TransportResponse> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const headers: [string, string][] = [['host', hostHeader()]];
    if (body) headers.push(['content-length', String(body.byteLength)]);
    if (contentType) headers.push(['content-type', contentType]);

    const signed = signRequest({ method, path, query, headers, payloadHash }, credentials);
    // Send EXACTLY the headers that were signed. Adding one afterwards at the transport layer is
    // the classic way to produce a request whose signature covers a different header set than
    // the one on the wire, and S3 reports that as an opaque SignatureDoesNotMatch.
    return transport.request({ method, path, query, headers: signed.headers, body });
  }

  function hostHeader(): string {
    const { hostname, port, protocol } = transport.vetted;
    const isDefaultPort = (protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80);
    return isDefaultPort ? hostname : `${hostname}:${port}`;
  }

  /** The S3 error <Code> if the body is an S3 error document, else null. Never returned to a user. */
  function errorCode(res: TransportResponse): string | null {
    const text = res.body.toString('utf8');
    if (!text.includes('<Error>')) return null;
    const parsed = parser.parse(text) as { Error?: { Code?: string } };
    return parsed.Error?.Code ?? null;
  }

  function failFor(operation: string, res: TransportResponse): Error {
    // The upstream body is deliberately NOT included. An S3 error document can echo the request,
    // including query parameters, and this message reaches logs and user-facing failure reasons.
    const code = errorCode(res);
    return new Error(`S3 ${operation} failed: HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }

  return {
    async put(key, body, contentType = 'application/gzip') {
      const res = await send('PUT', objectPath(key), '', body, contentType);
      if (res.status < 200 || res.status >= 300) throw failFor('PUT', res);
    },

    async get(key) {
      const res = await send('GET', objectPath(key), '');
      if (res.status < 200 || res.status >= 300) throw failFor('GET', res);
      return res.body;
    },

    async list(prefix, pageSize = MAX_KEYS_PER_PAGE) {
      const objects: BackupObjectInfo[] = [];
      let continuationToken: string | undefined;

      // Pages until S3 says there is no more. Reading only the first page silently under-reports
      // once a prefix passes the page limit — retention would then never prune below it while
      // reporting success, which is a data-loss-shaped bug wearing a green tick.
      do {
        const params = [
          'list-type=2',
          `max-keys=${pageSize}`,
          `prefix=${encodeURIComponent(prefix)}`,
        ];
        if (continuationToken) {
          params.push(`continuation-token=${encodeURIComponent(continuationToken)}`);
        }
        // The signer re-orders the query canonically; the order here is only the wire order.
        const query = params.join('&');
        const res = await send('GET', bucketPath || '/', query);
        if (res.status < 200 || res.status >= 300) throw failFor('LIST', res);

        const parsed = parser.parse(res.body.toString('utf8')) as {
          ListBucketResult?: {
            Contents?: { Key?: string; Size?: number; LastModified?: string }[];
            IsTruncated?: boolean | string;
            NextContinuationToken?: string;
          };
        };
        const result = parsed.ListBucketResult ?? {};
        for (const entry of result.Contents ?? []) {
          if (!entry.Key) continue;
          objects.push({
            key: String(entry.Key),
            sizeBytes: Number(entry.Size ?? 0),
            lastModified: String(entry.LastModified ?? ''),
          });
        }
        const truncated = result.IsTruncated === true || result.IsTruncated === 'true';
        continuationToken = truncated ? result.NextContinuationToken : undefined;
      } while (continuationToken);

      // S3 returns keys in lexicographic order already; sorting is cheap insurance so the
      // retention rule ("delete the tail") never depends on a server's goodwill.
      return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },

    async delete(key) {
      const res = await send('DELETE', objectPath(key), '');
      // S3 answers 204 for a delete, and 204 for deleting something that was not there.
      if (res.status < 200 || res.status >= 300) throw failFor('DELETE', res);
    },

    async testConnection(): Promise<BackupProbeOutcome> {
      // FR-004 wants the three failures told apart, because they have three different fixes:
      // fix the address, fix the credential, or grant permission. "It didn't work" sends a user
      // to re-enter a credential that was correct.
      let res: TransportResponse;
      try {
        res = await send('GET', bucketPath || '/', 'list-type=2&max-keys=1');
      } catch {
        // A transport-level throw is a connection failure: refused, DNS, TLS, or timeout. The
        // underlying message can carry an address or a certificate subject, so it is not echoed.
        return { ok: false, failure: 'unreachable', reason: 'Could not reach that address' };
      }

      const code = errorCode(res);
      if (res.status === 403) {
        if (code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId') {
          return { ok: false, failure: 'credentials-rejected', reason: 'Those credentials were rejected' };
        }
        return {
          ok: false,
          failure: 'no-write-permission',
          reason: 'Those credentials are valid but not permitted to use that bucket',
        };
      }
      if (res.status === 404 || code === 'NoSuchBucket') {
        return {
          ok: false,
          failure: 'no-write-permission',
          reason: 'That bucket does not exist, or those credentials cannot see it',
        };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, failure: 'unreachable', reason: `That destination answered HTTP ${res.status}` };
      }

      // Reading proves the credential and the bucket. It does NOT prove the credential may
      // WRITE, and a read-only key that passes a probe and then fails every backup is precisely
      // the outcome FR-004 exists to prevent. So write a probe object and remove it.
      const probeKey = `${destination.basePath || 'mcm-backups'}/.mcm-write-probe`;
      try {
        const write = await send('PUT', objectPath(probeKey), '', Buffer.alloc(0), 'application/octet-stream');
        if (write.status === 403) {
          return {
            ok: false,
            failure: 'no-write-permission',
            reason: 'Those credentials can read that bucket but cannot write to it',
          };
        }
        if (write.status < 200 || write.status >= 300) {
          return { ok: false, failure: 'no-write-permission', reason: `A test write answered HTTP ${write.status}` };
        }
      } catch {
        return { ok: false, failure: 'unreachable', reason: 'Could not reach that address' };
      }

      // Best-effort cleanup. A probe object left behind is untidy but harmless, and failing the
      // probe over it would report a working destination as broken.
      try {
        await send('DELETE', objectPath(probeKey), '');
      } catch {
        /* ignore */
      }
      return { ok: true };
    },
  };
}
