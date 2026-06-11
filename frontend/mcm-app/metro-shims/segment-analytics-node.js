// No-op stub for `@segment/analytics-node` in the React Native bundle (feature 012).
//
// CopilotKit's telemetry (`@copilotkit/shared` → telemetry-client → Segment) is a
// server-side analytics library that must NOT be bundled into the mobile app: its real
// implementation pulls `jose`, whose Node build requires `node:crypto` (unavailable on
// Hermes), breaking the Android/iOS bundle. The telemetry client constructs
// `new Analytics(...)` and calls `.track(...)` unconditionally in React Native (its
// `COPILOTKIT_TELEMETRY_DISABLED` gate reads `process.env`, which is empty at runtime on
// native), so an empty module would throw "undefined is not a constructor". This no-op
// preserves the API surface and sends nothing from the client. Metro redirects
// `@segment/analytics-node` here (see metro.config.js); web/BFF are unaffected.
class Analytics {
  constructor() {}
  track() {}
  identify() {}
  page() {}
  group() {}
  flush() {
    return Promise.resolve();
  }
  closeAndFlush() {
    return Promise.resolve();
  }
}

module.exports = { Analytics };
