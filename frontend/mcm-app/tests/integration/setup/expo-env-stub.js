/**
 * Stub for `expo/virtual/env` in the Node integration environment (T004a).
 *
 * babel-preset-expo's env-inlining transform rewrites `process.env.*` access into
 * an `import { env } from 'expo/virtual/env'`. That real module is shipped as ESM
 * and is not transformed (node_modules is ignored by the integration transform),
 * so it throws "Unexpected token 'export'". In the unit suite this works only
 * because jest-expo whitelists expo for transformation. Server-side, `env` is just
 * `process.env`, so we resolve the virtual module to that directly.
 */
module.exports = { env: process.env };
