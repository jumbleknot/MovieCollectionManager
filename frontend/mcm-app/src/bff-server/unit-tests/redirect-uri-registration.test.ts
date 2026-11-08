/**
 * ensureClientRedirectUris records its work as done only when it was (feature 085 US4, item #753 —
 * FR-010/FR-011, SC-005).
 *
 * Before 085 a REJECTED `PUT` still latched the per-process "done" mark, so a sign-in address that
 * was never registered stayed unregistered until a restart, with nothing logged. Each case uses its
 * own client id because the mark is per client, per process.
 */

import { ensureClientRedirectUris } from '@/bff-server/keycloak';
import { logger } from '@/bff-server/logger';

jest.mock('@/bff-server/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    audit: jest.fn(),
  },
}));

global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

const ADMIN_TOKEN = 'admin-token-value';
const CLIENT_REPRESENTATION = {
  id: 'internal-id',
  clientId: 'x',
  secret: 'client-secret-value',
  redirectUris: ['https://app/existing'],
};

function res(status: number, data: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

/** Route the admin calls by URL/method; `put` and `lookup` choose the statuses under test. */
function keycloak({ put = 204, lookup = 200 }: { put?: number; lookup?: number } = {}): {
  puts: () => number;
} {
  let puts = 0;
  mockedFetch.mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('/protocol/openid-connect/token'))
      return res(200, { access_token: ADMIN_TOKEN });
    if (u.includes('/clients?clientId=')) return res(lookup, [{ id: 'internal-id' }]);
    if ((init as RequestInit | undefined)?.method === 'PUT') {
      puts += 1;
      return res(put);
    }
    return res(200, CLIENT_REPRESENTATION);
  });
  return { puts: () => puts };
}

const warnings = (): unknown[][] =>
  (logger.warn as jest.Mock).mock.calls.filter(
    ([msg]) => msg === 'redirect_uri_registration_failed',
  );

beforeEach(() => jest.clearAllMocks());

describe('ensureClientRedirectUris (feature 085)', () => {
  it.each([403, 400, 500])(
    'a rejected update (%i) is retried on the next call and warned about (AS-1, AS-2)',
    async (status) => {
      const kc = keycloak({ put: status });
      await ensureClientRedirectUris(['https://app/new'], `client-rejected-${status}`);
      await ensureClientRedirectUris(['https://app/new'], `client-rejected-${status}`);

      expect(kc.puts()).toBe(2);
      expect(warnings()).toHaveLength(2);
      expect(warnings()[0][1]).toEqual(expect.objectContaining({ step: 'update', status }));
      const serialized = JSON.stringify(warnings());
      for (const secret of [
        ADMIN_TOKEN,
        'client-secret-value',
        'https://app/new',
        'https://app/existing',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    },
  );

  it('a successful update is not repeated (AS-3)', async () => {
    const kc = keycloak({ put: 204 });
    await ensureClientRedirectUris(['https://app/new'], 'client-accepted');
    await ensureClientRedirectUris(['https://app/new'], 'client-accepted');
    expect(kc.puts()).toBe(1);
    expect(warnings()).toHaveLength(0);
  });

  it('nothing missing means no update, and the step is done (AS-3)', async () => {
    const kc = keycloak();
    await ensureClientRedirectUris(['https://app/existing'], 'client-complete');
    await ensureClientRedirectUris(['https://app/existing'], 'client-complete');
    expect(kc.puts()).toBe(0);
    expect(
      mockedFetch.mock.calls.filter(([u]) => String(u).includes('/clients?clientId=')).length,
    ).toBe(1);
  });

  it('a failed client lookup stays unrecorded and says so (edge case)', async () => {
    keycloak({ lookup: 500 });
    await ensureClientRedirectUris(['https://app/new'], 'client-lookup-fails');
    keycloak({ lookup: 200, put: 204 });
    await ensureClientRedirectUris(['https://app/new'], 'client-lookup-fails');
    expect(warnings()[0][1]).toEqual(
      expect.objectContaining({ step: 'client_lookup', status: 500 }),
    );
    expect(
      mockedFetch.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      ),
    ).toBe(true);
  });
});
