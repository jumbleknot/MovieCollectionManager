// WebDAV destination driver (feature 073, FR-001/FR-004/FR-011).
//
// The same four operations as the S3 driver, behind the same interface, over plain HTTP verbs:
// PUT, GET, PROPFIND, DELETE. Two differences from S3 are structural rather than cosmetic and
// are handled here so nothing above the interface has to know which kind it has:
//
//   1. A WebDAV path is a TREE, not a flat key space. PUT does not create parent collections; it
//      answers 409 Conflict. So a put walks the path and MKCOLs what is missing. Assuming S3
//      semantics produces a driver that fails on the first backup to a fresh server and works
//      ever after — the worst possible distribution for that bug.
//
//   2. PROPFIND returns XML whose shape varies by server: the DAV namespace may be prefixed
//      `D:`, `d:` or not at all, and `href` may be absolute or path-only. The parser below is
//      written against those variations rather than against one server's output, and the suite
//      that proves it runs against a real server for exactly that reason.

import { XMLParser } from 'fast-xml-parser';

import type {
  BackupDestinationDriver,
  PinnedTransport,
  TransportResponse,
} from '@/bff-server/backup-destination-driver';
import type {
  BackupObjectInfo,
  BackupProbeOutcome,
  WebdavBackupDestination,
} from '@/types/backups';

// `removeNSPrefix` is what makes this parser work against more than one server: it strips the
// `D:` / `d:` / `lp1:` namespace prefixes so `D:response` and `response` read identically.
const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (name) => name === 'response' || name === 'propstat',
});

interface PropfindEntry {
  href?: string;
  propstat?: {
    prop?: {
      getcontentlength?: number | string;
      getlastmodified?: string;
      resourcetype?: { collection?: unknown } | '' | null;
    };
  }[];
}

