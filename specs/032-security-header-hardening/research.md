# Phase 0 Research: Security Header Hardening

All items resolve the "how" questions the spec deliberately deferred. No open `NEEDS CLARIFICATION` remain after this phase.

## R1 — Injection layer for global baseline headers

**Decision**: A single Express `app.use((req,res,next)=>{…})` middleware in [server.js](../../frontend/mcm-app/server.js), registered **before** `express.static` and `app.all('*')`, plus `app.disable('x-powered-by')`.

**Rationale**: `server.js` already stamps `X-BFF-Source` on every response class (static, SSR HTML, `/bff-api/*`) — this is the empirical proof that an `app.use` layer reaches all three surfaces. `@expo/server@0.5.3` ignores `+middleware.ts` at runtime (feature 010 / memory `project_expo_server_middleware_gap`), so Expo Router global middleware is a dead end. `app.disable('x-powered-by')` is the Express-native way to drop the `X-Powered-By: Express` banner (F4).

**Alternatives considered**: (a) `+middleware.ts` — rejected, not invoked by the adapter. (b) Per-handler `securityHeaders()` on every SSR route — rejected, SSR pages are not individual handlers we own; the adapter renders them. (c) `helmet` — rejected, adds a dependency whose only real work here would still be a fully-custom CSP; the other four headers are static one-liners.

## R2 — Web-app CSP directive set (enforcing)

**Decision** — starting policy for the browser-rendered surface (iterate against web E2E + browser console, tighten from here):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' <KEYCLOAK_PUBLIC_ORIGIN>;
frame-ancestors 'none';
base-uri 'self';
object-src 'none'
```

**Rationale**:
- `style-src 'unsafe-inline'` — React Native Web + Tamagui inject inline `<style>`/style attributes; without it the app renders unstyled. This is the one unavoidable relaxation for an RN-Web app and is standard.
- `img-src … https:` — TMDB poster URLs are arbitrary HTTPS hosts; `data:` covers inline/data-URI images.
- `connect-src` includes the browser-facing Keycloak origin because `expo-auth-session` fetches Keycloak's `.well-known/openid-configuration` (discovery) via `fetch` from the browser (a `connect-src` request). All other backend traffic is same-origin (`'self'` → the BFF).
- `frame-ancestors 'none'` satisfies the anti-clickjacking finding (F2) at the CSP level; a dedicated `X-Frame-Options: DENY` is set too for old browsers.
- The OAuth authorize step is a top-level navigation (not `fetch`), so it is NOT governed by `connect-src`; no `form-action`/navigation directive is needed for it. (Confirm no console violation during login in the manual check.)

**Empirical unknowns to settle during implementation (report-only dev aid permitted, enforcing at ship — clarification)**:
- Whether the web bundle needs `script-src 'wasm-unsafe-eval'` or `'unsafe-eval'` (Hermes is native-only; the web bundle is plain JS, so likely NOT — verify via console).
- Whether a `worker-src`/`blob:` is needed (some Metro/Expo web features use blob workers — verify).

**How to settle**: run the app with the policy as `Content-Security-Policy-Report-Only` locally, exercise every screen + login, collect any console `Refused to …` violations, add the minimal directive to clear each, then switch the header name to the enforcing `Content-Security-Policy`. Ship enforcing.

**Alternatives considered**: `default-src 'none'` (the API policy) — rejected, blanks the web app. A nonce/hash-based `script-src` — rejected for v1: the exported bundle's script tags are static self-hosted files that `'self'` already covers; nonces would require SSR template control we don't have through the adapter.

## R3 — Keycloak origin source for `connect-src` (FR-007)

**Decision**: `server.js` computes the browser-facing Keycloak origin at boot from `process.env`, in this precedence: `EXPO_PUBLIC_KEYCLOAK_URL` → `KEYCLOAK_PUBLIC_URL` → `KEYCLOAK_URL` → `http://localhost:8099`. Use `||` (treat empty string as absent) to mirror [src/config/keycloak.ts](../../frontend/mcm-app/src/config/keycloak.ts) (the Dockerfile bakes `EXPO_PUBLIC_KEYCLOAK_URL=""` in dev/CI). Reduce the resolved value to its **origin** (`scheme://host[:port]`) via `new URL(...).origin` before inserting into `connect-src`.

