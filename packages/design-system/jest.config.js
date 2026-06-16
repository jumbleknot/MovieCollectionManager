/**
 * Jest config for the @mcm/design-system package (feature 015).
 * jest-expo gives the React Native + Hermes-like transform; tamagui / @tamagui /
 * react-native-svg ship untranspiled and must be transformed. The two-pattern
 * transformIgnorePatterns mirrors mcm-app's working pnpm setup (the first pattern
 * handles the `.pnpm/<pkg>@ver` store layout, the second the flat layout).
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/components/**/*.test.{ts,tsx}'],
  transformIgnorePatterns: [
    'node_modules/\\.pnpm/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?|@expo-google-fonts|react-navigation|@react-navigation|@unimodules|unimodules|sentry-expo|native-base|react-native-svg|react-native-safe-area-context|@tamagui|tamagui|@react-native-async-storage|uuid)[^/]*/node_modules)',
    'node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?|@expo-google-fonts|react-navigation|@react-navigation|@unimodules|unimodules|sentry-expo|native-base|react-native-svg|react-native-safe-area-context|@tamagui|tamagui|@react-native-async-storage|uuid))',
  ],
};
