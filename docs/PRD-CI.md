# PRD: CI for E2E testing (mobile-agent first)

**Status:** In progress — **deferred** at the CI-provisioning step (2026-06-13).
**Owner:** Steve.
**Branch where the work lives:** `013-post-agent-enhancements` (workflow also on `main` via PR #13).

---

## 1. Goal

Run the **mobile agent E2E flows in CI** so they stop being validated by hand on a Windows/Metro
dev box — and, more broadly, establish a **Metro-less, reproducible E2E harness** that any
contributor (or a PR gate) can trust.

### Why this is needed (the problem it solves)

Interactive mobile agent E2E on the dev machine is the worst-case setup and has repeatedly burned
whole sessions:

- **Metro OOM-crashes after ~1–2 agent `/run` calls** (V8 heap-exhaustion dump in its log → the app
  then shows a black screen or `status 0` "RN networking issue"). Most "the card won't render" /
  `no_token` observations during the 012/013 agent work traced back to Metro having died, not to app
  bugs.
- **Windows/HyperV networking** breaks the Android emulator's `10.0.2.2` host route, forcing fragile
  `adb reverse` tunnels.
- The `_login-helper` Maestro sub-flow has an **SSO-timing/session-persistence flake** that fails
  intermittently regardless of the code under test.

A Linux CI runner removes all three: no Metro (embedded-bundle APK), working `10.0.2.2` under KVM,
and a clean environment per run.

### Success criteria

1. A `workflow_dispatch` (later `pull_request`) GitHub Actions job builds a standalone Android APK
   and runs the Maestro **agent** flows (`agent-search`, `agent-card-navigate`,
   `agent-disambiguation`, `agent-navigate-movie`) against a containerized backend + agent stack,
   green, with no Metro and no host-network hacks.
2. The job is **reproducible from a clean checkout** — it provisions everything it needs (no
   dependency on a hand-set-up dev box).
3. On failure it uploads Maestro screenshots + the view hierarchy and dumps container logs.
4. (Stretch) The same harness pattern is reusable for **web** E2E in CI and eventually gates PRs.

### Non-goals (for this iteration)

- Replacing the local dev loop (Metro stays the inner loop for non-agent work).
- iOS E2E.
- Performance/load testing.
- Turning on the `pull_request` trigger before the job has gone green once.

---

## 2. Design / approach

Mirror the **web dev-container E2E** path (feature 007), which already works, but drive a built APK
instead of a browser:

```
APK (embedded JS bundle, BFF URL baked → 10.0.2.2:8082)
   └─► mcm-bff-dev container (:8082)  ──► agent-gateway container ──► movie-mcp / web-api-mcp ──► mc-service
Keycloak / Redis / Mongo / mc-service all run as containers on the runner.
```

Key decisions:

- **No Metro.** Build a **release-variant APK** (`APK_VARIANT=release` → embeds the JS bundle). The
  mobile BFF is therefore the **container** (`:8082`), not Metro — the OOM-prone server is gone.
- **Linux KVM emulator** (`reactivecircus/android-emulator-runner`) — `10.0.2.2` works, so no
  `adb reverse`.
- **Anthropic provider** in CI (`MODEL_PROVIDER=anthropic`) to avoid a ~19 GB Ollama model pull.
- **Reuse, don't reinvent:** fixtures seed via the existing web Playwright `global-setup`; the agent
  stack comes up via the committed `nx up-agents-prod`; the dev BFF reaches the gateway by Docker
  DNS (same as web agent E2E), so **no `:8123` socat proxy** is needed (that was Metro-only).
- Run agent flows **isolated per file** (the parallel suite trips the per-user rate-limit +
  ~5-min token-expiry — CLAUDE.md).

Artifacts: `.github/workflows/android-e2e.yml`, `frontend/mcm-app/scripts/build-apk.mjs`
(`APK_VARIANT`), and the supporting diagnosis/decision docs under
`specs/013-post-agent-enhancements/`.

---

## 3. What has been done ✅

### Tooling + workflow
- **`build-apk.mjs` — `APK_VARIANT=release`** added: builds a **standalone embedded-bundle APK**
  (Expo prebuild signs `release` with the debug keystore → installable for E2E without extra
  secrets). `debug` remains the default for the interactive dev path.
- **`.github/workflows/android-e2e.yml`** authored + finalized: disk-free, KVM enable, toolchain
  setup, Docker networks/volumes, **install latest Docker Compose plugin**, stack bring-up, BFF
  image build + dev container, `up-agents-prod` gateway/MCP, fixture seeding via web `global-setup`,
  release-APK build (URLs baked to `:8082`), Maestro install, per-file agent-flow run, and
  failure-artifact upload. `workflow_dispatch`-only until first green.
- Registered on `main` via **PR #13** (single-file) so `workflow_dispatch` can target it; the run
  uses the feature-branch (`013`) copy + code.

### CI runs (iterated on real failures)
- **Run 1** → failed at stack bring-up: the runner's bundled Docker Compose rejected the repo's
  `include:` + top-level service-override (`services.mc-service conflicts with imported resource`).
  **Fixed** by installing the latest Compose plugin on the runner.
- **Run 2** → cleared setup → deps → Compose-version, then failed at stack bring-up with
  **`keycloak/.env.local not found`** — surfacing the real blocker below.

### Documentation
- **CLAUDE.md** "Mobile E2E approach": agent flows → CI; non-agent flows → local emulator; with the
  Metro-OOM rationale and trigger/watch instructions.
- `specs/013-post-agent-enhancements/diagnosis-mobile-agent-no-token.md` and
  `decision-frontend-auth-model.md` (the auth-model work that motivated trusting CI over Metro).

### Adjacent validation already achieved (so the gap is narrow)
- **Web E2E: 104/104** against the dev container (full auth lifecycle, CRUD, sort, the agent web
  flows are gated/skipped but the web `agent-search` spec passes when un-gated).
- **Native login on-device** (`login-keycloak` Maestro flow) — `storeSession` + the cookie-based
  api-client proven on Android.
- **Deterministic session-refresh recovery** test (`agent-session-refresh.spec.ts`): 401 → refresh →
  retry, green.

---

## 4. What still needs doing 🚧

### BLOCKER — CI environment provisioning (the deferred task)

The full stack cannot stand up in CI because the environment is currently created by **manual local
first-time setup** and is **gitignored**. The repo has **no automated provisioning and no committed
realm export** (CLAUDE.md: "There is no CI E2E job today"). Specifically CI is missing:

| Needed in CI | Where it comes from today | Note |
|---|---|---|
| `infrastructure-as-code/docker/keycloak/.env.local` | hand-created from `.env.local.example` | `KC_DB_PASSWORD` + Keycloak client secrets |
| `infrastructure-as-code/docker/keycloak/secrets/keycloak_db_password.txt` | hand-created | must match `KC_DB_PASSWORD` |
| `frontend/mcm-app/.env.docker` | hand-filled from `.env.docker.example` | `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET` |
| `jumbleknot` realm + clients + **generated client secrets** | created manually in Keycloak; secrets copied into the env files | no committed realm export; secrets are generated, not fixed |
| Test user (`E2E_TEST_USER`) with `mc-user` role | created manually / via registration | needed by every Maestro login |

Marked `TODO(ci-provisioning)` in `android-e2e.yml`.

### Recommended path when resumed: **commit a Keycloak realm export** (Option 1)

1. Export the configured local `jumbleknot` realm **with users + client secrets** (test values are
   fine to commit):
   `docker exec mcm-keycloak-service-1 /opt/keycloak/bin/kc.sh export --realm jumbleknot --users realm_file --file /tmp/realm.json` (then copy out + sanitize).
2. Commit it as a CI seed (e.g. `infrastructure-as-code/docker/keycloak/ci-realm.json`); these are
   throwaway CI secrets, **not** production.
3. Wire Keycloak to import it in CI (`--import-realm` + mount), and have the workflow **write the env
   files from the now-known secrets** (a small "provision env" step before stack bring-up).
4. Ensure the export includes the **test user + `mc-user` role** (so `_login-helper` works) and the
   `movie-collection-manager` / `mcm-bff-service` / agent-gateway clients with secrets matching the
   env files.
5. Re-dispatch and iterate. Expect **further first-time failures past bring-up** (each is a few
   minutes to the next): the **release-APK build** (`assembleRelease` signing/bundle — never run in
   CI), the **fixture-seeding** step (web `global-setup` against `:8082`), and the **first Maestro
   agent flow** itself.

Alternative (Option 2): script realm/client/user creation via the Keycloak Admin API at runtime and
extract secrets into the env files. More faithful to "clean provisioning," more code.

### After the stack stands up — remaining unknowns to shake out
- `assembleRelease` in CI (signing config from Expo prebuild, embedded-bundle correctness).
- Seeding via `global-setup` pointed at the container (`E2E_BFF_TARGET=dev-container`, `:8082`).
- Whether the Linux-KVM emulator + Maestro run the agent flows reliably (the real prize: validating
  the mobile agent flows post-auth-cleanup, which is **still unvalidated**).
- Then: turn on the `pull_request` trigger; consider extending the same harness to web E2E and a PR
  gate.

---

## 5. How to run it (today)

```bash
# Secrets required in the repo (Settings → Secrets and variables → Actions) — already set:
#   ANTHROPIC_API_KEY, E2E_TEST_USER, E2E_TEST_PASSWORD
gh workflow run android-e2e.yml --ref 013-post-agent-enhancements -f provider=anthropic
gh run watch <run-id> --exit-status      # uploads maestro-debug + container logs on failure
```

It will currently fail at **"Bring up Keycloak …"** until the §4 provisioning is built.

---

## 6. References

- Workflow: `.github/workflows/android-e2e.yml`
- Build script: `frontend/mcm-app/scripts/build-apk.mjs`
- Local web dev-container E2E (the pattern this mirrors): `specs/007-e2e-bff-container/quickstart.md`
- Auth-model decision (why CI is trusted over Metro): `specs/013-post-agent-enhancements/decision-frontend-auth-model.md`
- Mobile `no_token` diagnosis: `specs/013-post-agent-enhancements/diagnosis-mobile-agent-no-token.md`
- First-time local setup (what CI must reproduce): root `compose.yaml` header + CLAUDE.md "Local Dev Infrastructure"
