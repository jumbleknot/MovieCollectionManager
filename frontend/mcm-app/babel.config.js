/** @type {import('@babel/core').TransformOptions} */
module.exports = function (api) {
  api.cache(true);

  // No Tamagui compiler (feature 081 US10, operator decision on OQ-5). Tamagui 3 removed the Babel
  // plugin that ran here since feature 015, and its replacement, @tamagui/metro-plugin 3.0.x, was
  // measured to drop the CSS of the web modules it lowers while saving no bytes — so Tamagui runs
  // runtime-only, as the dev server and the export were measured to handle without OOM.
  //
  // react-native-reanimated v4 requires the worklets babel plugin, and it MUST be listed
  // last (feature 012 / CopilotKit overlay). Plugin moved to react-native-worklets in
  // reanimated 4 (was react-native-reanimated/plugin in v3).
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
