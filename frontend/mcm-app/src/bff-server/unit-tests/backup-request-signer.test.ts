// AWS Signature Version 4 signer — verified against AWS's OWN published test vectors
// (feature 073, T012; research.md §R5; plan.md Complexity Tracking).
//
// WHY A HAND-WRITTEN SIGNER AT ALL. Ratified by the operator on 2026-09-20: only four S3
// operations are needed (PUT/GET/LIST/DELETE), and @aws-sdk/client-s3 pulls ~50 transitive
// packages into a repository whose entire CI board has gone red over one transitive dependency.
// The decision is on supply-chain surface, not capability, and it is contained behind the driver
// interface — reversing it is one file.
//
// WHY THESE VECTORS, AND WHY THEY ARE VENDORED. A signer tested against expectations I wrote
// would prove only that the implementation agrees with itself, which for a cryptographic
// construction is worth nothing: the failure mode is "produces a consistent, wrong signature",
// and that passes a self-consistent test every time. `fixtures/aws-sigv4/` holds AWS's published
// suite verbatim (Apache-2.0, LICENSE and NOTICE alongside) — each case carries the request, the
// expected CANONICAL REQUEST, the expected STRING TO SIGN and the expected AUTHORIZATION header,
// so all three intermediate stages are checked against an external oracle rather than only the
// final signature. Vendored rather than fetched so the suite has no network dependency.
//
// WHAT THESE VECTORS DO NOT COVER: PUT and DELETE, and a non-empty payload hash — AWS's suite is
// GET/POST only. Those are proved against a REAL MinIO in T014, which is the second, independent
// oracle. Neither alone would be enough.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildCanonicalRequest,
  buildStringToSign,
  signRequest,
  type SigningCredentials,
} from '@/bff-server/backup-request-signer';

const SUITE_DIR = join(__dirname, 'fixtures', 'aws-sigv4');

// The credentials AWS's suite is generated with. Not a real key pair — they appear verbatim in
// AWS's public documentation and exist solely so the expected signatures are reproducible.
const SUITE_CREDENTIALS: SigningCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
};

// sha256 of the empty string — every case in the suite has an empty body.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface ParsedRequest {
  method: string;
  path: string;
  query: string;
  headers: [string, string][];
}

/**
 * Parse one `.req` fixture: an HTTP/1.1 request line, then headers, then an optional body.
 *
 * Header lines in the suite appear both as `Host:value` and `My-Header1: value`, and several
 * files have no trailing newline, so neither can be assumed.
 */
function parseRequest(raw: string): ParsedRequest {
  const lines = raw.split('\n');
  const requestLine = lines[0].trimEnd();
  const match = /^(\S+)\s+(\S*)\s+HTTP\/1\.1$/.exec(requestLine);
  if (!match) throw new Error(`unparseable request line: ${requestLine}`);
  const [, method, target] = match;
  const q = target.indexOf('?');
  const path = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? '' : target.slice(q + 1);

  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break; // blank line ends the header block
    const colon = line.indexOf(':');
    if (colon === -1) {
      // A continuation line (get-header-value-multiline). Append to the previous header.
      if (headers.length) headers[headers.length - 1][1] += `,${line.trim()}`;
      continue;
    }
    headers.push([line.slice(0, colon), line.slice(colon + 1).replace(/\r$/, '')]);
  }
  return { method, path, query, headers };
}

function loadCase(name: string) {
  const dir = join(SUITE_DIR, name);
  const read = (ext: string) => readFileSync(join(dir, `${name}.${ext}`), 'utf8').replace(/\r\n/g, '\n');
  return {
    request: parseRequest(read('req')),
    canonical: read('creq').replace(/\n$/, ''),
    stringToSign: read('sts').replace(/\n$/, ''),
    authorization: read('authz').replace(/\n$/, ''),
  };
}

const CASES = readdirSync(SUITE_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SUITE_DIR, e.name, `${e.name}.creq`)))
  .map((e) => e.name)
  .sort();

