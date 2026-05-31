/**
 * Remaining auth endpoints integration tests (T020) — US8 / FR-022 / SC-011.
 *
 * HTTP-level against the running BFF + real Keycloak + Redis — no mocking
 * (constitution v1.3.0). Covers init, verify-email (failure paths), and
 * resend-verification (validation / no-enumeration / rate-limit).
 *
 * The email-verification happy path consumes a Keycloak email action-token from
 * the verification link, which is not obtainable headlessly — covered by the
 * manual/E2E verification flow (same rationale as the login exclusion).
 */
import { randomUUID } from 'node:crypto';
import { createBffClient } from './helpers/bff-test-server';

const bff = createBffClient();
const uniqueEmail = () => `int_resend_${randomUUID().replace(/-/g, '').slice(0, 12)}@test.invalid`;

describe('remaining auth endpoints — integration (real BFF + Keycloak + Redis)', () => {
  describe('GET /bff-api/auth/init', () => {
    it('returns ok (auth-agnostic; ensures client redirect URIs) (US8-AC1)', async () => {
      const res = await bff.get('/bff-api/auth/init');
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });
  });

  describe('GET /bff-api/auth/verify-email', () => {
    it('returns 400 invalid-token when no token is provided (US8-AC2)', async () => {
      const res = await bff.get('/bff-api/auth/verify-email');
      expect(res.status).toBe(400);
      expect(res.data.code).toBe('VERIFICATION_TOKEN_INVALID');
    });

    it('returns 400 for a malformed/expired token (US8-AC2)', async () => {
      const res = await bff.get('/bff-api/auth/verify-email?token=not-a-real-action-token');
      expect(res.status).toBe(400);
      expect(['VERIFICATION_TOKEN_INVALID', 'VERIFICATION_TOKEN_EXPIRED']).toContain(res.data.code);
    });
  });

  describe('POST /bff-api/auth/resend-verification', () => {
    it('returns 400 for an invalid email (US8-AC3)', async () => {
      const res = await bff.post('/bff-api/auth/resend-verification', { email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect(res.data.code).toBe('INVALID_EMAIL');
    });

    it('returns generic 200 for an unknown email (no enumeration) (US8-AC3)', async () => {
      const res = await bff.post('/bff-api/auth/resend-verification', { email: uniqueEmail() });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('rate-limits beyond the per-email limit (3/hour) (US8-AC3)', async () => {
      const email = uniqueEmail();
      // Rate limit is checked before user lookup, so any email triggers it.
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await bff.post('/bff-api/auth/resend-verification', { email });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses).toContain(429);
    });
  });
});
