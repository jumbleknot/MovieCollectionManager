# Phase 0 Research: DAST Security Scanning (OWASP ZAP)

All decisions resolve the deferred HOW items from the spec (auth mechanism, runner, token-refresh, allowlist, CI placement). No open `NEEDS CLARIFICATION` remain.

## D1 — Authentication mechanism per target

**Decision**: Two authentication strategies, both driven inside ZAP, keyed by target.

- **Bearer targets — mc-service (`mc-service:3001`) and agent gateway (`movie-assistant-gateway:8000`)**: a ZAP **script-based authentication** (`security/zap/scripts/bearer-auth.js`) performs a Keycloak **ROPC** token request and injects `Authorization: Bearer <jwt>`.
  - Client `mcm-bff-test` (`directAccessGrantsEnabled: true`), user `e2e-test-user` / `${E2E_TEST_PASSWORD}`, realm `grumpyrobot`, endpoint `http://keycloak-service:8080/realms/grumpyrobot/protocol/openid-connect/token`.
  - The minted token's `aud` already includes `movie-collection-manager` (mc-service audience) and `agent-gateway` (verified in `ci-realm.json` audience mappers), and carries the `mc-user` role — so one token satisfies both targets.
  - ZAP's verification strategy (poll a known endpoint; treat 401 as logged-out) triggers **automatic re-authentication**, transparently handling the 300s access-token TTL over a long scan (satisfies FR-013).

- **Cookie target — BFF (`mcm-bff-service-nonsecure:3000`)**: the BFF issues three HttpOnly cookies (`mcm_access_token`, `mcm_refresh_token`, `mcm_session_id`) and requires a real Redis-backed session, so a raw bearer token is insufficient. The scan **reuses the existing Playwright login**: `scripts/zap-scan.mjs` runs (or reuses) the E2E `global-setup` OAuth-PKCE login to obtain `.auth/user.json`, then loads those cookies into the ZAP BFF context. A ZAP httpsender script (`bff-session-refresh.js`) refreshes `mcm_access_token` by calling `POST /bff-api/auth/refresh` (the refresh cookie is path-scoped there) whenever a 401 is observed, keeping the session valid for the full scan (FR-013).

**Rationale**: Maximum reuse of proven, maintained auth (the ROPC client and Playwright login already exist for E2E); deterministic; no fragile browser automation inside the scanner for the API targets; correctly models that the BFF needs a real session, not just a token.

**Alternatives considered**:
- *Browser-based auth inside ZAP (Selenium/Firefox drives the Keycloak form)* — most faithful but flakiest in CI and duplicates Playwright login logic. Rejected (brainstorming option B).
- *Bearer-only, skip BFF session complexity* — undercuts the highest-value target. Rejected (option C).
- *Bump realm/client `accessTokenLifespan` to outlast the scan* — would mutate the shared `ci-realm.json` and could break the `session-timeout` E2E specs that assert expiry. Rejected in favor of ZAP-native re-auth/refresh.

## D2 — ZAP runner & network reachability

**Decision**: Run ZAP as a container (`ghcr.io/zaproxy/zaproxy:stable`) via the Automation Framework (`zap.sh -cmd -autorun <plan>.yaml`), **attached to the existing Compose networks** so it reaches targets by internal DNS (`mcm-bff-service-nonsecure:3000`, `mc-service:3001`, `movie-assistant-gateway:8000`, `keycloak-service:8080`). Launched from the CI job through the mounted rootless docker socket; locally via `scripts/zap-scan.mjs`.

**Rationale**: The agent gateway publishes **no** host port (internal-network only), and mc-service/BFF host ports (`3001`/`8082`) are localhost-bound in CI — network attachment reaches all three uniformly and, critically, **introduces no new published ports**, so the prod/CI port-collision gate (`check-prod-ci-port-collision.mjs`, FR-016) is satisfied by construction.

**Alternatives considered**:
- *Publish temporary host ports for each target and scan `localhost`* — reintroduces the port-collision risk on the shared homelab host and can't reach the gateway without widening its exposure. Rejected.
- *ZAP baseline convenience script (`zap-baseline.py`)* — passive-only and awkward to authenticate; the Automation Framework supersedes it and expresses both modes + auth + reporting in one versioned YAML. Rejected.

## D3 — Scan modes & intensity (per clarifications)

**Decision**: Two AF plans sharing context/auth definitions.
- `zap-baseline.yaml` (local default): spider + **passive** rules only, all three targets, non-destructive (FR-005).
- `zap-full.yaml` (CI): **active** scan (attack payloads) against BFF + mc-service; **spider + passive-only** against the agent gateway (per clarification Q2 — the gateway triggers real LLM runs; active fuzzing is slow/non-deterministic/low-signal).

**Rationale**: Matches the spec's baseline-now/active-in-CI split and the clarified gateway depth. Active scanning is destructive and confined to the ephemeral CI stack (FR-006).

## D4 — Gate semantics & allowlist (per clarification Q1)

