/**
 * Unit tests for BFF resource-identifier validation (009 finding #10, FR-017).
 * A malformed collectionId/movieId must be rejected with a 400 at the edge,
 * before any upstream mc-service call (no path/parameter smuggling, no opaque 500).
 */

jest.mock('@/bff-server/auth', () => ({
  requireAuth: jest.fn().mockResolvedValue({ user: { id: 'u1', roles: ['mc-user'] } }),
  extractRawToken: jest.fn().mockReturnValue('jwt-token'),
}));

jest.mock('@/bff-server/role-check', () => ({
  requireMcUser: jest.fn(),
}));

const mockGet = jest.fn();
jest.mock('@/bff-server/mc-service-client', () => ({
  createMcServiceClient: jest.fn(() => ({
    get: mockGet,
    patch: jest.fn(),
    put: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  })),
}));

import { GET } from '@/app/bff-api/collections/[collectionId]/index+api';
import { createMcServiceClient } from '@/bff-server/mc-service-client';

function makeReq(): Request {
  return {
    url: 'http://localhost/bff-api/collections/x',
    headers: new Headers(),
  } as unknown as Request;
}

describe('BFF resource-id validation (009 #10)', () => {
  beforeEach(() => jest.clearAllMocks());

  // Only path/query-smuggling ids are rejected at the edge. Well-formed-but-unknown
  // ids (and legitimately-shadowed sub-paths like "filter-options") are forwarded —
  // mc-service returns 404 for unknown ids (009 #10 root-cause fix).
  it.each([
    '../admin/stats',
    '0123456789abcdef01234567/movies', // contains a separator
    '0123%2f..', // encoded separator + traversal
    'a b', // whitespace
    '', // empty
  ])('rejects smuggling collectionId %p with 400 and no upstream call', async (badId) => {
    const res = await GET(makeReq(), { collectionId: badId });
    expect(res.status).toBe(400);
    expect(createMcServiceClient).not.toHaveBeenCalled();
  });

  it('allows a well-formed ObjectId through to the upstream client', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { ok: true } });
    const res = await GET(makeReq(), { collectionId: '0123456789abcdef01234567' });
    expect(res.status).toBe(200);
    expect(createMcServiceClient).toHaveBeenCalled();
  });

  it('forwards a safe non-ObjectId segment (e.g. shadowed sub-path) to upstream', async () => {
    mockGet.mockResolvedValue({ status: 404, data: { error: 'not found' } });
    const res = await GET(makeReq(), { collectionId: 'filter-options' });
    expect(createMcServiceClient).toHaveBeenCalled(); // not rejected at the edge
    expect(res.status).toBe(404); // upstream decides
  });
});
