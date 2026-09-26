// Assistant runtime globals — WEB (feature 077; the native loader is assistant-polyfills.native.ts).
//
// Imported FIRST by app/_layout.tsx, on every platform. On web there is nothing to polyfill:
// `TextEncoder`/`TextDecoder`, a streaming `fetch`, `crypto.getRandomValues`, the DOM globals and
// `location` are all native to the platform, and the CopilotKit React Native polyfills that install
// them all guard on the global first — so on web they ran, checked, and did nothing.
//
// They were not free, though. The `require`s are static, so Metro put `text-encoding` (535 KB) and
// `web-streams-polyfill` (61 KB) in the ENTRY chunk: 596 KB of unreachable code in front of the first
// paint, for every user, on every route. That is 14% of the pre-077 bundle.
//
// THIS COULD NOT BE FIXED INSIDE THE POLYFILL BARREL, and it is worth recording why the obvious
// alternative fails. `@copilotkit/react-native/dist/headless.mjs` opens with `import "./polyfills.mjs"`
// — a side effect of the package's OWN entry point — so any import of the package drags the barrel in.
// Removing only this file's explicit `require`s while the root layout still imported the package
// saved 69 KB of 4.28 MB. The split has to be at the platform boundary, here.
//
// What web DOES need is the refresh-retry wrapper: the CopilotKit runtime fetch to /bff-api/agent/run
// bypasses the axios token-refresh interceptor on every platform, so a `/run` that meets an expired
// `mcm_access_token` cookie must refresh and retry once. See utils/agent-fetch-refresh.ts.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
require('./utils/agent-fetch-refresh').installAgentFetchRefresh();
