/** @type {import('@babel/core').TransformOptions} */
module.exports = function (api) {
  api.cache(true);

  // The Tamagui optimizing compiler (feature 015). It flattens/optimizes design-system
  // components and — crucially — lets Metro tree-shake the `@mcm/design-system` barrel so
  // importing one component no longer pulls the whole Tamagui library into the web bundle
  // (that un-tree-shaken graph OOM-crashed Metro's dev bundler). It is a JS-only transform
  // (no native-build impact, unlike @tamagui/metro-plugin). Excluded under NODE_ENV=test so
  // the Jest unit suite renders Tamagui at runtime unchanged.
  const isTest = process.env.NODE_ENV === 'test';

  const plugins = [];
  if (!isTest) {
    plugins.push([
      '@tamagui/babel-plugin',
      {
        components: ['tamagui', '@mcm/design-system'],
        config: './tamagui.config.ts',
      },
    ]);
  }
  // react-native-reanimated v4 requires the worklets babel plugin, and it MUST be listed
  // last (feature 012 / CopilotKit overlay). Plugin moved to react-native-worklets in
  // reanimated 4 (was react-native-reanimated/plugin in v3).
  plugins.push('react-native-worklets/plugin');

  return {
    presets: ['babel-preset-expo'],
    plugins,
  };
};
