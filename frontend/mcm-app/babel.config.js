/** @type {import('@babel/core').TransformOptions} */
module.exports = function (api) {
  api.cache(true);

  // The Tamagui optimizing compiler no longer runs here. Tamagui 3 removed its Babel plugin (feature
  // 081 US10); the compiler now runs through `withTamagui()` in metro.config.js, which keeps what this
  // file used to provide (feature 015): Metro can tree-shake the `@mcm/design-system` barrel instead of
  // OOM-crashing its dev bundler on the whole Tamagui graph.
  //
  // react-native-reanimated v4 requires the worklets babel plugin, and it MUST be listed
  // last (feature 012 / CopilotKit overlay). Plugin moved to react-native-worklets in
  // reanimated 4 (was react-native-reanimated/plugin in v3).
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