export function createWebdavDriver(
  destination: WebdavBackupDestination,
  secret: string,
  transport: PinnedTransport,
): BackupDestinationDriver {
  const authorization = `Basic ${Buffer.from(`${destination.username}:${secret}`).toString('base64')}`;

  // The endpoint may itself carry a path (`https://nas/remote.php/dav/files/me`), so keys hang
  // off it rather than off the origin.
  const rootPath = new URL(destination.endpoint).pathname.replace(/\/+$/, '');
  const pathFor = (key: string) => `${rootPath}/${key.replace(/^\/+/, '')}`;

  async function send(
    method: string,
    path: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<TransportResponse> {
    const headers: Record<string, string> = { authorization, ...extraHeaders };
    if (body) headers['content-length'] = String(body.byteLength);
    return transport.request({ method, path, headers, body });
  }

  const ok = (res: TransportResponse) => res.status >= 200 && res.status < 300;

  function failFor(operation: string, res: TransportResponse): Error {
    // No upstream body: a WebDAV error document can echo the request path and, on some servers,
    // the Authorization realm. This message reaches logs and user-facing failure reasons.
    return new Error(`WebDAV ${operation} failed: HTTP ${res.status}`);
  }

  /**
   * Create every missing collection along a key's path.
   *
   * MKCOL on an existing collection answers 405, which is success for our purposes — the
   * collection is there. Treating 405 as an error would make every backup after the first fail.
   */
  async function ensureCollections(key: string): Promise<void> {
    const segments = key.replace(/^\/+/, '').split('/');
    segments.pop(); // the object itself, not a collection
    let walked = rootPath;
    for (const segment of segments) {
      walked = `${walked}/${segment}`;
      const res = await send('MKCOL', walked);
      if (ok(res) || res.status === 405) continue;
      // 409 here means a parent is still missing, which cannot happen walking top-down; anything
      // else is a real failure and is better reported now than as a confusing PUT 409 later.
      throw failFor('MKCOL', res);
    }
  }

  function parseListing(xml: string, prefixPath: string): BackupObjectInfo[] {
    const parsed = parser.parse(xml) as { multistatus?: { response?: PropfindEntry[] } };
    const responses = parsed.multistatus?.response ?? [];
    const objects: BackupObjectInfo[] = [];

    for (const entry of responses) {
      if (!entry.href) continue;
      // `href` may be absolute (`http://host/path`) or path-only, and is percent-encoded.
      let href: string;
      try {
        href = decodeURIComponent(new URL(entry.href, 'http://placeholder.invalid').pathname);
      } catch {
        continue;
      }
      const normalized = href.replace(/\/+$/, '');
      const prop = entry.propstat?.find((p) => p.prop)?.prop;

      // A collection is not a backup. PROPFIND Depth:1 returns the queried collection as its own
      // first entry, and any child collection too; included, each would appear as a phantom
      // zero-byte version offered for restore.
      const isCollection =
        href.endsWith('/') ||
        (prop?.resourcetype !== undefined &&
          prop?.resourcetype !== null &&
          prop?.resourcetype !== '' &&
          typeof prop?.resourcetype === 'object' &&
          'collection' in (prop.resourcetype as object));
      if (isCollection) continue;

      // Back to a key relative to the destination root, so the caller sees the same key space
      // the S3 driver presents.
      if (!normalized.startsWith(rootPath)) continue;
      const key = normalized.slice(rootPath.length).replace(/^\/+/, '');
      if (!key.startsWith(prefixPath)) continue;

      const lastModified = prop?.getlastmodified ? new Date(prop.getlastmodified).toISOString() : '';
      objects.push({
        key,
        sizeBytes: Number(prop?.getcontentlength ?? 0),
        lastModified,
      });
    }
    return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  return {
    async put(key, body, contentType = 'application/gzip') {
      await ensureCollections(key);
      const res = await send('PUT', pathFor(key), body, { 'content-type': contentType });
      if (!ok(res)) throw failFor('PUT', res);
    },

    async get(key) {
      const res = await send('GET', pathFor(key));
      if (!ok(res)) throw failFor('GET', res);
      return res.body;
    },

    async list(prefix) {
      // Depth:1 lists the immediate children of the collection. WebDAV has no continuation
      // token — the whole listing comes in one multistatus — so the interface's `pageSize` has
      // nothing to do here and is correctly ignored.
      const collection = `${pathFor(prefix).replace(/\/+$/, '')}/`;
      const res = await send('PROPFIND', collection, undefined, { depth: '1' });

      // 404 means the collection does not exist yet, which is "no versions" — a job's first
      // listing, before its first run. Throwing would make an empty history an error.
      if (res.status === 404) return [];
      if (res.status !== 207 && !ok(res)) throw failFor('PROPFIND', res);

      return parseListing(res.body.toString('utf8'), prefix.replace(/^\/+/, ''));
    },

    async delete(key) {
      const res = await send('DELETE', pathFor(key));
      if (!ok(res) && res.status !== 404) throw failFor('DELETE', res);
    },

    async testConnection(): Promise<BackupProbeOutcome> {
      let res: TransportResponse;
      try {
        res = await send('PROPFIND', `${rootPath}/`, undefined, { depth: '0' });
      } catch {
        return { ok: false, failure: 'unreachable', reason: 'Could not reach that address' };
      }

      if (res.status === 401 || res.status === 403) {
        // 401 is unambiguous. 403 from a WebDAV server after successful Basic auth would mean
        // authenticated-but-forbidden, but servers differ on which they send for a bad password,
        // so the write probe below is what actually separates them.
        if (res.status === 401) {
          return { ok: false, failure: 'credentials-rejected', reason: 'Those credentials were rejected' };
        }
        return {
          ok: false,
          failure: 'no-write-permission',
          reason: 'Those credentials are valid but not permitted to use that path',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          failure: 'no-write-permission',
          reason: 'That path does not exist, or those credentials cannot see it',
        };
      }
      if (res.status !== 207 && !ok(res)) {
        return { ok: false, failure: 'unreachable', reason: `That destination answered HTTP ${res.status}` };
      }

      // Reading proves the credential; it does not prove the credential may WRITE. A read-only
      // share that passes a probe and then fails every backup is what FR-004 exists to prevent.
      const probeKey = `${destination.basePath || 'mcm-backups'}/.mcm-write-probe`;
      try {
        await ensureCollections(probeKey);
        const write = await send('PUT', pathFor(probeKey), Buffer.alloc(0), {
          'content-type': 'application/octet-stream',
        });
        if (write.status === 401) {
          return { ok: false, failure: 'credentials-rejected', reason: 'Those credentials were rejected' };
        }
        if (write.status === 403 || write.status === 405) {
          return {
            ok: false,
            failure: 'no-write-permission',
            reason: 'Those credentials can read that path but cannot write to it',
          };
        }
        if (!ok(write)) {
          return { ok: false, failure: 'no-write-permission', reason: `A test write answered HTTP ${write.status}` };
        }
      } catch {
        return { ok: false, failure: 'unreachable', reason: 'Could not reach that address' };
      }

      try {
        await send('DELETE', pathFor(probeKey));
      } catch {
        /* a leftover probe file is untidy, not a failure of the destination */
      }
      return { ok: true };
    },
  };
}
