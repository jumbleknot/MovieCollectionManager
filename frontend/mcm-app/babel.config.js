/** @type {import('@babel/core').TransformOptions} */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-reanimated v4 requires the worklets babel plugin, and it MUST be
    // listed last (feature 012 / CopilotKit overlay). Plugin moved to react-native-worklets
    // in reanimated 4 (was react-native-reanimated/plugin in v3).
    plugins: ['react-native-worklets/plugin'],
  };
};
