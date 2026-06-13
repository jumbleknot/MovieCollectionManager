/**
 * Transient upload/download file store (014 T005, research R3).
 *
 * The BFF accepts a spreadsheet upload, writes the raw bytes to Redis under
 * `import:file:<handle>` with a short TTL, and passes ONLY the opaque, unguessable handle into
 * the agent run. `spreadsheet-mcp.parse_spreadsheet` fetches the bytes by that handle and deletes
 * the key (single-use). Generated export workbooks live under `export:file:<handle>` for the BFF
 * download route to stream. No file bytes ever enter checkpointed agent state, traces, or logs
 * (SC-004 / constitution Agent Security) — only the handle travels.
 *
 * Bytes are stored as a Buffer (spreadsheets are binary); reads use `getBuffer`. This is a
 * deliberately separate module from cache-service.ts (string/session values) so the binary
 * surface and the import/export key namespaces stay isolated.
 */

import { randomBytes } from 'node:crypto';

import { env } from '@/config/env';
import { AuthError, AuthErrorCode } from '@/types/errors';

export const IMPORT_FILE_PREFIX = 'import:file:';
export const EXPORT_FILE_PREFIX = 'export:file:';

/** Short lifetime — long enough to parse an upload / click a download, short enough to be transient. */
const DEFAULT_TTL_SECONDS = 15 * 60;

/**
 * Upper byte bound — a safety guard against an absurd upload exhausting Redis, NOT the import row
 * cap (the spec deliberately sets no row cap: large imports are chunked with progress, Q2). Kept
 * generous so it never gates a realistic personal collection.
 */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Raised when an upload is empty or exceeds the byte safety guard. */
export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileTooLargeError';
  }
}

interface RedisBufferLike {
  set(key: string, value: Buffer, expiryMode: 'EX', seconds: number): Promise<unknown>;
  getBuffer(key: string): Promise<Buffer | null>;
  del(...keys: string[]): Promise<unknown>;
}

let redisClient: RedisBufferLike | null = null;

function getRedis(): RedisBufferLike {
  if (redisClient) return redisClient;
  try {
    // Dynamic require so ioredis is never bundled into the client; synchronous require is
    // interceptable by Jest mocks (mirrors cache-service.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Redis } = require('ioredis') as { default: new (url: string) => RedisBufferLike };
    redisClient = new Redis(env.redisUrl);
    return redisClient;
  } catch {
    throw new AuthError(AuthErrorCode.UNKNOWN, 'File store unavailable', 503);
  }
}

/** A fresh opaque, unguessable handle (128 bits of entropy, hex-encoded). */
function makeHandle(): string {
  return randomBytes(16).toString('hex');
}

export interface PutFileOptions {
  ttlSeconds?: number;
  maxBytes?: number;
}

/**
 * Stash uploaded spreadsheet bytes under a fresh handle; return the handle.
 *
 * Rejects an empty upload and one over the byte guard BEFORE touching Redis.
 */
export async function putImportFile(bytes: Buffer, opts: PutFileOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length === 0) {
    throw new FileTooLargeError('empty file');
  }
  if (bytes.length > maxBytes) {
    throw new FileTooLargeError(`file exceeds the ${maxBytes}-byte limit`);
  }
  const handle = makeHandle();
  const redis = getRedis();
  await redis.set(IMPORT_FILE_PREFIX + handle, bytes, 'EX', opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  return handle;
}

/**
 * Fetch (and consume) an uploaded file by handle. Single-use: the key is deleted after a hit so a
 * handle cannot be replayed. Returns null for an expired/unknown handle.
 */
export async function takeImportFile(handle: string): Promise<Buffer | null> {
  const redis = getRedis();
  const key = IMPORT_FILE_PREFIX + handle;
  const bytes = await redis.getBuffer(key);
  if (bytes == null) return null;
  await redis.del(key);
  return bytes;
}
