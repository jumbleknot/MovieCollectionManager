/**
 * T093 + T119 — BFF /bff-api/collections/[collectionId]/movies route unit tests
 * Covers:
 *   POST /collections/:id/movies (create movie) — T093
 *   GET  /collections/:id/movies (list movies with query params) — T119
 *
 * Verified behaviours for GET:
 *   - requireAuth called; 401 returned if it throws UnauthorizedError
 *   - collectionId path param forwarded in mc-service URL
 *   - All query params forwarded to mc-service (cursor, search, contentType, genre,
 *     childrens, rated, language, decade, owned, ownedMedia, ripped, ripQuality)
 *   - mc-service 200 response (MovieListDto) forwarded to client
 *   - mc-service 404 (collection not found) propagated to client
 *   - Raw JWT forwarded to mc-service via Authorization: Bearer header
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

import { GET, POST } from '@/app/bff-api/collections/[collectionId]/movies/index+api';
import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { createMcServiceClient } from '@/bff-server/mc-service-client';
import { UnauthorizedError } from '@/types/errors';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const COLLECTION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MOVIE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// Flat params — @expo/server passes route params as a plain object, not { params: {...} }
type MoviesRouteParams = { collectionId: string };

function makeGetRequest(queryString = ''): [Parameters<typeof GET>[0], MoviesRouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}/movies${queryString ? '?' + queryString : ''}`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
    } as unknown as Parameters<typeof GET>[0],
    { collectionId: COLLECTION_ID },
  ];
}

function makePostRequest(body: unknown): [Parameters<typeof POST>[0], MoviesRouteParams] {
  return [
    {
      url: `http://localhost/bff-api/collections/${COLLECTION_ID}/movies`,
      headers: new Headers({ cookie: 'mcm_access_token=tok' }),
      json: () => Promise.resolve(body),
    } as unknown as Parameters<typeof POST>[0],
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

const createMovieBody = {
  title: 'The Matrix',
  year: 1999,
  contentType: 'Movie',
  language: 'English',
  owned: true,
  ripped: false,
  childrens: false,
  ownedMedia: ['Blu-Ray'],
};

const mockMovieResponse = {
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
  genres: [],
  rated: null,
  directors: [],
  actors: [],
  tags: [],
  movieSet: null,
  originalTitle: null,
  releaseDate: null,
  outline: null,
  plot: null,
  runtime: null,
  externalIds: [],
  createdAt: '2026-05-23T00:00:00.000Z',
  updatedAt: '2026-05-23T00:00:00.000Z',
};

// ─── POST /bff-api/collections/:id/movies ─────────────────────────────────────

describe('POST /bff-api/collections/:id/movies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.post.mockResolvedValue({ status: 201, data: mockMovieResponse });
  });

  it('returns 201 with created movie from mc-service', async () => {
    const res = await POST(...makePostRequest(createMovieBody));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.movieId).toBe(MOVIE_ID);
    expect(data.title).toBe('The Matrix');
    expect(data.collectionId).toBe(COLLECTION_ID);
  });

  it('calls mc-service POST /api/v1/collections/:id/movies with correct collectionId and body', async () => {
    await POST(...makePostRequest(createMovieBody));
    expect(mockMcClient.post).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/movies`,
      createMovieBody,
    );
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('post-jwt');
    await POST(...makePostRequest(createMovieBody));
    expect(createMcServiceClient).toHaveBeenCalledWith('post-jwt');
  });

  it('returns 401 when requireAuth throws UnauthorizedError', async () => {
    (requireAuth as jest.Mock).mockRejectedValueOnce(new UnauthorizedError());
    const res = await POST(...makePostRequest(createMovieBody));
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated user lacks mc-user and mc-admin roles', async () => {
    (requireAuth as jest.Mock).mockResolvedValueOnce({ payload: mockPayload, user: noRoleUserProfile });
    const res = await POST(...makePostRequest(createMovieBody));
    expect(res.status).toBe(403);
  });

  it('propagates mc-service 400 (invalid input) to client', async () => {
    mockMcClient.post.mockRejectedValueOnce(
      makeAxiosError(400, {
        type: 'https://mc-service/errors/invalid-input',
        title: 'Invalid Input',
        status: 400,
        detail: 'title is required',
      }),
    );
    const res = await POST(...makePostRequest({ year: 1999 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.status).toBe(400);
  });

  it('propagates mc-service 404 (collection not found) to client', async () => {
    mockMcClient.post.mockRejectedValueOnce(
      makeAxiosError(404, {
        type: 'https://mc-service/errors/collection-not-found',
        title: 'Collection Not Found',
        status: 404,
        detail: `Collection ${COLLECTION_ID} not found`,
      }),
    );
    const res = await POST(...makePostRequest(createMovieBody));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.status).toBe(404);
  });

  it('propagates mc-service 409 (duplicate movie) to client', async () => {
    mockMcClient.post.mockRejectedValueOnce(
      makeAxiosError(409, {
        type: 'https://mc-service/errors/duplicate-movie',
        title: 'Duplicate Movie',
        status: 409,
        detail: 'A movie with the same title, year, and content type already exists',
      }),
    );
    const res = await POST(...makePostRequest(createMovieBody));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.status).toBe(409);
  });
});

// ─── T119: GET /bff-api/collections/:id/movies (list with query params) ───────

const mockMovieListResponse = {
  items: [mockMovieResponse],
  nextCursor: null as string | null,
};

describe('GET /bff-api/collections/:id/movies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: mockPayload, user: mockUserProfile });
    (extractRawToken as jest.Mock).mockReturnValue('raw-jwt-token');
    mockMcClient.get.mockResolvedValue({ status: 200, data: mockMovieListResponse });
  });

  it('returns 200 with movie list from mc-service', async () => {
    const res = await GET(...makeGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].movieId).toBe(MOVIE_ID);
    expect(data.nextCursor).toBeNull();
  });

  it('calls mc-service GET /api/v1/collections/:id/movies with correct collectionId', async () => {
    await GET(...makeGetRequest());
    expect(mockMcClient.get).toHaveBeenCalledWith(
      `/api/v1/collections/${COLLECTION_ID}/movies`,
      expect.objectContaining({ params: expect.any(Object) }),
    );
  });

  it('forwards cursor query param to mc-service', async () => {
    await GET(...makeGetRequest('cursor=cursor-abc'));
    expect(mockMcClient.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: expect.objectContaining({ cursor: 'cursor-abc' }) }),
    );
  });

  it('forwards search query param to mc-service', async () => {
    await GET(...makeGetRequest('search=batman'));
    expect(mockMcClient.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: expect.objectContaining({ search: 'batman' }) }),
    );
  });

  it('forwards contentType query param to mc-service', async () => {
    await GET(...makeGetRequest('contentType=Series'));
    expect(mockMcClient.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: expect.objectContaining({ contentType: 'Series' }) }),
    );
  });

  it('forwards all list query params to mc-service', async () => {
    await GET(...makeGetRequest(
      'cursor=c1&search=star&contentType=Movie&genre=Action&genre=Drama' +
      '&childrens=false&rated=PG-13&language=English&decade=1990' +
      '&owned=true&ownedMedia=Blu-Ray&ripped=true&ripQuality=Blu-Ray',
    ));
    const callParams = (mockMcClient.get as jest.Mock).mock.calls[0][1].params;
    expect(callParams.cursor).toBe('c1');
    expect(callParams.search).toBe('star');
    expect(callParams.contentType).toBe('Movie');
    expect(callParams.language).toBe('English');
  });

  it('creates mc-service client with the extracted raw JWT', async () => {
    (extractRawToken as jest.Mock).mockReturnValueOnce('get-list-jwt');
    await GET(...makeGetRequest());
    expect(createMcServiceClient).toHaveBeenCalledWith('get-list-jwt');
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

  it('returns nextCursor when more pages exist', async () => {
    mockMcClient.get.mockResolvedValueOnce({
      status: 200,
      data: { items: [mockMovieResponse], nextCursor: 'cursor-page-2' },
    });
    const res = await GET(...makeGetRequest());
    const data = await res.json();
    expect(data.nextCursor).toBe('cursor-page-2');
  });
});
