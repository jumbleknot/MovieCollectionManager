/**
 * T093 + T146 — BFF /bff-api/collections/[collectionId]/movies/[movieId] route unit tests
 * Covers: GET /collections/:id/movies/:movieId (get movie) — T093
 *         PUT /collections/:id/movies/:movieId (update movie — full replacement) — T093
 *         DELETE /collections/:id/movies/:movieId (delete movie) — T146
 *
 * Verified behaviours:
 *   - requireAuth called; 401 returned if it throws UnauthorizedError
 *   - collectionId and movieId path params forwarded in mc-service URL
 *   - Raw JWT forwarded to mc-service via Authorization: Bearer header
 *   - mc-service success responses forwarded to client with correct status
 *   - mc-service 404 (collection or movie not found) propagated to client
 *   - mc-service 409 (duplicate movie on PUT) propagated to client
 *   - mc-service 400 (invalid input on PUT) propagated to client
 *   - DELETE returns 204 on success (T146)
 *   - DELETE propagates 404 (movie not found) to client (T146)
 *   - DELETE returns 401 when auth fails (T146)
 */

const mockMcClient = {
  get: jest.fn(),
  put: jest.fn(),
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

import { GET, PUT, DELETE } from '@/app/bff-api/collections/[collectionId]/movies/[movieId]+api';
import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { UnauthorizedError } from '@/types/errors';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const COLLECTION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MOVIE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// Flat params — @expo/server passes route params as a plain object, not { params: {...} }
type MovieRouteParams = { collectionId: string; movieId: string };

function makeGetRequest(): [Parameters<typeof GET>[0], MovieRouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
      json: () => Promise.resolve({}),
    } as unknown as Parameters<typeof GET>[0],
    { collectionId: COLLECTION_ID, movieId: MOVIE_ID },
  ];
}

function makePutRequest(body: unknown): [Parameters<typeof PUT>[0], MovieRouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
      json: () => Promise.resolve(body),
    } as unknown as Parameters<typeof PUT>[0],
    { collectionId: COLLECTION_ID, movieId: MOVIE_ID },
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

const mockMovie = {
  movieId: MOVIE_ID,
  collectionId: COLLECTION_ID,
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: false,
  childrens: false,
  ownedMedia: ['Blu-Ray'],
  ripQuality: [],
  genres: ['Action', 'Sci-Fi'],
  rated: 'R',
  directors: ['Lana Wachowski', 'Lilly Wachowski'],
  actors: ['Keanu Reeves'],
  tags: [],
  movieSet: null,
  originalTitle: null,
  releaseDate: '1999-03-31',
  outline: null,
  plot: null,
  runtime: 136,
  externalIds: [],
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
};

const updateMovieBody = {
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: true,
  childrens: false,
  ownedMedia: ['Blu-Ray'],
  ripQuality: ['1080p'],
  genres: ['Action', 'Sci-Fi'],
  rated: 'R',
  directors: ['Lana Wachowski', 'Lilly Wachowski'],
  actors: ['Keanu Reeves'],
  tags: [],
  movieSet: null,
  originalTitle: null,
  releaseDate: '1999-03-31',
  outline: null,
  plot: null,
  runtime: 136,
  externalIds: [],
};

// ─── GET /bff-api/collections/:id/movies/:movieId ─────────────────────────────

describe('GET /bff-api/collections/:id/movies/:movieId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.get.mockResolvedValue({ status: 200, data: mockMovie });
  });

  it('returns 200 with movie from mc-service', async () => {
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.movieId).toBe(MOVIE_ID);
    expect(data.title).toBe('The Matrix');
    expect(data.collectionId).toBe(COLLECTION_ID);
  });

  it('calls mc-service GET /api/v1/collections/:id/movies/:movieId with correct IDs', async () => {
    await GET(...makeGetRequest());
    expect(mockMcClient.get).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
    );
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

  it('propagates mc-service 404 (movie not found) to client', async () => {
    mockMcClient.get.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/movie-not-found',
        title: 'Movie Not Found',
        status: 404,
        detail: `Movie ${MOVIE_ID} not found`,
      }),
    );
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });
});

