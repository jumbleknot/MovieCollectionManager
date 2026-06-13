/**
 * Unit tests for the transient upload/download file store (014 T005, research R3).
 *
 * The BFF stashes an uploaded spreadsheet's raw bytes under `import:file:<handle>` with a short
 * TTL and passes only the opaque handle into the agent run; spreadsheet-mcp fetches the bytes by
 * handle (single-use). Covers: put (opaque handle + TTL), get, single-use consumption, size guard.
 */

// Import AFTER the ioredis mock is registered (jest.mock is hoisted).
import {
  FileTooLargeError,
  putImportFile,
  takeImportFile,
  IMPORT_FILE_PREFIX,
} from '@/bff-server/transient-file-store';

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  getBuffer: jest.fn(),
  del: jest.fn(),
};

jest.mock(
  'ioredis',
  () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockRedis),
  }),
  { virtual: true },
);

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.del.mockResolvedValue(1);
});

describe('putImportFile', () => {
  it('stores bytes under the import:file: prefix with a TTL and returns an opaque handle', async () => {
    const bytes = Buffer.from('hello-spreadsheet');
    const handle = await putImportFile(bytes);

    expect(handle).toMatch(/^[a-f0-9]{16,}$/); // opaque, unguessable hex
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [key, value, exMode, ttl] = mockRedis.set.mock.calls[0];
    expect(key).toBe(`${IMPORT_FILE_PREFIX}${handle}`);
    expect(value).toEqual(bytes);
    expect(exMode).toBe('EX');
    expect(typeof ttl).toBe('number');
    expect(ttl).toBeGreaterThan(0);
  });

  it('returns a distinct handle each call', async () => {
    const a = await putImportFile(Buffer.from('a'));
    const b = await putImportFile(Buffer.from('b'));
    expect(a).not.toBe(b);
  });

  it('honors a custom TTL', async () => {
    await putImportFile(Buffer.from('x'), { ttlSeconds: 42 });
    expect(mockRedis.set.mock.calls[0][3]).toBe(42);
  });

  it('rejects a file exceeding the size guard without touching Redis', async () => {
    const tooBig = Buffer.alloc(11);
    await expect(putImportFile(tooBig, { maxBytes: 10 })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('rejects an empty file without touching Redis', async () => {
    await expect(putImportFile(Buffer.alloc(0))).rejects.toThrow();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});

describe('takeImportFile (single-use)', () => {
  it('returns the bytes and deletes the key so a second take misses', async () => {
    const bytes = Buffer.from('payload');
    mockRedis.getBuffer.mockResolvedValueOnce(bytes);

    const got = await takeImportFile('h-123');
    expect(got).toEqual(bytes);
    expect(mockRedis.getBuffer).toHaveBeenCalledWith(`${IMPORT_FILE_PREFIX}h-123`);
    expect(mockRedis.del).toHaveBeenCalledWith(`${IMPORT_FILE_PREFIX}h-123`);
  });

  it('returns null for an expired/unknown handle', async () => {
    mockRedis.getBuffer.mockResolvedValueOnce(null);
    const got = await takeImportFile('missing');
    expect(got).toBeNull();
    expect(mockRedis.del).not.toHaveBeenCalled();
  });
});