**Decision**: The gate is enforced by `scripts/check-dast-findings.mjs`, **not** by ZAP alert filters. It parses the ZAP JSON report, removes findings matched by `security/zap/allowlist.yaml` (keyed by `pluginId` + `uriPattern`, each with a `justification` + `addedBy`), and exits non-zero if any **High-risk** finding remains. Medium/Low are printed as warnings, never fail. The allowlist **is** the baseline — no stored prior-scan diff (clarification Q1).

**Rationale**: FR-010 requires allowlisted findings to stay **visible in reports** (auditable), so suppression must happen at the gate, not by down-ranking alerts in ZAP (which would hide them from the HTML/JSON). Keeping the allowlist in our own gate also makes `--selftest` and unit-testing straightforward.

**Alternatives considered**:
- *ZAP `alertFilter` AF job to mark findings false-positive* — hides them from the report, violating FR-010's "visible, not hidden". Rejected.
- *Diff against a stored `main` baseline report* — extra infrastructure for marginal value; explicitly rejected in clarification Q1. Rejected.

## D5 — Report formats

**Decision**: The AF `report` job emits `traditional-html` (human triage), `traditional-json` (gate input + machine record), and `sarif-json` (code-scanning interchange). Ensure the SARIF report template is available in the image (install the `reports`/SARIF add-on in the plan's `addOns` job if not bundled).

**Rationale**: Satisfies FR-008 (HTML + JSON + SARIF). JSON is the gate's authoritative input; SARIF is the portable artifact for any future viewer.

## D6 — CI job placement

**Decision**: A **separate `dast` job** in `.forgejo/workflows/app-ci.yml`, `runs-on: kvm`, `needs: [changes]`, gated `if: needs.changes.outputs.app == 'true'`. It brings up `auth` + `mcm` (`--profile app --profile bff-nonsecure`) using the same `gen-dev-secrets` + `gen-ci-env` + `ci-realm.json` wiring as `app-e2e`, runs `zap-scan.mjs --target ci --mode full`, uploads reports via `actions/upload-artifact@v3`, runs `check-dast-findings.mjs` to gate, and tears the stacks down on `always()`. Add `dast` to `trigger-cd`'s `needs` with the same skipped-tolerant/failed-blocking rule app-e2e uses.

**Rationale**: Keeps `app-e2e`'s ~23 min unchanged and gives DAST an independent pass/fail + independent artifacts. A new job in `app-ci.yml` posts an `app-ci/dast` status, covered by the existing `app-ci*` required-check glob on protected `main` (feature 023/029), so it gates merges without new branch-protection config.

**Trade-off (documented, not blocking)**: Two heavy jobs (app-e2e + dast) contend for the **single kvm runner** and may serialize, lengthening PR wall-clock. The lighter-weight alternative — appending DAST steps to the end of `app-e2e` (stack already up) — was rejected to preserve independent gating/artifacts and avoid coupling E2E flakiness to the security gate. Path-gating means neither runs on config/docs-only PRs.

## D7 — Test user & secrets

**Decision**: Reuse the existing **`e2e-test-user`** (mc-user, in `ci-realm.json`) and, locally, `testuser` from `.env.e2e.local`. Reuse the existing Forgejo secrets/minted values already consumed by `app-e2e`: `E2E_TEST_PASSWORD`, `E2E_ROPC_CLIENT_SECRET` (client `mcm-bff-test`). No new users, clients, or secrets are introduced.

**Env-var naming**: the scan scripts read `DAST_*` variables (`DAST_TEST_USER`, `DAST_TEST_PASSWORD`, `DAST_ROPC_CLIENT_ID`, `DAST_ROPC_CLIENT_SECRET`) for readability, but `zap-scan.mjs` defaults each from its `E2E_*` equivalent when unset — so the existing E2E secrets are consumed directly with **no new secret material and no CI wiring change**.

**Rationale**: Minimal surface, no new secret material to manage or leak (FR-015), and the ROPC token already carries the right audiences/roles.

## D8 — Destructive-scan safety guard

**Decision**: `zap-scan.mjs` refuses to run `--mode full` unless an explicit disposable-environment marker is present (e.g., `--target ci`/`local-throwaway` plus an env assertion like `DAST_ALLOW_ACTIVE=1`), and never targets a URL outside the known Compose DNS/localhost set. Default invocation is baseline.

**Rationale**: FR-017 — a guard against pointing the destructive active scan at a shared or production environment.

## D9 — Local developer ergonomics (Windows + Bash)

**Decision**: `scripts/zap-scan.mjs` is Node ESM (cross-platform), invoked via `pnpm nx dast infrastructure-as-code` or directly. It shells to `docker` for the ZAP container and to the Compose network. Docs give both PowerShell and Bash invocations per the repo's shell conventions.

**Rationale**: The primary dev shell is PowerShell; Node keeps the runner OS-agnostic and matches `scripts/*.mjs`.
