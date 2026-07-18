/**
 * Jest config for BFF integration tests (T004a).
 *
 * Distinct from the package.json `jest` block (jest-expo / React Native preset,
 * jsdom-ish) used by `pnpm nx test mcm-app`. Integration tests exercise BFF
 * server-side modules and HTTP endpoints against REAL Keycloak + Redis + mc-service,
 * so they run in a Node environment with:
 *   - `setupFiles` setting REDIS_URL to db 1 (and loading .env.e2e.local) before
 *     any module initialises — see tests/integration/setup/env.ts
 *   - `@/` path mapping mirroring tsconfig `paths`
 *   - a tiny react-native stub so server source that transitively imports
 *     `@/config/keycloak` (which reads `Platform.OS`) resolves in Node
 *
 * No mocking of integrated dependencies — constitution v1.3.0 (Test Type Integrity).
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.integration.test.ts'],
  // Feature 041 (T004): when MCM_REQUIRE_LIVE_STACK=1 (CI app-e2e), probe the required live deps
  // ONCE before the suite and throw if any is down — the jest arm of the shared skip-escalation
  // convention, so a misconfigured CI run fails loudly instead of skipping-to-green. No-op locally.
  globalSetup: '<rootDir>/tests/integration/setup/preflight.global.js',
  setupFiles: ['<rootDir>/tests/integration/setup/env.ts'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
  transformIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/tests/integration/setup/react-native-stub.js',
    '^expo/virtual/env$': '<rootDir>/tests/integration/setup/expo-env-stub.js',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 30000,
  // Integration tests share real external state (Redis db 1, the running BFF,
  // Keycloak). Run serially so per-file `flushdb`/teardown in one file cannot wipe
  // another file's data mid-test (parallel workers caused exactly that).
  maxWorkers: 1,
  // BFF source opens its own ioredis connection (cache-service) that has no public
  // close; force exit so the suite never hangs on that open handle in CI.
  forceExit: true,
};
