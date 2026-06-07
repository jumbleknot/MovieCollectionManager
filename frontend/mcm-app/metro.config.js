// Metro config (feature 012). Expo defaults + one scoped resolver override.
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
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

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