describe('AWS published SigV4 vectors', () => {
  // A guard on the harness itself, not on the signer. If the fixtures were ever lost or the
  // filter above stopped matching, every `it.each` below would silently run ZERO times and the
  // suite would report success — a signer verified against nothing.
  it('found the vendored vector cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(CASES)('%s — canonical request matches AWS exactly', (name) => {
    const c = loadCase(name);
    expect(
      buildCanonicalRequest({
        method: c.request.method,
        path: c.request.path,
        query: c.request.query,
        headers: c.request.headers,
        payloadHash: EMPTY_SHA256,
      }),
    ).toBe(c.canonical);
  });

  it.each(CASES)('%s — string to sign matches AWS exactly', (name) => {
    const c = loadCase(name);
    const canonical = buildCanonicalRequest({
      method: c.request.method,
      path: c.request.path,
      query: c.request.query,
      headers: c.request.headers,
      payloadHash: EMPTY_SHA256,
    });
    expect(
      buildStringToSign(canonical, {
        amzDate: '20150830T123600Z',
        region: SUITE_CREDENTIALS.region,
        service: SUITE_CREDENTIALS.service,
      }),
    ).toBe(c.stringToSign);
  });

  it.each(CASES)('%s — Authorization header matches AWS exactly', (name) => {
    const c = loadCase(name);
    const signed = signRequest(
      {
        method: c.request.method,
        path: c.request.path,
        query: c.request.query,
        headers: c.request.headers,
        payloadHash: EMPTY_SHA256,
      },
      SUITE_CREDENTIALS,
      new Date('2015-08-30T12:36:00Z'),
    );
    expect(signed.authorization).toBe(c.authorization);
  });
});

describe('the operations the AWS suite does not cover', () => {
  // The suite is GET/POST with an empty body. S3 needs PUT with a real payload hash and DELETE,
  // so those shapes are asserted here for structure and pinned against a real MinIO in T014.
  const s3Creds: SigningCredentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
  };

  it('signs a PUT over the payload hash, not over an empty body', () => {
    const body = Buffer.from('a backup artifact');
    const withBody = signRequest(
      {
        method: 'PUT',
        path: '/bucket/mcm-backups/job/2026-09-20T03:00:00.000Z.json.gz',
        query: '',
        headers: [['Host', 'storage.example.com']],
        payloadHash: createHash('sha256').update(body).digest('hex'),
      },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    const withoutBody = signRequest(
      {
        method: 'PUT',
        path: '/bucket/mcm-backups/job/2026-09-20T03:00:00.000Z.json.gz',
        query: '',
        headers: [['Host', 'storage.example.com']],
        payloadHash: EMPTY_SHA256,
      },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    // If these matched, the body would not be covered by the signature and any payload could be
    // substituted under a valid one.
    expect(withBody.authorization).not.toBe(withoutBody.authorization);
    expect(withBody.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
  });

  it('signs LIST with its query string, where the canonical ordering rule bites', () => {
    // list-objects-v2 sends list-type, prefix, continuation-token and max-keys together. AWS
    // orders canonical query by ENCODED key, which is not the order they are written in.
    const signed = signRequest(
      {
        method: 'GET',
        path: '/bucket',
        query: 'prefix=mcm-backups%2Fjob%2F&list-type=2&max-keys=1000',
        headers: [['Host', 'storage.example.com']],
        payloadHash: EMPTY_SHA256,
      },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    expect(signed.canonicalRequest.split('\n')[2]).toBe(
      'list-type=2&max-keys=1000&prefix=mcm-backups%2Fjob%2F',
    );
  });

  it('signs DELETE, and a different key yields a different signature', () => {
    const one = signRequest(
      { method: 'DELETE', path: '/bucket/a.json.gz', query: '', headers: [['Host', 'storage.example.com']], payloadHash: EMPTY_SHA256 },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    const two = signRequest(
      { method: 'DELETE', path: '/bucket/b.json.gz', query: '', headers: [['Host', 'storage.example.com']], payloadHash: EMPTY_SHA256 },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    expect(one.authorization).not.toBe(two.authorization);
  });

  it('adds x-amz-date and covers it in SignedHeaders', () => {
    const signed = signRequest(
      { method: 'GET', path: '/bucket', query: '', headers: [['Host', 'storage.example.com']], payloadHash: EMPTY_SHA256 },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    expect(signed.headers['x-amz-date']).toBe('20260920T030000Z');
    expect(signed.authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  });

  it('percent-encodes a key segment without encoding the separators', () => {
    // An S3 key legitimately contains characters the canonical URI must escape. Escaping the
    // slashes too would sign a path the server never sees; escaping nothing would sign a
    // different path than the one requested. Either way the request is rejected as unsigned.
    const signed = signRequest(
      { method: 'PUT', path: '/bucket/mcm backups/a+b.json.gz', query: '', headers: [['Host', 'storage.example.com']], payloadHash: EMPTY_SHA256 },
      s3Creds,
      new Date('2026-09-20T03:00:00Z'),
    );
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/bucket/mcm%20backups/a%2Bb.json.gz');
  });
});
