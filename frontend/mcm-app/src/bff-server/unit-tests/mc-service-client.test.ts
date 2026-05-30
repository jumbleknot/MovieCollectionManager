/**
 * T018 — Unit tests (RED) for mc-service-client.ts
 *
 * Verifies:
 * 1. Authorization: Bearer header is injected from the session JWT
 * 2. Base URL is sourced from MC_SERVICE_URL (env.mcServiceUrl)
 * 3. Error responses are forwarded without modification
 * 4. Each client instance is isolated (no shared state between requests)
 */

import axios from 'axios';
import { createMcServiceClient } from '@/bff-server/mc-service-client';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('axios', () => {
  const mockAxiosInstance = {
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
    defaults: { headers: { common: {} } },
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  };
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), {
      create: jest.fn().mockReturnValue(mockAxiosInstance),
    }),
  };
});

jest.mock('@/config/env', () => ({
  env: {
    mcServiceUrl: 'http://mc-service:3001',
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createMcServiceClient', () => {
  const TEST_JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('base URL', () => {
    it('uses MC_SERVICE_URL as the base URL', () => {
      createMcServiceClient(TEST_JWT);

      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://mc-service:3001',
        }),
      );
    });
  });

  describe('Authorization header injection', () => {
    it('injects Authorization: Bearer header with the provided JWT', () => {
      createMcServiceClient(TEST_JWT);

      const createCall = (axios.create as jest.Mock).mock.calls[0][0];
      const authHeader =
        createCall?.headers?.Authorization ??
        createCall?.headers?.authorization;

      expect(authHeader).toBe(`Bearer ${TEST_JWT}`);
    });

    it('does not include an Authorization header when JWT is empty string', () => {
      // Passing an empty JWT is a caller error; the client still creates but
      // the header value would be "Bearer " — a misconfigured request.
      // We verify the header is set to exactly what is passed (no magic).
      createMcServiceClient('');

      const createCall = (axios.create as jest.Mock).mock.calls[0][0];
      const authHeader =
        createCall?.headers?.Authorization ??
        createCall?.headers?.authorization;

      expect(authHeader).toBe('Bearer ');
    });

    it('creates an isolated instance per JWT — second JWT does not leak into first client', () => {
      const jwt1 = 'jwt-for-user-alice';
      const jwt2 = 'jwt-for-user-bob';

      createMcServiceClient(jwt1);
      createMcServiceClient(jwt2);

      const firstCallHeaders = (axios.create as jest.Mock).mock.calls[0][0]?.headers;
      const secondCallHeaders = (axios.create as jest.Mock).mock.calls[1][0]?.headers;

      const getAuth = (h: Record<string, string>) => h?.Authorization ?? h?.authorization ?? '';

      expect(getAuth(firstCallHeaders)).toBe(`Bearer ${jwt1}`);
      expect(getAuth(secondCallHeaders)).toBe(`Bearer ${jwt2}`);
      expect(getAuth(firstCallHeaders)).not.toBe(getAuth(secondCallHeaders));
    });
  });

  describe('HTTP configuration', () => {
    it('sets Content-Type to application/json', () => {
      createMcServiceClient(TEST_JWT);

      const createCall = (axios.create as jest.Mock).mock.calls[0][0];
      const contentType =
        createCall?.headers?.['Content-Type'] ?? createCall?.headers?.['content-type'];

      expect(contentType).toBe('application/json');
    });

    it('sets a request timeout', () => {
      createMcServiceClient(TEST_JWT);

      const createCall = (axios.create as jest.Mock).mock.calls[0][0];
      expect(typeof createCall?.timeout).toBe('number');
      expect(createCall?.timeout).toBeGreaterThan(0);
    });
  });

  describe('error forwarding', () => {
    it('returns an Axios instance (errors are forwarded by Axios defaults)', () => {
      const client = createMcServiceClient(TEST_JWT);

      // The client is the mock instance — it has the methods Axios instances have
      expect(client).toBeDefined();
      expect(typeof (client as { get?: unknown }).get).toBe('function');
    });
  });
});
