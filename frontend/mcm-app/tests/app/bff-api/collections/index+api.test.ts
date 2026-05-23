/**
 * T049 — BFF /bff-api/collections route unit tests (RED)
 * Covers: GET /collections (list), POST /collections (create)
 *
 * These tests are intentionally RED until T050 implements the route handlers.
 *
 * Verified behaviours:
 *   - requireAuth called; 401 returned if it throws UnauthorizedError
 *   - Raw JWT forwarded to mc-service via Authorization: Bearer header
 *   - mc-service success responses forwarded to client with correct status
 *   - mc-service error responses (4xx/5xx) propagated to client unchanged
 *   - createMcServiceClient receives the raw JWT extracted from auth headers
 */

const mockMcClient = {
  get: jest.fn(),
  post: jest.fn(),
};

jest.mock('@/bff-server/auth', () => ({
  requireAuth: jest.fn(),
  extractRawToken: jest.fn().mockReturnValue('raw-jwt-token'),
  extractSessionId: jest.fn().mockReturnValue(null),
}));

jest.mock('@/bff-server/mc-service-client', () => ({
  createMcServiceClient: jest.fn(() => mockMcClient),
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock('@/bff-server/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    audit: jest.fn(),
  },
}));

jest.mock('@/bff-server/security-headers', () => ({
  securityHeaders: jest.fn(() => new Headers()),
}));

import { GET, POST } from '@/app/bff-api/collections/index+api';
import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { UnauthorizedError } from '@/types/errors';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeGetRequest(): Parameters<typeof GET>[0] {
  return {
    url: 'http://localhost/bff-api/collections',
    headers: new Headers({ cookie: 'mcm_access_token=tok' }),
    json: () => Promise.resolve({}),
  } as unknown as Parameters<typeof GET>[0];
}

function makePostRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/collections',
    headers: new Headers({ cookie: 'mcm_access_token=tok' }),
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0];
}

function makeAxiosError(status: number, data: unknown): Error {
  const err = new Error('mc-service error') as Error & {
    isAxiosError: boolean;
    response: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const mockPayload = { sub: 'user-1', exp: 99999999999 };
const mockUserProfile = {
  id: 'user-1', username: 'tuser', roles: ['mc-user'],
  accountStatus: 'active' as const, createdAt: '2026-01-01T00:00:00.000Z',
};

const mockCollectionSummaries = [
  { id: 'coll-1', name: 'My Movies', isDefault: true, movieCount: 5 },
  { id: 'coll-2', name: 'TV Shows', isDefault: false, movieCount: 12 },
];

const mockCreatedCollection = {
  id: 'coll-new', name: 'New Collection', description: null, isDefault: false,
  createdAt: '2026-05-23T00:00:00.000Z', updatedAt: '2026-05-23T00:00:00.000Z',
};

// ─── GET /bff-api/collections ──────────────────────────────────────────────────

describe('GET /bff-api/collections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.get.mockResolvedValue({ status: 200, data: { items: mockCollectionSummaries } });
  });

  it('returns 200 with collection list from mc-service', async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.items[0].name).toBe('My Movies');
  });

  it('calls mc-service GET /api/v1/collections', async () => {
    await GET(makeGetRequest());
    expect(mockMcClient.get).toHaveBeenCalledWith('/api/v1/collections');
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('specific-jwt-for-this-request');
    await GET(makeGetRequest());
    expect(createMcServiceClient).toHaveBeenCalledWith('specific-jwt-for-this-request');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('propagates mc-service 500 as 500 to client', async () => {
    mockMcClient.get.mockRejectedValueOnce(
      makeAxiosError(500, { title: 'Internal Server Error', status: 500 }),
    );
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
  });
});

// ─── POST /bff-api/collections ─────────────────────────────────────────────────

describe('POST /bff-api/collections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.post.mockResolvedValue({ status: 201, data: mockCreatedCollection });
  });

  it('returns 201 with new collection from mc-service', async () => {
    const res = await POST(makePostRequest({ name: 'New Collection' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe('New Collection');
    expect(data.id).toBe('coll-new');
  });

  it('calls mc-service POST /api/v1/collections with request body', async () => {
    const body = { name: 'New Collection', description: 'A test collection' };
    await POST(makePostRequest(body));
    expect(mockMcClient.post).toHaveBeenCalledWith('/api/v1/collections', body);
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('post-jwt');
    await POST(makePostRequest({ name: 'X' }));
    expect(createMcServiceClient).toHaveBeenCalledWith('post-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await POST(makePostRequest({ name: 'X' }));
    expect(res.status).toBe(401);
  });

  it('propagates mc-service 409 (duplicate name) to client', async () => {
    mockMcClient.post.mockRejectedValueOnce(
      makeAxiosError(409, {
        type: 'https://mc-service/errors/duplicate-collection-name',
        title: 'Duplicate Collection Name',
        status: 409,
      }),
    );
    const res = await POST(makePostRequest({ name: 'My Movies' }));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe(409);
  });

  it('propagates mc-service 400 (invalid input) to client', async () => {
    mockMcClient.post.mockRejectedValueOnce(
      makeAxiosError(400, {
        type: 'https://mc-service/errors/validation-error',
        title: 'Validation Error',
        status: 400,
        detail: 'Name must not exceed 50 characters',
      }),
    );
    const res = await POST(makePostRequest({ name: 'A'.repeat(51) }));
    expect(res.status).toBe(400);
  });
});
