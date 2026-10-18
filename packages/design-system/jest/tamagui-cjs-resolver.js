/**
 * Jest resolver: load Tamagui 3's CommonJS build where its `react-native` export is ESM-only.
 *
 * Feature 081 US10. Tamagui 3.0.x maps two subpaths' `react-native` export condition to an ES module
 * file (`.mjs`) with no `.native.js` variant: `@tamagui/style-grammar/token-categories` (required by
 * `@tamagui/helpers`, so by every Tamagui component) and `@tamagui/core/inject-styles`. Metro loads
 * `.mjs` fine, so the app is unaffected; Jest cannot — it treats `.mjs` as native ESM, which needs
 * `--experimental-vm-modules`, and every suite rendering a Tamagui component failed to run with
 * "Unexpected token 'export'" (measured on the 3.0.13 bump: 56 suites). The exports map blocks a
 * `moduleNameMapper` to the deep `dist/cjs` path, so the redirect happens here instead: resolve
 * exactly as the jest-expo preset does, and only when that lands on a Tamagui `dist/esm/*.mjs` file
 * whose package ships the same module at `dist/cjs/*.cjs`, return the CJS file.
 *
 * Shared by packages/design-system/jest.config.js and frontend/mcm-app's jest config.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// The preset's own resolver (react-native's), so every other module resolves exactly as before.
const presetResolver = require(require.resolve('jest-expo/jest-preset', { paths: [process.cwd(), __dirname] })).resolver;
const base = presetResolver ? require(presetResolver) : (request, options) => options.defaultResolver(request, options);

const ESM_ONLY = /([\\/]@tamagui[\\/][^\\/]+[\\/]dist[\\/])esm([\\/].*)\.mjs$/;

module.exports = (request, options) => {
  const resolved = base(request, options);
  const m = ESM_ONLY.exec(resolved);
  if (!m) return resolved;
  const cjs = resolved.slice(0, m.index) + `${m[1]}cjs${m[2]}.cjs`;
  return fs.existsSync(cjs) ? cjs : resolved;
};
