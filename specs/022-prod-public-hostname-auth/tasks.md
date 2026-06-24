---
description: "Task list for feature 022 — Production Public-Hostname Authentication"
---

# Tasks: Production Public-Hostname Authentication

**Input**: Design documents from `/specs/022-prod-public-hostname-auth/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓

**Feature nature**: Infrastructure / config-as-code. **No application code changes** (the BFF already separates `KEYCLOAK_PUBLIC_URL` issuer from internal `KEYCLOAK_URL`, and the `Secure` cookie flag is `NODE_ENV`-driven — research R1/R4). Deliverables are Docker Compose files, a sanitized realm export, `.env.prod.example` templates, a naming-gate allowlist edit, and prod-APK build wiring.

**Tests for this feature** = the repository **guardrails** run as RED→GREEN gates (constitution mandates Verify RED / Verify GREEN; `docs/templates/feature-test-tasks-template.md`):

- `node scripts/check-resource-naming.mjs` — resource/network naming
- `node scripts/check-no-inline-secrets.mjs` — no inline literals in compose
- `node scripts/secret-scan.mjs` — whole-tree credential scan (run `--selftest` then plain)
- `docker compose -f <file> config` — interpolation + fail-fast on missing `${VAR:?}`
- existing **web E2E (Playwright)** login + **BFF cookie unit** tests — regression surface
- **off-network device login** — documented **manual** E2E (see [contracts/verification.md](./contracts/verification.md), item 7)

**Out of repo (document, do not code)**: Komodo Stack definitions, Cloudflare published routes, real secret injection, the on-device test — Work-Order Parts C/D.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (maps to spec.md user stories)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the prod config locations and keep real secrets out of git before any compose file is authored.

- [ ] T001 [P] Create the prod-config directory skeleton: ensure `infrastructure-as-code/docker/keycloak/` and `infrastructure-as-code/docker/bff/` exist, and create `infrastructure-as-code/docker/keycloak/secrets/` (gitignored target for `keycloak_db_password.txt`).
- [ ] T002 [P] Gitignore for prod values — **already in place** (done with the domain-parameterization change): root `.gitignore` ignores real values via the existing `*.env.*` rule and `secrets/`, and adds `!infrastructure-as-code/docker/**/*.env.prod.example` so the committed placeholder templates stay tracked. Re-verify only: `git check-ignore infrastructure-as-code/docker/keycloak/.env.prod` (ignored) and `…/.env.prod.example` (NOT ignored, exit 1).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The naming gate must approve `edge-network` BEFORE any prod compose referencing it enters the gated path (`infrastructure-as-code/docker/**/compose*.yaml`), or `naming-gate.yml` fails on the very first prod file. This is the one true cross-story blocker (FR-024, research R7).

**⚠️ CRITICAL**: No prod compose task (US1/US2) can be committed clean until T003–T004 land.

- [ ] T003 [P] **Verify RED**: add a throwaway `edge-network` reference (or a temporary `compose.prod.yaml` stub declaring `networks: { edge-network: {} }`) and run `node scripts/check-resource-naming.mjs`.
  - **Covers**: FR-024 (new network must pass the naming gate before entering the gated path).
  - **Expected RED output**: non-zero exit; a failure line naming the unapproved network, e.g. `✖ network "edge-network" is not in APPROVED_NETWORKS` (exact wording per the script). A pass here means the stub didn't enter the gated path — fix before proceeding. Capture the failure, then revert the stub.
- [ ] T004 Add `edge-network` to `APPROVED_NETWORKS` in [scripts/check-resource-naming.mjs](../../scripts/check-resource-naming.mjs); if a naming-convention doc exists at `contracts/naming-convention.md` (repo root) document `edge-network` (ingress network for Cloudflare Tunnel) there too. (FR-024)
  - **Verify GREEN**: re-run `node scripts/check-resource-naming.mjs` against the stub from T003 → exit 0, output `✔ resource naming: 0 violations` (or equivalent clean summary).

**Checkpoint**: `edge-network` is gate-approved; prod compose files can now be authored and committed clean.

---

## Phase 3: User Story 1 - Production identity provider on the public auth hostname (Priority: P1) 🎯 MVP

**Goal**: A production Keycloak deployable today on `auth.${BASE_DOMAIN}` — production mode, public issuer fixed, admin off the public host, brute-force on, sanitized realm imported on start. Depends only on the upstream Keycloak image (not the app build pipeline).

**Independent Test**: From a public network, fetch `https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` → `issuer` equals the public `auth.` origin; realm + `movie-collection-manager` client + `mc-admin`/`mc-user` roles present; admin console not served on the public host (only on the tailnet address); brute-force locks an account after the threshold.

### Realm export (US1)

- [ ] T005 [US1] Export the dev `grumpyrobot` realm and sanitize into `infrastructure-as-code/docker/keycloak/prod-realm.json`: strip dev redirect URIs (`localhost:8099`, `10.0.2.2`), strip real client secrets + SMTP creds, set `bruteForceProtected: true`, `registrationAllowed: false`, leave `smtpServer` empty/placeholder, keep `movie-collection-manager` client + `mc-admin`/`mc-user` roles. **FR-009**: this `prod-realm.json` MUST be a distinct file from the throwaway CI realm export used by the build pipeline — do not reuse or symlink the CI realm; confirm no `--import-realm` path in any CI/build compose points at `prod-realm.json`. (FR-006, FR-007, FR-008, FR-009, FR-011, research R8)
- [ ] T006 [US1] Set the OAuth client's prod **web** redirect URI(s) in `prod-realm.json`: valid-redirect `https://mcm.${BASE_DOMAIN}/*` and web-origins `https://mcm.${BASE_DOMAIN}` (no wildcard). The committed realm keeps the literal `${BASE_DOMAIN}` placeholder; at deploy it is rendered to a **gitignored concrete realm file** via `envsubst` (research R11) — the import mount points at the rendered file, never the real domain in git. Mobile callback is added in US2/T013. (FR-017 web half, FR-018, data-model "OAuth application client")

