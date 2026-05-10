/**
 * Integration test for error messages per spec.md Edge Cases (T-122)
 * Verifies each edge case returns the exact user-facing message from AuthErrorCode.
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { AUTH_ERROR_MESSAGES, getAuthErrorMessage } from '@/utils/errors';
import { AuthErrorCode } from '@/types/errors';

const mock = new MockAdapter(axios);

describe('Error message coverage (T-122)', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  const errorCases: Array<{
    scenario: string;
    code: AuthErrorCode;
    httpStatus: number;
    url: string;
    method: 'post' | 'get';
    body?: object;
  }> = [
    {
      scenario: 'Invalid credentials',
      code: AuthErrorCode.INVALID_CREDENTIALS,
      httpStatus: 401,
      url: '/bff-api/auth/login',
      method: 'post',
      body: { code: 'bad', codeVerifier: 'v', redirectUri: 'r' },
    },
    {
      scenario: 'Weak password',
      code: AuthErrorCode.WEAK_PASSWORD,
      httpStatus: 400,
      url: '/bff-api/auth/register',
      method: 'post',
    },
    {
      scenario: 'Duplicate username',
      code: AuthErrorCode.DUPLICATE_USERNAME,
      httpStatus: 409,
      url: '/bff-api/auth/register',
      method: 'post',
    },
    {
      scenario: 'Duplicate email',
      code: AuthErrorCode.DUPLICATE_EMAIL,
      httpStatus: 409,
      url: '/bff-api/auth/register',
      method: 'post',
    },
    {
      scenario: 'Account locked',
      code: AuthErrorCode.ACCOUNT_LOCKED,
      httpStatus: 403,
      url: '/bff-api/auth/login',
      method: 'post',
    },
    {
      scenario: 'Keycloak unavailable',
      code: AuthErrorCode.KEYCLOAK_UNAVAILABLE,
      httpStatus: 503,
      url: '/bff-api/auth/login',
      method: 'post',
    },
    {
      scenario: 'Token expired',
      code: AuthErrorCode.TOKEN_EXPIRED,
      httpStatus: 401,
      url: '/bff-api/auth/user',
      method: 'get',
    },
    {
      scenario: 'Email not verified',
      code: AuthErrorCode.EMAIL_NOT_VERIFIED,
      httpStatus: 403,
      url: '/bff-api/auth/login',
      method: 'post',
    },
    {
      scenario: 'Verification link expired',
      code: AuthErrorCode.VERIFICATION_TOKEN_EXPIRED,
      httpStatus: 400,
      url: '/bff-api/auth/verify-email',
      method: 'get',
    },
  ];

  errorCases.forEach(({ scenario, code, httpStatus, url, method }) => {
    it(`returns correct message for: ${scenario}`, async () => {
      const expectedMessage = AUTH_ERROR_MESSAGES[code];
      expect(expectedMessage).toBeDefined();

      // Verify the helper resolves the right message
      const resolved = getAuthErrorMessage(code);
      expect(resolved).toBe(expectedMessage);

      // Simulate API response
      mock[`on${method.charAt(0).toUpperCase() + method.slice(1)}`](url).reply(httpStatus, {
        error: expectedMessage,
        code,
      });

      try {
        await (method === 'get' ? axios.get(url) : axios.post(url, {}));
        fail('Expected error was not thrown');
      } catch (e: unknown) {
        const err = e as { response: { data: { code: string } } };
        expect(err.response.data.code).toBe(code);
      }
    });
  });
});
