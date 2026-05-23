/**
 * T119 — BFF /bff-api/collections/[collectionId]/movies/filter-options route unit tests
 *
 * Verified behaviours:
 *   - requireAuth called; 401 returned if it throws UnauthorizedError
 *   - collectionId path param forwarded in mc-service URL
 *   - mc-service 200 response (FilterOptionsDto) forwarded to client
 *   - mc-service 404 (collection not found) propagated to client
 *   - Raw JWT forwarded to mc-service via Authorization: Bearer header
 */

const mockMcClient = {
  get: jest.fn(),
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

import { GET } from '@/app/bff-api/collections/[collectionId]/movies/filter-options+api';
import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { UnauthorizedError } from '@/types/errors';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const COLLECTION_ID = 'coll-abc-123';

type FilterOptionsRouteParams = { params: { collectionId: string } };

function makeGetRequest(): [Parameters<typeof GET>[0], FilterOptionsRouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}/movies/filter-options`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
    } as unknown as Parameters<typeof GET>[0],
    { params: { collectionId: COLLECTION_ID } },
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

const mockFilterOptionsResponse = {
  genres: ['Action', 'Drama', 'Comedy'],
  contentTypes: ['Movie', 'Series'],
  rated: ['PG-13', 'R'],
  languages: ['English', 'French'],
  decades: [1990, 2000, 2010],
  ownedMedia: ['Blu-Ray', 'DVD'],
  ripQuality: ['Blu-Ray'],
};

// ─── GET /bff-api/collections/:id/movies/filter-options ───────────────────────

describe('GET /bff-api/collections/:id/movies/filter-options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.get.mockResolvedValue({ status: 200, data: mockFilterOptionsResponse });
  });

  it('returns 200 with filter options from mc-service', async () => {
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.genres).toEqual(['Action', 'Drama', 'Comedy']);
    expect(data.contentTypes).toEqual(['Movie', 'Series']);
    expect(data.ownedMedia).toEqual(['Blu-Ray', 'DVD']);
  });

  it('calls mc-service GET /api/v1/collections/:id/movies/filter-options with correct collectionId', async () => {
    await GET(...makeGetRequest());
    expect(mockMcClient.get).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/movies/filter-options`,
    );
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('filter-jwt');
    await GET(...makeGetRequest());
    expect(createMcServiceClient).toHaveBeenCalledWith('filter-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('propagates mc-service 404 (collection not found) to client', async () => {
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

  it('returns all filter option arrays in the response', async () => {
    const res = await GET(...makeGetRequest());
    const data = await res.json();
    expect(Array.isArray(data.genres)).toBe(true);
    expect(Array.isArray(data.contentTypes)).toBe(true);
    expect(Array.isArray(data.rated)).toBe(true);
    expect(Array.isArray(data.languages)).toBe(true);
    expect(Array.isArray(data.decades)).toBe(true);
    expect(Array.isArray(data.ownedMedia)).toBe(true);
    expect(Array.isArray(data.ripQuality)).toBe(true);
  });

  it('returns empty arrays when collection has no movies', async () => {
    mockMcClient.get.mockResolvedValueOnce({
      status: 200,
      data: {
        genres: [],
        contentTypes: [],
        rated: [],
        languages: [],
        decades: [],
        ownedMedia: [],
        ripQuality: [],
      },
    });
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.genres).toHaveLength(0);
    expect(data.decades).toHaveLength(0);
  });
});
