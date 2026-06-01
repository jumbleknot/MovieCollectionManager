# Phase 0 Research: E2E Against the BFF Docker Container

Decision / Rationale / Alternatives for each design question. The four spec clarifications (Dev=relaxed, Prod=HTTPS-hardened, CI=local-only, mobile=BFF-only) are settled; this resolves the HOW.

## R1 — Dev container configuration (the easy path)

**Decision**: Reuse the existing `mcm-bff:latest` image; run a **dev-config** instance with `NODE_ENV=development` (compose env override) on plain HTTP. The BFF's cookie hardening is runtime-gated — `auth.ts`: `const secure = !env.isDevelopment ? '; Secure' : ''`, and `env.isDevelopment` reads `process.env.NODE_ENV` **dynamically** (not babel-inlined, confirmed in 006). So a `NODE_ENV=development` container emits **non-Secure** cookies that the browser sends over HTTP → the feature-006 `no_token`-over-HTTP blocker disappears without any code change. JWKS/discovery/admin already use runtime `env.keycloakUrl` (006 fix), so Keycloak is reachable from the container.

**Rationale**: This is the same cookie posture dev/Metro already uses, so it is not a new security relaxation and needs no app change — only a compose service with `NODE_ENV=development`. It isolates the "BFF in a container" variable from the prod-hardening variables.

**Alternatives**: Forcing Secure cookies in the dev container (rejected — re-introduces the HTTP `no_token` problem for no benefit); a separate dev Dockerfile (rejected — same image, env-only difference is simpler).

**Open risk (spike T-early)**: confirm the feature-006 `Premature close` login symptom does **not** persist with the dev container now that the issuer fix is merged. Expected resolved (it traced to the inlined `localhost:8099` Keycloak URL, now runtime). If it persists, it is an Expo prod-bundle server-streaming issue → folds into R6.

## R2 — Mobile: Metro JS bundle + container BFF on separate ports

**Decision**: Metro keeps serving the **JS bundle** on `:8081` (debug APK via `adb reverse tcp:8081`). The BFF **container** serves `/bff-api` on a **separate** host port (e.g. `:8082`). Start Metro with `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082`, and `adb reverse tcp:8082 tcp:8082`, so the bundle Metro serves makes its BFF calls to the container while the app code/bundle still comes from Metro. `bff-url.ts` already resolves the native BFF base from `EXPO_PUBLIC_BFF_NATIVE_URL`, and it is inlined at Metro bundle time → restarting Metro with the var set is sufficient (no APK rebuild).

**Rationale**: The clarified scope is BFF-only containerization for mobile. Metro and the container cannot share `:8081`, so a second port + the existing native-BFF-URL env is the minimal wiring. `10.0.2.2` is avoided (broken on this host — project memory); use `localhost` via `adb reverse`.

**Alternatives**: Release-bundled Metro-free APK pointing at the container (rejected per clarification — bigger rework, out of scope); container on `:8081` with Metro elsewhere (rejected — the app's debug-host/Metro contract is fixed at `:8081`).

## R3 — Prod container over HTTPS (the hardened path)

**Decision**: Run `mcm-bff` with `NODE_ENV=production` (Secure cookies) behind a **TLS-terminating reverse proxy** container (**Caddy** — auto local CA / trivial self-signed) on `https://localhost:8443`. 
- **Web**: Playwright with `ignoreHTTPSErrors: true` + `baseURL=https://localhost:8443` → `Secure` cookies are sent over HTTPS, hardening intact.
- **Mobile**: the emulator must **trust the proxy's CA**. Use `mkcert` (or Caddy's local CA) and install the root CA on the emulator (`adb push` + settings, or a debug `network_security_config.xml` trusting a bundled CA). This is the main prod-mobile risk.

**Rationale**: HTTPS is the no-weakening way to satisfy `Secure` cookies (FR-007). Caddy gives one-line TLS with a local CA. Playwright trivially ignores cert errors; Android does not, hence the CA-trust step.

**Alternatives**: env-gated `Secure`-off (rejected by clarification — weakens hardening); a real public cert (rejected — overkill for local E2E); skipping mobile prod E2E (rejected — FR-006 requires both clients, though mobile-CA-trust is flagged as the escalation risk if infeasible).

## R4 — "Which server" marker (FR-002)

