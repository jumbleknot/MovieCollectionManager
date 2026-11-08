/**
 * Unit tests for assignMcUserRole (feature 092).
 *
 * Registration gives a new account its access here. A refusal at any step must surface: production
 * refused the client lookup with 403, and the role-assignment POST was never checked at all, so a
 * refusal there would have reported success for an account with no access.
 */

import { AuthError, AuthErrorCode } from '@/types/errors';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('@/bff-server/request-context', () => ({
  getRequestId: () => 'req-test',
}));

import { assignMcUserRole } from '@/bff-server/keycloak';

function ok(body: unknown, code = 200): Response {
  return { ok: true, status: code, json: async () => body } as unknown as Response;
}

function refused(code: number): Response {
  return {
    ok: false,
    status: code,
    json: async () => ({ error: 'refused' }),
  } as unknown as Response;
}

const token = () => ok({ access_token: 'admin-token' });
const client = () => ok([{ id: 'client-internal-id' }]);
const role = () => ok({ id: 'role-id', name: 'mc-user' });

async function expectUnavailable(): Promise<void> {
  const error = await assignMcUserRole('user-1').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(AuthErrorCode.KEYCLOAK_UNAVAILABLE);
  expect((error as AuthError).statusCode).toBe(502);
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('assignMcUserRole', () => {
  it('assigns mc-user when every step succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(client())
      .mockResolvedValueOnce(role())
      .mockResolvedValueOnce(ok(undefined, 204));

    await expect(assignMcUserRole('user-1')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[3];
    expect(String(url)).toMatch(/\/users\/user-1\/role-mappings\/clients\/client-internal-id$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual([{ id: 'role-id', name: 'mc-user' }]);
  });

  it('fails when the client lookup is refused, as production did with 403', async () => {
    mockFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(refused(403));

    await expectUnavailable();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fails when the role cannot be read, and does not post an error body as the role', async () => {
    mockFetch
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(client())
      .mockResolvedValueOnce(refused(403));

    await expectUnavailable();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('fails when the assignment itself is refused', async () => {
    mockFetch
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(client())
      .mockResolvedValueOnce(role())
      .mockResolvedValueOnce(refused(403));

    await expectUnavailable();
  });
});
