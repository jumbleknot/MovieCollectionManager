// CopilotKit React Native polyfills loader — NATIVE ONLY (feature 012; split for web in 077).
//
// WHY THIS FILE IS `.native.ts` NOW. The polyfills below are no-ops on web: every one guards on the
// global it installs (`if (typeof g.TextEncoder === "undefined")`), and on web those globals already
// exist. But the `require`s are STATIC, so Metro bundled the libraries regardless — `text-encoding`
// (535 KB) and `web-streams-polyfill` (61 KB), 596 KB of code that could never execute, in the ENTRY
// chunk, downloaded by every user before any route could paint.
//
// Deferring the assistant panel does NOT remove them, and that is worth stating because it is the
// intuitive and wrong conclusion: `app/_layout.tsx` imports this module at the ROOT, eagerly, so the
// polyfill graph is reachable without the panel ever loading. Measured — deferring the panel alone
// left the entry chunk at 2,379,727 B with text-encoding fully present; splitting this file as well
// took it to ~1.83 MB.
//
// The unsuffixed `assistant-polyfills.ts` is the WEB version, per the constitution's rule that the
// default file is web and platform variants carry the suffix.
//
// Hermes/React Native lack Web globals CopilotKit needs: `crypto.getRandomValues` (uuid — the
// runtime-info fetch throws `crypto.getRandomValues() not supported` without it), a streaming
// `fetch` (SSE agent runs), and `TextEncoder`. The crypto polyfill warns via `console.warn` at
// import time; LogBox only suppresses FUTURE logs, so we register the ignore BEFORE loading it
// (otherwise the banner overlaps the bottom-left assistant-dock toggle). `require` runs inline
// (not hoisted like `import`), guaranteeing the ignore is in place first. No-ops on web.
import { LogBox } from 'react-native';

LogBox.ignoreLogs(['[CopilotKit] Installing non-cryptographic']);

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
require('@copilotkit/react-native/polyfills/crypto');
require('@copilotkit/react-native/polyfills');

// Wrap globalThis.fetch so an expired access-token cookie on the agent /run route triggers a
// silent refresh + retry (the CopilotKit transport bypasses the axios refresh interceptor).
// Installed here — after the streaming-fetch polyfill, before CopilotKit issues any run.
require('./utils/agent-fetch-refresh').installAgentFetchRefresh();
