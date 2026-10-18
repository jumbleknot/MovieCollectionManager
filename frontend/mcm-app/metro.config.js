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
const { getDefaultConfig } = require('expo/metro-config');
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

module.exports = config;