### Keycloak prod compose + secret template (US1)

- [ ] T007 [US1] Author `infrastructure-as-code/docker/keycloak/compose.prod.yaml` (`name: prod-auth`) by adapting the committed draft `docs/proposals/homelab-setup/keycloak-prod.compose.yaml`: `command: start`, `KC_HOSTNAME=https://auth.${BASE_DOMAIN:?set in keycloak/.env.prod}` (the host is interpolated, never the literal domain), `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`, `KC_HTTP_ENABLED=true`, `KC_PROXY_HEADERS=xforwarded`, `KC_HOSTNAME_ADMIN`=tailnet URL, admin port bound to the tailscale IP only, `KC_HEALTH_ENABLED=true`, `--import-realm` with a read-only mount of the **rendered** realm file (T006), no published Postgres port, no mailpit service, networks `keycloak-network`/`backend-network`/`edge-network`. (FR-001–FR-005, FR-010, FR-011, research R11)
- [ ] T008 [US1] Wire fail-fast secrets in `compose.prod.yaml`: `KC_BOOTSTRAP_ADMIN_PASSWORD=${KC_BOOTSTRAP_ADMIN_PASSWORD:?set in keycloak/.env.prod}`, Postgres `POSTGRES_PASSWORD_FILE` → `secrets/keycloak_db_password.txt` (file-secret), `KC_DB_PASSWORD` ref equal to that file's value. No inline literal, no `:-`/`??` default anywhere. (FR-020, FR-022, FR-025, data-model cross-entity invariants)
- [ ] T009 [P] [US1] Create `infrastructure-as-code/docker/keycloak/.env.prod.example` with placeholders only: `BASE_DOMAIN=`, `KC_DB_PASSWORD=`, `KC_BOOTSTRAP_ADMIN_PASSWORD=` (no real values, no fallback defaults). `BASE_DOMAIN` feeds both the `KC_HOSTNAME`/admin host interpolation and the realm `envsubst` render. (FR-021, research R11)

### Gate checkpoint for US1

- [ ] T010 [US1] **Verify GREEN (gates)**: run `node scripts/secret-scan.mjs --selftest` then `node scripts/secret-scan.mjs`, `node scripts/check-no-inline-secrets.mjs`, and `node scripts/check-resource-naming.mjs`. (FR-023, SC-005)
  - **Covers**: SC-005 (both secret gates + naming gate pass for the new KC files).
  - **Expected GREEN output**: `--selftest` exits 0 (detector self-check passes); each gate exits 0 with a zero-findings summary (e.g. `0 findings` / `0 violations`) for `prod-realm.json`, `compose.prod.yaml`, `.env.prod.example`.
