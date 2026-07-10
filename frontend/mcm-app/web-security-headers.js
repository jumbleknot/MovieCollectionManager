'use strict';

/**
 * Web security-header builder (feature 032, US1) — a pure, plain-CommonJS module so the
 * hand-written `server.js` Expo adapter can `require()` it at container boot (it cannot import
 * the app's compiled TS — research R1 / plan Structure Decision).
 *
 * Governs: FR-001 (CSP), FR-002 (X-Frame-Options), FR-003 (X-Content-Type-Options),
 * FR-004 (Referrer-Policy), FR-006 (API surface keeps its strict CSP — the caller path-scopes
 * the web CSP out of `/bff-api` using `isApiPath`), FR-007 (Keycloak origin sourced from env,
 * never hard-coded), FR-010 (baseline coverage across web + static surfaces).
 *
 * Oracle: specs/032-security-header-hardening/contracts/security-headers-contract.md.
 */

/** Browser-facing Keycloak origin fallback for dev/CI when no env var is set (research R3). */
const DEFAULT_KEYCLOAK_ORIGIN = 'http://localhost:8099';

/**
 * sha256 of Expo Router's one inline bootstrap script — `globalThis.__EXPO_ROUTER_HYDRATE__=true;`
 * — served verbatim in the SSR HTML shell (dev AND prod; constant content, so the hash is stable
 * across builds). Allow-listing it by hash keeps `script-src` free of `'unsafe-inline'` (T006, the
 * strong option). If Expo ever changes that inline script the browser will print the new expected
 * hash in the CSP violation message — swap it here.
 *
 * NOTE (accepted residual, T006 2026-07-09): a third-party library runs a `new Function("")`
 * eval-availability PROBE wrapped in try/catch that returns false when blocked. Under this strict
 * `script-src` the probe is blocked, the library degrades gracefully (the app is fully functional),
 * and the browser logs ONE benign `eval` CSP violation. We deliberately do NOT add `'unsafe-eval'`
 * to silence it — permitting real eval app-wide would defeat the hardening. This one probe line is
 * the documented, accepted residual.
 */
const EXPO_HYDRATE_SCRIPT_HASH = "'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='";

/** The three always-on static baseline headers (identical on every non-API + API response). */
const STATIC_SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/**
 * Reduce a Keycloak URL (which may carry a realm/discovery path) to its bare origin
 * (`scheme://host[:port]`). On a malformed/missing value fall back to the localhost default so
 * the CSP `connect-src` never contains a broken token (FR-007).
 * @param {string | undefined} keycloakOrigin
 * @returns {string}
 */
function resolveKeycloakOrigin(keycloakOrigin) {
  try {
    return new URL(keycloakOrigin).origin;
  } catch {
    return DEFAULT_KEYCLOAK_ORIGIN;
  }
}

/**
 * Build the web-app Content-Security-Policy string (enforcing, delivered as
 * `Content-Security-Policy`, never report-only — clarification 2026-07-09). Directive set is
 * research R2, tuned to run React Native Web + Tamagui: `style-src 'unsafe-inline'` for the
 * injected inline styles, `img-src https:` for arbitrary TMDB poster hosts, and `connect-src`
 * carrying the browser-facing Keycloak origin (expo-auth-session fetches OIDC discovery).
 * @param {string} keycloakOrigin bare origin (already reduced)
 * @returns {string}
 */
function buildWebContentSecurityPolicy(keycloakOrigin) {
  return [
    "default-src 'self'",
    `script-src 'self' ${EXPO_HYDRATE_SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${keycloakOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    // form-action has no default-src fallback (undefined = allow anything). The app's forms submit
    // via fetch to the same-origin BFF; the OAuth authorize step is a top-level NAVIGATION, not a
    // form submit (research R2), so 'self' does not impede login. Clears ZAP 10055 (no-fallback).
    "form-action 'self'",
  ].join('; ');
}

/**
 * Build the full baseline header set for the browser-rendered/static web surface: the web-app
 * CSP plus the three static headers. `server.js` precomputes this once at boot and stamps it
 * per request (setting the CSP only on non-`/bff-api` paths — see `isApiPath`).
 * @param {{ keycloakOrigin?: string }} [opts]
 * @returns {Record<string, string>}
 */
function buildWebSecurityHeaders(opts) {
  const origin = resolveKeycloakOrigin(opts && opts.keycloakOrigin);
  return {
    'Content-Security-Policy': buildWebContentSecurityPolicy(origin),
    ...STATIC_SECURITY_HEADERS,
  };
}

/**
 * True for BFF API paths (`/bff-api/*`), which keep their own strict `default-src 'none'` CSP
 * emitted by the route handlers. The caller uses this to path-scope the web CSP out of the API
 * surface deterministically (FR-005/FR-006 — research R4), rather than rely on adapter
 * same-name header merge order.
 * @param {string} pathname
 * @returns {boolean}
 */
function isApiPath(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/bff-api');
}

module.exports = {
  DEFAULT_KEYCLOAK_ORIGIN,
  STATIC_SECURITY_HEADERS,
  buildWebSecurityHeaders,
  buildWebContentSecurityPolicy,
  resolveKeycloakOrigin,
  isApiPath,
};