**Rationale**: The browser authenticates against — and fetches discovery from — the public Keycloak host, which differs per environment: `localhost:8099` (dev/dev-container/CI), `https://auth.<domain>` (prod). `keycloakPublicUrl` in [env.ts](../../frontend/mcm-app/src/config/env.ts) is exactly "the BROWSER-facing issuer URL"; `server.js` runs in Node and reads the same env at runtime. Sourcing from env satisfies FR-007 (no hard-coding) and keeps the policy correct across all three environments.

**Edge**: in the dev **container** E2E, `KEYCLOAK_URL` points at the internal `keycloak-service:8080` (NOT browser-reachable) while the browser hits `localhost:8099` — so `EXPO_PUBLIC_KEYCLOAK_URL`/`KEYCLOAK_PUBLIC_URL` must be the source there, not `KEYCLOAK_URL`. The precedence above handles it; a task will confirm the dev-container compose sets the public var. Only the origin is added (path/realm stripped) so `connect-src` matches all Keycloak sub-paths.

**Alternatives considered**: hard-coding both origins — rejected (FR-007). A wildcard `https:` in `connect-src` — rejected (defeats the point; would re-open a permissive finding).

## R4 — Header precedence: keep the API surface strict (FR-005/FR-006)

**Decision**: Path-scope the web CSP. In the middleware, set the web-app `Content-Security-Policy` **only when `req.path` does NOT start with `/bff-api`**. The non-CSP headers (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`) and `X-Powered-By` removal apply to ALL paths (they match or are compatible with the API's existing values).

**Rationale**: The `/bff-api/*` handlers already emit `Content-Security-Policy: default-src 'none'` via `securityHeaders()` on their own `Response`. Rather than depend on the `@expo/server` adapter's same-name merge order (whether the handler `Response` value overrides a `res.setHeader` value is an implementation detail of the adapter and could produce a duplicate `Content-Security-Policy` header that ZAP/ browsers treat by intersection), path-scoping is deterministic: the API path never receives the web CSP from `server.js`, so its handler value is the only CSP present. `X-BFF-Source` (a different name) already proves non-conflicting headers pass through, so the always-on headers are safe.

**Verification** (quickstart): curl `/bff-api/auth/init` → exactly one `Content-Security-Policy: default-src 'none'`; curl `/` → exactly one web-app CSP. No duplicate CSP on either.

**Alternatives considered**: relying on Response-wins same-name precedence globally — rejected as adapter-dependent and unverified for SSR; path-scoping removes the ambiguity entirely.

## R5 — Stripping `Access-Control-Allow-Origin` from the agent runtime (FR-008/FR-009)

**Decision**: In [run+api.ts](../../frontend/mcm-app/src/app/bff-api/agent/run+api.ts), wrap the final `handleRequest(req)` call: `const res = await handleRequest(req); res.headers.delete('access-control-allow-origin'); res.headers.delete('access-control-allow-credentials'); return res;`. Delete only the CORS allowance header(s); leave `Content-Type`, transfer-encoding, and the streaming body untouched. Applies to the POST run path (and GET `/info` handshake) — both flow through `gated()` → `handleRequest`.

**Rationale**: The CopilotKit runtime builds its own `Response` (only the early `assistant_not_configured` 200 uses `securityHeaders()`), so its CORS headers pass through unmodified today. The web client and BFF are same-origin, so no `Access-Control-Allow-Origin` is needed at all (clarification: drop entirely). Deleting from the returned `Response.headers` is non-destructive to the stream because `Response` headers are separate from the body `ReadableStream`.

**Runtime verification needed before/at implementation**: curl `/bff-api/agent/run` (authenticated) and inspect which `Access-Control-*` headers the runtime actually emits (ZAP 10098 fires on `*` or reflected Origin). Delete exactly those. If none are present in the current CopilotKit version, the finding may already be latent-only under certain request shapes — the delete is still correct and idempotent (deleting an absent header is a no-op).

**Alternatives considered**: scoping to the app origin — rejected by clarification (drop entirely, same-origin needs none). Editing CopilotKit config — rejected, the runtime doesn't expose a CORS-off switch we control; post-processing the Response is the route's existing wrapping pattern.

## R6 — HSTS at the edge (FR-011)

**Decision**: No new work in `server.js`. Verify the existing [Caddyfile](../../infrastructure-as-code/docker/bff/Caddyfile) HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`, already on line 27) is present on the prod-secure edge, and confirm the production reverse proxy in front of `mcm.<domain>` carries the same header. The plain-HTTP dev/CI BFF and the non-secure container set no HSTS (correct — HSTS on plain HTTP is ignored/misconfiguring).

**Rationale**: HSTS belongs only on the HTTPS-terminating edge (constitution + PRD constraint 5). Caddy already owns it for the feature-007 secure container; the app layer must NOT set it. The scan ran against the non-secure `:8082` container (no HTTPS), which is why ZAP didn't flag HSTS — re-verify against the secure container / prod edge.

**Alternatives considered**: setting HSTS in `server.js` — rejected (would emit on plain HTTP dev/CI, which is wrong and can brick localhost over HTTP).

## R7 — Allowlisting the timestamp false positive (FR-012)

**Decision**: Append one entry to [security/zap/allowlist.yaml](../../security/zap/allowlist.yaml):

```yaml
- pluginId: "10096"
  uriPattern: "http://.*/_expo/static/.*"
  justification: "Timestamp Disclosure (Unix) — the flagged values are numeric constants inside the compiled Expo JS bundle (build artifacts / source-map offsets), not server clock or secret material. Confirmed false positive."
  addedBy: "steve"
```

**Rationale**: The allowlist is consumed only by `scripts/check-dast-findings.mjs`; ZAP still lists the finding in the HTML/JSON report (visible, un-triaged-noise removed). Scoping `uriPattern` to `/_expo/static/.*` keeps the suppression narrow (only the bundle path), never blanket. Schema requires `pluginId`, `uriPattern`, `justification`, `addedBy` (blank justification/addedBy is a gate error).

**Note**: 10096 is Low/Info, and the gate fails only on un-allowlisted **High**, so this entry does not change pass/fail today — but it records the triage decision durably and satisfies FR-012/SC-006 (suppressed from gate consideration, still in the report).

**Alternatives considered**: deleting the finding / disabling rule 10096 in the ZAP policy — rejected, that removes it from the report too (loses the audit trail); the allowlist keeps it visible.

## R8 — Test strategy (FR-015)

**Decision**: Two-layer TDD.
1. **Unit (RED→GREEN)** — `web-security-headers.test.js` (Jest) on the pure builder: asserts the exact web-app CSP string (with a stubbed Keycloak origin), the four static headers, that the builder marks `/bff-api` paths as CSP-exempt, and encodes the `x-powered-by`-absence expectation. Fails before the module exists / before `server.js` wires it.
2. **E2E (integration proof)** — `tests/e2e/web/security-headers.spec.ts` (Playwright): `request.get('/')` and a static asset (`/_expo/static/...` or `/favicon.ico`) assert the baseline headers present + `x-powered-by` absent; `request.get('/bff-api/auth/init')` asserts the CSP is still `default-src 'none'`. Runs against the dev-container BFF (deterministic path, feature 007) for the real `server.js`.

**Rationale**: The unit test gives a fast, deterministic RED/GREEN on the header values without a running server; the Playwright test proves the wiring end-to-end through the real adapter across surfaces (the only way to catch an adapter merge/precedence surprise). Matches constitution TDD-checkpoint format.

**Alternatives considered**: BFF integration test booting `server.js` in-process — viable but heavier than the pure-builder unit test; the Playwright dev-container assertion already covers the live-server integration, so a separate integration harness is redundant.