- [ ] T011 [US1] **Verify fail-fast (RED→GREEN)**: `docker compose -f infrastructure-as-code/docker/keycloak/compose.prod.yaml config` with `KC_BOOTSTRAP_ADMIN_PASSWORD` unset, then again with throwaway values set. (SC-006, FR-020)
  - **Covers**: SC-006 (missing required secret aborts naming the variable; no silent fallback).
  - **Expected RED output**: non-zero exit with `required variable "KC_BOOTSTRAP_ADMIN_PASSWORD" is missing a value: set in keycloak/.env.prod`.
  - **Expected GREEN output**: with vars set, exit 0 and the fully-interpolated merged config printed (no `error` / no missing-variable line).

**Checkpoint**: US1 is independently deployable. After deploy (operator), the discovery-doc issuer probe (verification.md item 4) and brute-force lockout (SC-008) confirm acceptance.

---

## Phase 4: User Story 2 - Off-network end-to-end login (web and mobile) (Priority: P2)

**Goal**: The production BFF reachable on `mcm.${BASE_DOMAIN}` with `NODE_ENV=production` (Secure cookies), public issuer via `KEYCLOAK_PUBLIC_URL`, Redis session store, `edge-network` attachment; plus the prod-APK build wiring and the mobile redirect URI so a real off-network device + browser complete the full round-trip.

**Independent Test**: Cellular-only device with the prod build completes sign-in (callback returns to the app, session established); separately a public-network browser completes the same round-trip on `mcm.` and reaches a protected screen.

### BFF prod compose + secret template (US2)

