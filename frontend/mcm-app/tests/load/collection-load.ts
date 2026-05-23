/**
 * Load test for movie collection endpoints (T164)
 *
 * Thresholds (SC-004, SC-006):
 * - p95 home screen collection list  < 3s
 * - p95 movie list (first page)      < 3s
 * - p95 movie text search            < 3s
 *
 * Run via Nx (after setting env vars):
 *   BASE_URL=http://localhost:8081 LOAD_TEST_COOKIE="mcm-session=..." pnpm nx test:load mcm-app
 *
 * Or directly with k6 (after compiling):
 *   npx esbuild tests/load/collection-load-impl.ts --bundle --platform=browser \
 *     --outfile=tests/load/collection-load-impl.js
 *   k6 run -e BASE_URL=http://localhost:8081 -e LOAD_TEST_COOKIE="mcm-session=..." \
 *     tests/load/collection-load-impl.js
 */

// @ts-check — k6 uses its own module system (not Node.js)
export { options, setup, teardown, default as default_ } from './collection-load-impl';
