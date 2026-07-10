/**
 * Web security-header contract (feature 032, US1) — Playwright response-header assertion
 * across the three response classes served by the BFF `server.js` adapter.
 *
 * Governs: FR-001..FR-006, FR-010, FR-015. Oracle:
 * specs/032-security-header-hardening/contracts/security-headers-contract.md.
 *   - Surface 1 (SSR HTML `GET /`): the baseline CSP + X-Frame-Options + nosniff + Referrer-Policy,
 *     and NO X-Powered-By.
 *   - Surface 2 (static asset `GET /favicon.ico`): at least `nosniff` (the load-bearing static
 *     assertion, F3) + no X-Powered-By.
 *   - Surface 3 (JSON API `GET /bff-api/auth/init`): the strict CSP `default-src 'none'` is
 *     UNCHANGED (path-scoping keeps the web CSP off the API surface).
 *
 * These are public routes — no session needed, so the whole file opts out of the shared
 * global-setup storageState. Run against the dev-container BFF for the real `server.js`:
 *   E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/security-headers.spec.ts
 */
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

// Public surface — no authenticated state required.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('web security headers (032 US1)', () => {
  test('SSR HTML shell carries the baseline headers and no X-Powered-By (Surface 1)', async ({ request }) => {
    const res = await request.get(`${BASE}/`);
    const h = res.headers();

    const csp = h['content-security-policy'];
    expect(csp, 'CSP header present on /').toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");

    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-powered-by']).toBeUndefined();
  });

  test('static asset carries nosniff and no X-Powered-By (Surface 2)', async ({ request }) => {
    const res = await request.get(`${BASE}/favicon.ico`);
    const h = res.headers();

    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-powered-by']).toBeUndefined();
  });

  test('JSON API surface keeps the strict CSP unchanged (Surface 3)', async ({ request }) => {
    const res = await request.get(`${BASE}/bff-api/auth/init`);
    const h = res.headers();

    expect(h['content-security-policy']).toBe("default-src 'none'");
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-powered-by']).toBeUndefined();
  });
});