- [ ] T012 [US2] Author `infrastructure-as-code/docker/bff/compose.prod.yaml` (`name: prod-app`): `NODE_ENV=production`, `KEYCLOAK_PUBLIC_URL=https://auth.${BASE_DOMAIN:?set in bff/.env.prod}` (interpolated, never the literal domain), `KEYCLOAK_URL=http://keycloak-service:8080`, `KEYCLOAK_REALM=grumpyrobot`, `KEYCLOAK_CLIENT_ID=movie-collection-manager`, `REDIS_URL=redis://mcm-bff-cache-redis:6379`, `MC_SERVICE_URL=http://mc-service:3001`, session timeout vars, networks `backend-network`/`edge-network`, **no published port**. (FR-012, FR-013, FR-015, FR-016, research R1/R4, R11)
- [ ] T013 [US2] Add the **mobile** callback (app-link / custom scheme — read the exact value from the existing mobile app config) to the OAuth client's valid redirect URIs in `prod-realm.json`, alongside the web URI from T006. (FR-017 mobile half, research R8 open item)
- [ ] T014 [US2] Wire fail-fast secret refs in the BFF compose: `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET` each as `${VAR:?...}` (operator/Komodo-injected, `COOKIE_SECRET` ≥32 chars). No inline literal, no fallback default. (FR-020, FR-021)
- [ ] T015 [P] [US2] Create `infrastructure-as-code/docker/bff/.env.prod.example` with placeholders only for the BFF prod server vars (`BASE_DOMAIN`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET`, session timeouts). `BASE_DOMAIN` feeds `KEYCLOAK_PUBLIC_URL=https://auth.${BASE_DOMAIN}` and the app origin. (FR-021, research R11)
- [ ] T016 [US2] Confirm **CORS posture**: verify no wildcard/`*` CORS is configured in the BFF; same-origin (`mcm.${BASE_DOMAIN}` serves both app + `bff-api/*`) needs no cross-origin grant, so add none. Document the finding. (FR-014, research R5)

### Prod APK build wiring (US2)

- [x] T017 [US2] **RESOLVED — Forgejo Actions builds the prod APK** (feature 023, not 022). The earlier GitHub-vs-Forgejo open question is closed: feature 023's `.forgejo/workflows/cd-deploy.yml` **prod-apk** job runs `nx run mcm-app:build-apk` (which invokes [frontend/mcm-app/scripts/build-apk.mjs](../../frontend/mcm-app/scripts/build-apk.mjs)) with `APK_VARIANT=release` and bakes the public-host `EXPO_PUBLIC_*` values from **Forgejo variables** — `EXPO_PUBLIC_BFF_BASE_URL`/`EXPO_PUBLIC_BFF_NATIVE_URL=https://mcm.${BASE_DOMAIN}`, `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=https://auth.${BASE_DOMAIN}` — not GitHub Actions, not a hard-coded IP/`:8082`. Script logic is unchanged. 022 no longer owns any CI-workflow file; this is delivered by 023. (FR-019, research R6)

### Gate + regression checkpoint for US2

- [ ] T018 [US2] **Verify GREEN (gates)**: re-run all three gates (`secret-scan.mjs --selftest` then plain, `check-no-inline-secrets.mjs`, `check-resource-naming.mjs`) including the new BFF compose + `.env.prod.example`. (FR-023, SC-005)
  - **Covers**: SC-005 (gates pass for the new BFF files).
  - **Expected GREEN output**: every gate exits 0 with a zero-findings summary (`0 findings` / `0 violations`); `--selftest` exits 0.
- [ ] T019 [US2] **Verify fail-fast (RED→GREEN)**: `docker compose -f infrastructure-as-code/docker/bff/compose.prod.yaml config` with `COOKIE_SECRET` unset, then with throwaway values set. (SC-006)
  - **Covers**: SC-006 for the BFF compose.
  - **Expected RED output**: non-zero exit with `required variable "COOKIE_SECRET" is missing a value: ...`.
  - **Expected GREEN output**: exit 0, fully-interpolated merged config printed.
- [ ] T020 [US2] **Regression (web)**: run the existing web E2E login + BFF cookie unit tests against the dev-container path (no prod deploy needed) to prove the unchanged app still logs in and sets Secure/HttpOnly/SameSite=Strict cookies — `pnpm nx test mcm-app` (cookie units) + `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (login). (SC-001 web, verification.md item 3)

**Checkpoint**: US1 + US2 authored. Off-network device login (verification.md item 7) is the manual headline acceptance, performed by the operator post-deploy.

---

## Phase 5: User Story 3 - Production config is secret-safe and gate-compliant (Priority: P3)

**Goal**: A consolidated, evidence-backed pass that every file this feature added carries zero clear-text credentials, fails loudly when a secret is missing, and the templates contain placeholders only. Cross-cuts US1/US2 but is independently verifiable.

**Independent Test**: Run both secret guardrails against the new files → zero findings; unset a required secret → the prod config refuses to start naming the variable; inspect templates → placeholders only, no `:-`/`??` fallback.

- [ ] T021 [US3] **Whole-feature secret audit**: run `node scripts/secret-scan.mjs --selftest` then `node scripts/secret-scan.mjs` and `node scripts/check-no-inline-secrets.mjs` across the full set of files this feature added (both compose files, both `.env.prod.example`, `prod-realm.json`) → zero findings. Record the clean output as evidence. (FR-023, SC-005)
- [ ] T022 [US3] **Template inspection**: confirm `keycloak/.env.prod.example` and `bff/.env.prod.example` contain placeholders only — no real values, no `:-literal` / `?? 'literal'` defaults; confirm `prod-realm.json` has no client secrets/SMTP creds. (FR-008, FR-021, SC-005)
- [ ] T023 [US3] **Missing-secret fail-fast matrix (RED)**: for each prod compose, `docker compose config` with each required secret unset **in turn** must abort naming that variable (no silent fallback) — covers `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD`, `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET`. (FR-020, SC-006)
  - **Covers**: SC-006 across the full secret set (the matrix superset of T011/T019).
  - **Expected RED output (each row)**: non-zero exit with `required variable "<VAR>" is missing a value: ...` naming exactly the unset variable. Any row that exits 0 (or names a different variable) is a silent-fallback defect to fix before GREEN.
- [ ] T024 [US3] **File-secret invariant**: document/verify that `KC_DB_PASSWORD` (Keycloak env) must equal the content of `secrets/keycloak_db_password.txt`, and that both are gitignored/operator-supplied. (FR-022, data-model cross-entity invariants)

**Checkpoint**: All three user stories independently verifiable; the secret-safe guarantee holds across the new surface.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T025 [P] **Adjacent cleanup** (off the login critical path, research R2): fix the stale `KEYCLOAK_REALM=jumbleknot` → `grumpyrobot` in [frontend/mcm-app/.env.docker.example](../../frontend/mcm-app/.env.docker.example).
- [ ] T026 [P] Update [specs/022-prod-public-hostname-auth/quickstart.md](./quickstart.md) if any field/path drifted during implementation; run it as a doc-validation pass.
- [ ] T027 [P] Reconcile the four `docs/proposals/homelab-setup/` files (PRD-CI.md, Server-Setup-Runbook.md, Phase-11-Work-Order.md, keycloak-prod.compose.yaml) if any infra fact (hostnames, network names, registry namespace, realm) changed while authoring the prod compose (HANDOFF gotcha — keep all four mutually consistent).
- [ ] T028 Document the **operator/out-of-repo** steps explicitly as "not done by this feature": Komodo Stack definitions, Cloudflare published routes for `mcm.`/`auth.`, real secret injection, and the manual off-network device E2E (verification.md items 4–7). (Work-Order Parts C/D)

---

## Platform Parity Table

Constitution (Frontend Quality Standards) requires every feature's tasks.md to list each test scenario with its web (Playwright) and mobile (Maestro) status; any `N/A` carries a written justification. This is a config-only feature with **no new app behavior** — the sole user-facing scenario is the unchanged login round-trip exercised as a regression.

| Test Scenario | Web (Playwright) | Mobile (Maestro) | Justification for any N/A |
|---|---|---|---|
| Login round-trip over public origin → protected screen | ✅ Automated regression (T020, dev-container path) | ⚠️ **Manual device E2E** (operator, T028 / verification.md item 7) | Mobile parity is **N/A for automation**: the headline acceptance is an *off-network, cellular, no-LAN* round-trip on a real device — un-automatable in this repo (CI emulator is on-network; Metro OOMs locally). Constitution E2E-on-real-device rule + spec Assumptions make this a documented manual test, not an undocumented gap. |
| Secure/HttpOnly/SameSite=Strict prod cookie set | ✅ BFF cookie unit + web E2E (T020) | ⚠️ N/A (automation) | Cookie flags are issued by the shared BFF (server-side, platform-agnostic); the native cookie jar is verified implicitly during the manual device login (T028). No separate mobile assertion adds coverage. |
| Discovery-doc issuer == public `auth.` origin | ➖ Operator probe (T028, post-deploy) | ➖ Operator probe (T028) | Not a client UI scenario — verified by an HTTP probe against the deployed IdP (verification.md item 4), independent of platform. |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2, T003–T004)**: depends on Setup. **BLOCKS** any prod compose entering the gated path (US1 T007+, US2 T012+).
- **US1 (Phase 3)**: after Foundational. Independently deployable (image only).
- **US2 (Phase 4)**: after Foundational. Shares `prod-realm.json` with US1 (T013 adds the mobile redirect URI to the file T005/T006 created) — sequence T005→T006→T013. Otherwise independent of US1 at the file level.
- **US3 (Phase 5)**: after the US1/US2 files exist (it audits them). Can run incrementally as each file lands.
- **Polish (Phase 6)**: after the stories it touches.

### Within Each User Story

- Gate RED (T003) before gate edit (T004).
- Realm export (T005) before redirect-URI edits (T006 web, T013 mobile).
- Compose authored (T007/T012) + secrets wired (T008/T014) before its gate/fail-fast verification (T010/T011, T018/T019).

### Parallel Opportunities

- T001 / T002 (Setup) in parallel.
- T009 (`keycloak/.env.prod.example`) parallel with T005–T008 once the dir exists.
- T015 (`bff/.env.prod.example`) parallel with T012–T014.
- Polish T025 / T026 / T027 all in parallel (different files).

---

## Parallel Example: User Story 1

```bash
# After T007/T008 author the compose, the template is an independent file:
Task: "T009 Create keycloak/.env.prod.example with placeholders only"

# Gate verification batch (T010) runs all three guardrails together:
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
node scripts/check-no-inline-secrets.mjs
node scripts/check-resource-naming.mjs
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational (gate-approve `edge-network`).
2. Phase 3 US1: realm export + Keycloak prod compose + template, gates green, fail-fast verified.
3. **STOP and VALIDATE**: US1 is deployable today (depends only on the Keycloak image). Hand to operator for the discovery-issuer probe.

### Incremental Delivery

1. Setup + Foundational → ready.
2. US1 (Keycloak) → deploy → issuer probe (MVP).
3. US2 (BFF + APK + mobile redirect) → web regression green → operator deploys → manual device E2E.
4. US3 audit woven throughout → final secret-safe evidence.

---

## Notes

- **No application code changes** — production is reached purely by env values (research R1/R4). Any task that tempts a `src/` edit is a signal to re-read the plan.
- Run gates exactly as CI does: `--selftest` first, then plain (HANDOFF gotcha).
- Web E2E only via the dev-container path (Metro OOMs); the **off-network device login is manual** and operator-owned.
- Out-of-repo (Komodo, Cloudflare routes, real secrets, device test) are documented in T028, not automated here.
