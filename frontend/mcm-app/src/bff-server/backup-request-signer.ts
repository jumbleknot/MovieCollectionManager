// AWS Signature Version 4 request signer (feature 073, FR-001).
//
// Replaces @aws-sdk/client-s3 for the four S3 operations this feature needs — PUT, GET, LIST and
// DELETE. Ratified by the operator on 2026-09-20 on supply-chain surface: the SDK pulls ~50
// transitive packages into a repository whose whole CI board has gone red over one transitive
// dependency. The decision lives behind the driver interface, so reversing it means replacing
// this file and backup-driver-s3.ts and nothing else.
//
// Verified against AWS's PUBLISHED test vectors (unit-tests/fixtures/aws-sigv4) at all three
// intermediate stages, and against a real MinIO in the integration tier. Both oracles are
// external: a signing implementation checked only against its own expectations passes happily
// while producing a consistent, wrong signature.
//
// Scope note: SigV4 only, no chunked/streaming payloads (the artifact is a single buffer, by the
// same "fail loudly rather than stream" decision the size ceiling rests on) and no presigning.

import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  /** Un-encoded path, e.g. `/bucket/my key.json.gz`. Encoded canonically here. */
  path: string;
  /** Raw query string without the leading `?`. Re-ordered canonically here. */
  query: string;
  headers: [string, string][];
  /** Hex sha256 of the body, or the literal `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
}

export interface SignedRequest {
  authorization: string;
  /** Lower-cased headers to send, including the ones signing added. */
  headers: Record<string, string>;
  /** Exposed so a test can assert the intermediate stage rather than only the final signature. */
  canonicalRequest: string;
  stringToSign: string;
}

const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * RFC 3986 encoding, which is NOT what encodeURIComponent does: it leaves `!*'()` unescaped, and
 * AWS escapes them. A single unescaped character makes the canonical request differ from the
 * server's and the request is rejected as unsigned — with an error that says nothing about which
 * character was wrong.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonical URI: each path SEGMENT encoded, separators left alone.
 *
 * Encoding the slashes too would sign a path the server never sees; encoding nothing would sign
 * a different path from the one requested. Both fail identically, as an opaque signature
 * mismatch.
 *
 * Note this does NOT normalise `.` / `..` segments. S3 (unlike every other AWS service) signs
 * the path as given, and a backup key never contains them — the key is built here, from a job id
 * and an ISO timestamp, never from user text.
 */
function canonicalUri(path: string): string {
  if (!path) return '/';
  return path
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

/**
 * Canonical query: sorted by ENCODED key, then by encoded value.
 *
 * Sorting by the decoded key is the subtle wrong version — `%E1%88%B4` sorts before `Param`
 * because '%' (0x25) precedes 'P' (0x50) in byte order, while its decoded form does not. AWS's
 * get-vanilla-query-order-encoded vector exists precisely to catch that, and it is the rule that
 * bites on LIST, where several parameters travel together.
 */
function canonicalQuery(query: string): string {
  if (!query) return '';
  const pairs: [string, string][] = [];
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    // A key with no `=` canonicalises to `key=` — an empty value, not a bare key.
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    // The input is already percent-encoded (it comes off a request line), so decode and re-encode
    // to normalise spelling — `%2f` and `%2F` must canonicalise the same way.
    pairs.push([uriEncode(decodeURIComponent(rawKey)), uriEncode(decodeURIComponent(rawValue))]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Canonical headers: lower-cased names, values trimmed with internal runs of whitespace
 * collapsed to one space, duplicates comma-joined in the order they appeared, sorted by name.
 */
function canonicalHeaders(headers: [string, string][]): {
  canonical: string;
  signedHeaders: string;
} {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of headers) {
    const key = name.trim().toLowerCase();
    const collapsed = value.trim().replace(/\s+/g, ' ');
    const existing = grouped.get(key);
    if (existing) existing.push(collapsed);
    else grouped.set(key, [collapsed]);
  }
  const names = [...grouped.keys()].sort();
  return {
    canonical: names.map((n) => `${n}:${grouped.get(n)!.join(',')}\n`).join(''),
    signedHeaders: names.join(';'),
  };
}

export function buildCanonicalRequest(req: SignableRequest): string {
  const { canonical, signedHeaders } = canonicalHeaders(req.headers);
  return [
    req.method.toUpperCase(),
    canonicalUri(req.path),
    canonicalQuery(req.query),
    canonical,
    signedHeaders,
    req.payloadHash,
  ].join('\n');
}

export function buildStringToSign(
  canonicalRequest: string,
  ctx: { amzDate: string; region: string; service: string },
): string {
  const dateStamp = ctx.amzDate.slice(0, 8);
  return [
    ALGORITHM,
    ctx.amzDate,
    `${dateStamp}/${ctx.region}/${ctx.service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');
}

/** The four-step derivation. Each step's key is the PREVIOUS step's output, never the raw secret. */
function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** `20150830T123600Z` — basic ISO-8601, which is the only form SigV4 accepts. */
function amzDateOf(date: Date): string {
  return `${date.toISOString().replace(/[:-]/g, '').split('.')[0]}Z`;
}

/**
 * Sign a request, returning the Authorization header and the headers signing added.
 *
 * `x-amz-date` and `x-amz-content-sha256` are added HERE and therefore signed. Adding them at the
 * transport layer afterwards would leave them outside SignedHeaders — the request would be
 * rejected, and the error would point at the signature rather than at the missing header.
 */
export function signRequest(
  req: SignableRequest,
  credentials: SigningCredentials,
  date: Date = new Date(),
): SignedRequest {
  const amzDate = amzDateOf(date);
  const dateStamp = amzDate.slice(0, 8);

  // AWS's own vectors sign only the headers present in the fixture, so the extra S3 headers are
  // added only when they are not already supplied. That keeps one code path for both the vector
  // suite and real S3 traffic — two paths would mean the thing verified is not the thing used.
  const supplied = new Set(req.headers.map(([n]) => n.trim().toLowerCase()));
  const headers: [string, string][] = [...req.headers];
  if (!supplied.has('x-amz-date')) headers.push(['x-amz-date', amzDate]);
  if (credentials.service === 's3' && !supplied.has('x-amz-content-sha256')) {
    headers.push(['x-amz-content-sha256', req.payloadHash]);
  }
  if (credentials.sessionToken && !supplied.has('x-amz-security-token')) {
    headers.push(['x-amz-security-token', credentials.sessionToken]);
  }

  const canonicalRequest = buildCanonicalRequest({ ...req, headers });
  const stringToSign = buildStringToSign(canonicalRequest, {
    amzDate,
    region: credentials.region,
    service: credentials.service,
  });
  const signature = createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, dateStamp, credentials.region, credentials.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  const { signedHeaders } = canonicalHeaders(headers);
  const credentialScope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
  const authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = {};
  for (const [name, value] of headers) outHeaders[name.trim().toLowerCase()] = value;
  outHeaders.authorization = authorization;

  return { authorization, headers: outHeaders, canonicalRequest, stringToSign };
}

export { sha256Hex };
