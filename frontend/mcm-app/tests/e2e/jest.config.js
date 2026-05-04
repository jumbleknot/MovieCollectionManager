/** @type {import('@jest/types').Config.InitialOptions} */
const config = {
  testEnvironment: 'detox/runners/jest/testEnvironment',
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/jest.setup.ts'],
  testTimeout: 120000,
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  testMatch: ['<rootDir>/tests/e2e/**/*.test.{ts,tsx}'],
  reporters: ['detox/runners/jest/reporter'],
  verbose: true,
};

module.exports = config;