**Decision**: `server.js` sets a response header `X-BFF-Source: ${process.env.BFF_SOURCE ?? 'unknown'}` on all responses; the dev-container service sets `BFF_SOURCE=dev-container`, the prod service `BFF_SOURCE=prod-container`. Metro (`expo start`) never sets this header. 
- **Web**: `global-setup.ts` asserts the header on a `/bff-api/*` response before trusting the run.
- **Mobile**: assert the container received the app's calls — check the header via a request the test issues, or assert the container's request log shows the flow's `/bff-api` hits (Metro's BFF would have none).

**Rationale**: A positive, unambiguous signal (a header only the container emits) defeats the "silent Metro fallback / something answered on the port" false-green (edge case). One line in `server.js`, env-driven per variant.

**Alternatives**: port-only check (rejected — Metro could occupy the port); a `/bff-api/health` build-id endpoint (heavier; the header covers all responses).

## R5 — Web E2E harness targeting the container

**Decision**: Env-driven target in `playwright.config.ts`: when `E2E_BFF_TARGET=dev-container|prod-container`, (a) set `baseURL` to the container/proxy URL, (b) **disable** the `webServer` auto-start (do not spawn Metro), (c) for `prod-container` set `ignoreHTTPSErrors: true`. Default (unset) keeps today's Metro behavior for iterative dev. `global-setup.ts` warms routes + asserts the `X-BFF-Source` marker.

**Rationale**: Keeps iterative dev on Metro (FR-004) while the final run targets the container, with no separate config file to drift. The container removes Metro JIT, so the 006 web-flakiness should vanish (a real SC-003 green becomes achievable).

**Alternatives**: a second `playwright.container.config.ts` (rejected — duplication/drift); relying on `reuseExistingServer` only (rejected — fragile; doesn't set HTTPS/baseURL/marker).

## R6 — Prod login/refresh/SSO-logout reconciliation (the hard, spike-gated part)

**Decision**: Time-box a spike against the prod container (HTTPS) to reproduce and fix, in order: (1) login completes + session persists (verify the 006 `Premature close` is gone post-issuer-fix; if not, investigate the Expo `@expo/server` express adapter response streaming under `NODE_ENV=production`); (2) access-token expiry → transparent refresh works against the container; (3) logout terminates the BFF session **and** the Keycloak SSO session. Encode the lifecycle as a new Playwright test (login → fake-clock expiry → refresh → logout). Apply only the minimal `bff-server` fixes the spike proves necessary; each is security-path → covered by the FR-008 review.

**Rationale**: These are the exact blockers documented in `project_web_e2e_container_blockers`; they are real but now partially de-risked (issuer fixed, Secure cookies handled by HTTPS). Spiking first prevents over-building.

**Alternatives**: assume-and-fix without reproduction (rejected — wasted effort, as 006 showed); defer prod entirely (rejected — it is the feature's higher-assurance half, explicitly in scope).

## R7 — Compose profiles + cleanup

**Decision**: Extend `infrastructure-as-code/docker/bff/compose.yaml` (and the root `include:`) with a **dev-config** BFF service (`NODE_ENV=development`, HTTP, `BFF_SOURCE=dev-container`, port `:8082`) and a **prod** path (the existing `mcm-bff` `NODE_ENV=production` + a `caddy` TLS proxy, `BFF_SOURCE=prod-container`). Gate them behind profiles `bff-dev` / `bff-prod`. Cleanup (US4) = `docker compose --profile bff-dev/bff-prod down` removing only the BFF + proxy containers (reusing the running `mcm-redis`, never touching the persistent external volumes), then restart Metro.

**Rationale**: Matches the existing profile/`include:` architecture (CLAUDE.md volume notes); keeps the persistent stack intact on teardown (edge case).

**Alternatives**: ad-hoc `docker run` (rejected — bypasses the compose network/volume model); a brand-new compose file (rejected — duplicates wiring).

## Open items requiring human decision (escalation candidates)

1. **Prod-mobile CA trust** (R3): if installing the test CA on the emulator proves infeasible/flaky, escalate — options are a debug `network_security_config`, `mkcert` CA install, or (last resort) documenting prod-mobile E2E as CA-trust-limited while prod-web passes.
2. **Prod login-streaming reconciliation** (R6): if the spike uncovers a deep `@expo/server` adapter issue, escalate scope before committing to a large fix.
