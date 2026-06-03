/**
 * T049 — BFF /bff-api/collections/[collectionId] route unit tests (RED)
 * Covers: GET /collections/:id (get), PATCH /collections/:id (update),
 *         DELETE /collections/:id (delete)
 *
 * These tests are intentionally RED until T051 implements the route handlers.
 *
 * Verified behaviours:
 *   - requireAuth called; 401 returned if it throws UnauthorizedError
 *   - collectionId path param forwarded in mc-service URL
 *   - Raw JWT forwarded to mc-service via Authorization: Bearer header
 *   - mc-service success responses forwarded to client with correct status
 *   - mc-service 404 (collection not found) propagated to client
 *   - mc-service 409 (duplicate name on PATCH) propagated to client
 */

const mockMcClient = {
  get: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
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

import { GET, PATCH, DELETE } from '@/app/bff-api/collections/[collectionId]/index+api';
import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { UnauthorizedError } from '@/types/errors';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const COLLECTION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

// Flat params — @expo/server passes route params as a plain object, not { params: {...} }
type RouteParams = { collectionId: string };

function makeGetRequest(): [Parameters<typeof GET>[0], RouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
      json: () => Promise.resolve({}),
    } as unknown as Parameters<typeof GET>[0],
    { collectionId: COLLECTION_ID },
  ];
}

function makePatchRequest(body: unknown): [Parameters<typeof PATCH>[0], RouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
      json: () => Promise.resolve(body),
    } as unknown as Parameters<typeof PATCH>[0],
    { collectionId: COLLECTION_ID },
  ];
}

function makeDeleteRequest(): [Parameters<typeof DELETE>[0], RouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
      json: () => Promise.resolve({}),
    } as unknown as Parameters<typeof DELETE>[0],
    { collectionId: COLLECTION_ID },
  ];
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
const noRoleUserProfile = { ...mockUserProfile, roles: [] };

const mockCollection = {
  id: COLLECTION_ID,
  name: 'My Movies',
  description: 'Great films',
  isDefault: true,
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
};

// ─── GET /bff-api/collections/:id ─────────────────────────────────────────────

describe('GET /bff-api/collections/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.get.mockResolvedValue({ status: 200, data: mockCollection });
  });

  it('returns 200 with collection from mc-service', async () => {
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(COLLECTION_ID);
    expect(data.name).toBe('My Movies');
  });

  it('calls mc-service GET /api/v1/collections/:id with correct collectionId', async () => {
    await GET(...makeGetRequest());
    expect(mockMcClient.get).toHaveBeenCalledWith(`/api/v1/collections/${COLLECTION_ID}`);
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('get-jwt');
    await GET(...makeGetRequest());
    expect(createMcServiceClient).toHaveBeenCalledWith('get-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated user lacks mc-user and mc-admin roles', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: mockPayload, user: noRoleUserProfile });
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(403);
  });

  it('propagates mc-service 404 (not found) to client', async () => {
    mockMcClient.get.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/collection-not-found',
        title: 'Collection Not Found',
        status: 404,
        detail: `Collection ${COLLECTION_ID} not found`,
      }),
    );
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });
});

// ─── PATCH /bff-api/collections/:id ───────────────────────────────────────────

describe('PATCH /bff-api/collections/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.patch.mockResolvedValue({ status: 200, data: { ...mockCollection, name: 'Updated' } });
  });

  it('returns 200 with updated collection from mc-service', async () => {
    const res = await PATCH(...makePatchRequest({ name: 'Updated' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Updated');
  });

  it('calls mc-service PATCH /api/v1/collections/:id with correct id and body', async () => {
    const body = { name: 'Updated', description: 'New desc' };
    await PATCH(...makePatchRequest(body));
    expect(mockMcClient.patch).toHaveBeenCalledWith(`/api/v1/collections/${COLLECTION_ID}`, body);
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('patch-jwt');
    await PATCH(...makePatchRequest({ name: 'X' }));
    expect(createMcServiceClient).toHaveBeenCalledWith('patch-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await PATCH(...makePatchRequest({ name: 'X' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated user lacks mc-user and mc-admin roles', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: mockPayload, user: noRoleUserProfile });
    const res = await PATCH(...makePatchRequest({ name: 'X' }));
    expect(res.status).toBe(403);
  });

  it('propagates mc-service 404 (collection not found) to client', async () => {
    mockMcClient.patch.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/collection-not-found',
        title: 'Collection Not Found',
        status: 404,
      }),
    );
    const res = await PATCH(...makePatchRequest({ name: 'X' }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });

  it('propagates mc-service 409 (duplicate name) to client', async () => {
    mockMcClient.patch.mockRejectedValueOnce(
      makeAxiosError(409, {
        type: 'https://mc-service/errors/duplicate-collection-name',
        title: 'Duplicate Collection Name',
        status: 409,
      }),
    );
    const res = await PATCH(...makePatchRequest({ name: 'My Movies' }));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe(409);
  });
});

// ─── DELETE /bff-api/collections/:id ──────────────────────────────────────────

describe('DELETE /bff-api/collections/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.delete.mockResolvedValue({ status: 204, data: null });
  });

  it('returns 204 on successful delete', async () => {
    const res = await DELETE(...makeDeleteRequest());
    expect(res.status).toBe(204);
  });

  it('calls mc-service DELETE /api/v1/collections/:id with correct collectionId', async () => {
    await DELETE(...makeDeleteRequest());
    expect(mockMcClient.delete).toHaveBeenCalledWith(`/api/v1/collections/${COLLECTION_ID}`);
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('delete-jwt');
    await DELETE(...makeDeleteRequest());
    expect(createMcServiceClient).toHaveBeenCalledWith('delete-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await DELETE(...makeDeleteRequest());
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated user lacks mc-user and mc-admin roles', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: mockPayload, user: noRoleUserProfile });
    const res = await DELETE(...makeDeleteRequest());
    expect(res.status).toBe(403);
  });

  it('propagates mc-service 404 (collection not found) to client', async () => {
    mockMcClient.delete.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/collection-not-found',
        title: 'Collection Not Found',
        status: 404,
      }),
    );
    const res = await DELETE(...makeDeleteRequest());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });
});
