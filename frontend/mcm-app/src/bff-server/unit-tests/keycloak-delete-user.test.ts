/**
 * Unit tests for deleteUser (feature 076, T003 — FR-021, FR-027).
 *
 * The admin-token round trip is real code; only `fetch` is stubbed.
 *
 * The case that matters is 404. Account deletion's last step is irreversible and every step
 * before it is retryable, so a retry after a partial failure WILL re-issue this delete against
 * an account that is already gone. If 404 threw, the retry could never complete.
 */

import { AuthError } from '@/types/errors';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('@/bff-server/request-context', () => ({
  getRequestId: () => 'req-test',
}));

import { deleteUser } from '@/bff-server/keycloak';

function adminTokenOk(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'admin-token' }),
  } as unknown as Response;
}

function status(code: number): Response {
  return { ok: code >= 200 && code < 300, status: code } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('deleteUser', () => {
  it('resolves when Keycloak answers 204', async () => {
    mockFetch.mockResolvedValueOnce(adminTokenOk()).mockResolvedValueOnce(status(204));

    await expect(deleteUser('user-1')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[1];
    expect(String(url)).toMatch(/\/users\/user-1$/);
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer admin-token',
    });
  });

  it('treats 404 as success, so a retry after a partial failure can complete', async () => {
    mockFetch.mockResolvedValueOnce(adminTokenOk()).mockResolvedValueOnce(status(404));

    await expect(deleteUser('already-gone')).resolves.toBeUndefined();
  });

  it('throws when Keycloak refuses the deletion', async () => {
    mockFetch.mockResolvedValueOnce(adminTokenOk()).mockResolvedValueOnce(status(403));

    await expect(deleteUser('user-2')).rejects.toBeInstanceOf(AuthError);
  });

  it('throws when Keycloak fails the deletion', async () => {
    mockFetch.mockResolvedValueOnce(adminTokenOk()).mockResolvedValueOnce(status(500));

    await expect(deleteUser('user-3')).rejects.toBeInstanceOf(AuthError);
  });

  it('URL-encodes the user id so a crafted id cannot alter the admin path', async () => {
    mockFetch.mockResolvedValueOnce(adminTokenOk()).mockResolvedValueOnce(status(204));

    await deleteUser('a/../../realms');

    const [url] = mockFetch.mock.calls[1];
    expect(String(url)).not.toContain('/../');
    expect(String(url)).toContain(encodeURIComponent('a/../../realms'));
  });
});
