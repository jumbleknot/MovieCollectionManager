// CopilotKit React Native polyfills loader (feature 012). Imported FIRST by app/_layout.tsx.
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
