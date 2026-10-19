'use strict';

/**
 * Feature 081 US6 (T044) — a `node -r` preload that stands in for `@expo/server/adapter/express`
 * when `bff-server-adapter.test.ts` boots the REAL `server.js` in a child process.
 *
 * Why a preload rather than a build: `server.js` hands `dist/server` (an `expo export` output) to
 * `createRequestHandler`. The behaviour under test is the express layer in FRONT of that handler —
 * route matching, param decoding, static serving, the header middleware — not the Expo bundle, so
 * the handler is replaced by one that echoes what express delivered to it. Everything else in
 * `server.js` (express itself, `web-security-headers.js`) is the real module.
 */
const Module = require('module');

const STUB_ID = '@expo/server/adapter/express';
const originalLoad = Module._load;

Module._load = function load(request, parent, isMain) {
  if (request === STUB_ID) {
    return {
      createRequestHandler: () => (req, res) => {
        res.setHeader('X-Test-Reached-Handler', '1');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: req.method, url: req.url }));
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