// ─── PUT /bff-api/collections/:id/movies/:movieId ─────────────────────────────

describe('PUT /bff-api/collections/:id/movies/:movieId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.put.mockResolvedValue({
      status: 200,
      data: { ...mockMovie, ripped: true, ripQuality: ['1080p'] },
    });
  });

  it('returns 200 with updated movie from mc-service', async () => {
    const res = await PUT(...makePutRequest(updateMovieBody));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.movieId).toBe(MOVIE_ID);
    expect(data.ripped).toBe(true);
    expect(data.ripQuality).toEqual(['1080p']);
  });

  it('calls mc-service PUT /api/v1/collections/:id/movies/:movieId with correct IDs and body', async () => {
    await PUT(...makePutRequest(updateMovieBody));
    expect(mockMcClient.put).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
      updateMovieBody,
    );
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('put-jwt');
    await PUT(...makePutRequest(updateMovieBody));
    expect(createMcServiceClient).toHaveBeenCalledWith('put-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await PUT(...makePutRequest(updateMovieBody));
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated user lacks mc-user and mc-admin roles', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: mockPayload, user: noRoleUserProfile });
    const res = await PUT(...makePutRequest(updateMovieBody));
    expect(res.status).toBe(403);
  });

  it('propagates mc-service 400 (invalid input) to client', async () => {
    mockMcClient.put.mockRejectedValueOnce(
      makeAxiosError(400, {
        type: 'https://mc-service/errors/invalid-input',
        title: 'Invalid Input',
        status: 400,
        detail: 'ripQuality requires ripped=true',
      }),
    );
    const res = await PUT(...makePutRequest({ ...updateMovieBody, ripped: false, ripQuality: ['1080p'] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe(400);
  });

  it('propagates mc-service 404 (collection not found) to client', async () => {
    mockMcClient.put.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/collection-not-found',
        title: 'Collection Not Found',
        status: 404,
      }),
    );
    const res = await PUT(...makePutRequest(updateMovieBody));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });

  it('propagates mc-service 404 (movie not found) to client', async () => {
    mockMcClient.put.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/movie-not-found',
        title: 'Movie Not Found',
        status: 404,
      }),
    );
    const res = await PUT(...makePutRequest(updateMovieBody));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });

  it('propagates mc-service 409 (duplicate movie) to client', async () => {
    mockMcClient.put.mockRejectedValueOnce(
      makeAxiosError(409, {
        type: 'https://mc-service/errors/duplicate-movie',
        title: 'Duplicate Movie',
        status: 409,
        detail: 'A movie with the same title, year, and content type already exists',
      }),
    );
    const res = await PUT(...makePutRequest(updateMovieBody));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe(409);
  });
});

// ─── DELETE /bff-api/collections/:id/movies/:movieId (T146) ───────────────────

type DeleteRouteParams = { collectionId: string; movieId: string };

function makeDeleteRequest(): [Parameters<typeof DELETE>[0], DeleteRouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
    } as unknown as Parameters<typeof DELETE>[0],
    { collectionId: COLLECTION_ID, movieId: MOVIE_ID },
  ];
}

describe('DELETE /bff-api/collections/:id/movies/:movieId', () => {
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

  it('calls mc-service DELETE /api/v1/collections/:id/movies/:movieId with correct IDs', async () => {
    await DELETE(...makeDeleteRequest());
    expect(mockMcClient.delete).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/movies/${MOVIE_ID}`,
    );
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

  it('propagates mc-service 404 (movie not found) to client', async () => {
    mockMcClient.delete.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/movie-not-found',
        title: 'Movie Not Found',
        status: 404,
        detail: `Movie ${MOVIE_ID} not found`,
      }),
    );
    const res = await DELETE(...makeDeleteRequest());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });

  it('propagates mc-service 404 (collection not found) to client', async () => {
    mockMcClient.delete.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/collection-not-found',
        title: 'Collection Not Found',
        status: 404,
        detail: `Collection ${COLLECTION_ID} not found`,
      }),
    );
    const res = await DELETE(...makeDeleteRequest());
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });
});
