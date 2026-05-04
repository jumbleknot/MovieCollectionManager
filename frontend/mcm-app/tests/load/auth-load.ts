/**
 * Load test for auth endpoints using k6 (T-123)
 *
 * Run: k6 run tests/load/auth-load.ts
 *
 * Acceptance thresholds (SC-007):
 * - 99.5% login success rate (http_req_failed < 0.5%)
 * - p95 login response < 5000ms
 * - p95 profile response < 2000ms
 * - Concurrent users: ≤500
 * - Login throughput: ≤100 requests/minute
 */

// @ts-check — k6 uses its own module system (not Node.js)

// k6 imports use the k6 module system, not Node.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
export { options, default as default_ } from './auth-load-impl';

/**
 * NOTE: This file documents k6 load test configuration.
 * To run: install k6 (https://k6.io/docs/get-started/installation/)
 *
 * k6 run tests/load/auth-load.ts (requires k6 TypeScript support via webpack/esbuild)
 * or export as JS and run: k6 run tests/load/auth-load.js
 */
