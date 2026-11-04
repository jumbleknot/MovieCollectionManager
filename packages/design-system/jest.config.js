/**
 * Jest config for the @mcm/design-system package (feature 015).
 * jest-expo gives the React Native + Hermes-like transform; tamagui / @tamagui /
 * react-native-svg ship untranspiled and must be transformed. The two-pattern
 * transformIgnorePatterns mirrors mcm-app's working pnpm setup (the first pattern
 * handles the `.pnpm/<pkg>@ver` store layout, the second the flat layout).
 */
module.exports = {
  preset: 'jest-expo',
  // A literal cap, not Jest's (cores − 1) default: on the 20-vCPU dev sandbox that default spawned
  // ~19 workers (~0.9 GB each at peak) and the VM-wide OOM killer took Keycloak (feature 086). The
  // cap is an integer because the constraint is memory, which does not scale with core count. A
  // worker that keeps growing past the idle limit is replaced between test files. mcm-app's `jest`
  // block carries the same two values; scripts/__tests__/dev-memory-bounds.guard.test.mjs pins both.
  maxWorkers: 4,
  workerIdleMemoryLimit: '1.5GB',
  // Tamagui 3 ESM-only `react-native` exports -> CJS (feature 081 US10); see the resolver header.
  resolver: '<rootDir>/jest/tamagui-cjs-resolver.js',
  // Was `components/**` only, which silently EXCLUDED tokens/ — with-alpha.test.ts was written,
  // committed and never executed, reporting green while testing nothing. Match the whole
  // package instead, so a new test directory cannot be invisible to the runner again.
  testMatch: ['<rootDir>/**/*.test.{ts,tsx}'],
  testPathIgnorePatterns: ['/node_modules/'],
  transformIgnorePatterns: [
    'node_modules/\\.pnpm/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?|@expo-google-fonts|react-navigation|@react-navigation|@unimodules|unimodules|sentry-expo|native-base|react-native-svg|react-native-safe-area-context|@tamagui|tamagui|@react-native-async-storage|uuid)[^/]*/node_modules)',
    'node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?|@expo-google-fonts|react-navigation|@react-navigation|@unimodules|unimodules|sentry-expo|native-base|react-native-svg|react-native-safe-area-context|@tamagui|tamagui|@react-native-async-storage|uuid))',
  ],
};
