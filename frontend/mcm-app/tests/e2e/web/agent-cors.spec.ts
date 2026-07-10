/**
 * Agent endpoint CORS contract (feature 032, US2) — the `/bff-api/agent/run` runtime response
 * must carry NO cross-origin allowance header (ZAP 10098). Governs FR-008/FR-009. Oracle:
 * contracts/security-headers-contract.md Surface 4.
 *
 * T007 established that CopilotKit 1.59.5 (`copilotRuntimeNextJSAppRouterEndpoint` with no `cors`
 * option) defaults to `cors: true` → an empty config → `Access-Control-Allow-Origin: *` on every
 * runtime response, and no `Access-Control-Allow-Credentials`. So this is a genuine RED→GREEN:
 * RED (before T009) sees `*`; GREEN (after T009 deletes the header) sees `undefined`.
 *
 * The header only appears on a response that REACHES the CopilotKit runtime — i.e. after the
 * per-handler auth gate passes. The unauthenticated 401 path uses securityHeaders() (no CORS).
 * So this test drives the runtime `/info` GET with the shared authenticated session.
 *
 * Run against the dev-container BFF:
 *   E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/agent-cors.spec.ts
 */
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

test.describe('agent endpoint CORS (032 US2)', () => {
  test('runtime /info response carries no Access-Control-Allow-Origin / -Credentials', async ({ request }) => {
    // GET reaches gated(req, false) → auth passes (shared session) → CopilotKit runtime /info.
    const res = await request.get(`${BASE}/bff-api/agent/run`);
    // Must have passed auth to reach the runtime (else the 401 securityHeaders() path has no CORS
    // and the assertion would be vacuously green).
    expect(res.status(), 'expected an authenticated (non-401) runtime response').not.toBe(401);

    const h = res.headers();
    expect(h['access-control-allow-origin']).toBeUndefined();
    expect(h['access-control-allow-credentials']).toBeUndefined();
  });
});
