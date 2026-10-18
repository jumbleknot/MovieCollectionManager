// Metro config (feature 012). Expo defaults + two scoped resolver overrides.
//
// CopilotKit (@copilotkit/react-native → @copilotkit/shared) statically imports its
// telemetry client, which imports `@segment/analytics-node` — a server-side analytics
// library that transitively pulls `jose`, whose Node build does `require('crypto')`
// (node:crypto is unavailable in React Native / Hermes). The Android/iOS bundle therefore
// fails with "Unable to resolve module crypto from jose/.../node/cjs/runtime/verify.js".
//
// Client-side Segment telemetry has no place in the mobile app, so we redirect
// `@segment/analytics-node` to a no-op shim (metro-shims/segment-analytics-node.js). This
// removes the entire telemetry subtree (jose + node:crypto + node http) from the bundle.
// Scoped to that one module — every other package resolves exactly as before, so the
// existing mobile flows' bundle is unchanged. Web/BFF are unaffected (Node has crypto).
//
// Second override (item #242): the project-root dotenv files Expo's own transform-worker cannot
// parse are kept out of Metro's file map entirely — see metro-env-blocklist.js for the mechanism.
//
// Third (feature 081 US10): the Tamagui optimizing compiler. Tamagui 3 removed the Babel plugin that
// ran it before (feature 015, babel.config.js); it now runs as `withTamagui()` from
// @tamagui/metro-plugin, applied LAST so it wraps the two overrides above (it captures this config's
// resolver and Babel transformer and delegates to them). It is what lets Metro tree-shake the
// `@mcm/design-system` barrel instead of pulling in the whole Tamagui graph — the graph that
// OOM-crashed Metro's dev bundler before feature 015. It touches the Android bundle too.
//
// CACHE: upstream, the plugin does NOT invalidate Metro's transform cache when the Tamagui config
// changes but app sources do not. After editing tamagui.config.ts or the design system's tokens or
// themes, clear it: `rm -rf node_modules/.cache/tamagui` and run Expo with `--clear` (`expo start -c`).
const { getDefaultConfig } = require('expo/metro-config');
const { withTamagui } = require('@tamagui/metro-plugin');
const path = require('path');
const { unparseableDotenvBlockList } = require('./metro-env-blocklist');

const config = getDefaultConfig(__dirname);

// `expo/virtual/env.js` becomes `require.context(<projectRoot>, false, /^\.\/\.env/)` in dev, which
// hands Babel every crawled `.env*` file in this directory — including `.env.e2e.local`, which is
// not one of the six names Expo dotenv-parses. Blocking it is what stops `pnpm web` 500ing.
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : [config.resolver.blockList]),
  unparseableDotenvBlockList(__dirname),
].filter(Boolean);

const segmentStub = path.join(__dirname, 'metro-shims', 'segment-analytics-node.js');

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@segment/analytics-node') {
    return context.resolveRequest(context, segmentStub, platform);
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = withTamagui(config, {
  components: ['@mcm/design-system'],
  config: './tamagui.config.ts',
});
