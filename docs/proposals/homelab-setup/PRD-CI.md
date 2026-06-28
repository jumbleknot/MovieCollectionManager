# PRD: Self-hosted CI/CD on the homelab server (Forgejo Actions) — E2E first

**Status:** **Implemented as feature 023** — the self-hosted CI/CD pipeline is built as config-as-code under `.forgejo/workflows/` (`guardrails.yml`, `app-ci.yml`, `cd-deploy.yml`) running on a self-hosted Forgejo Actions `act_runner`. Re-scoped from a GitHub-hosted job (2026-06-18), refreshed for features 019–023 (2026-06-22). Supersedes the deferred GitHub Actions provisioning task — GitHub Actions is retired from the CI path.

> **Updated for features 019–023; the pipeline is now built (023).** Since the first draft the infra layout changed in ways the pipeline depends on: **020** retired the single root `compose.yaml` aggregator and split the stack into four independently-operable named Compose stacks (`auth`, `mcm`, `audit`, `observability`) under `infrastructure-as-code/docker/stacks/`; **021/022** externalized every tracked-compose credential to fail-fast `${VAR:?}` references minted by `scripts/gen-dev-secrets.mjs`; **023** codified the no-clear-text-secrets rule repo-wide, broadened the secret scan, **and implemented the pipeline itself** (three workflows under `.forgejo/workflows/`). §2.3, §2.5, §2.6, and §4.3 below reflect this.
**Owner:** Steve.
**Branch where the prior work lives:** `013-post-agent-enhancements` (the GitHub Actions workflow also reached `main` via PR #13 and is now a **portable asset**, not the target platform).

---

## 1. Goal

Run the **web and mobile E2E flows (including agent flows)** and the broader app test suite on a **self-hosted, reproducible CI/CD pipeline** that lives on the new homelab server — and extend it through to **automated deployment** into a segregated production environment on the same box.

Two outcomes:

1. **CI** — a Metro-less, reproducible E2E harness (web Playwright + Android Maestro + agent flows) that runs on every push/PR against a containerized backend + agent stack, green, with no host-network hacks.
2. **CD** — successful builds publish container images to a private registry, and production is updated from those images automatically, isolated from the build/test environment.

### Why this changed (the problem the new server solves)

The interactive mobile-agent E2E loop on the Windows/Metro dev box repeatedly burned whole sessions:

- **Metro OOM-crashes after ~1–2 agent `/run` calls** (V8 heap exhaustion → black screen / `status 0` "RN networking issue"). Most "card won't render" / `no_token` observations during 012/013 traced to Metro dying, not app bugs.
- **Windows/Hyper-V networking** breaks the Android emulator's `10.0.2.2` host route, forcing fragile `adb reverse` tunnels.
- The `_login-helper` Maestro sub-flow has an SSO-timing/session-persistence flake independent of the code under test.

The earlier GitHub Actions plan removed those three but introduced its own friction: **cold provisioning of a KVM emulator and a ~10-service stack on every run**, plus a **blocking environment-provisioning gap** (no committed Keycloak realm, hand-made secrets).

The new **Beelink SER9 MAX** server (Ryzen, 8C/16T, 64 GB, 1 TB NVMe, headless Ubuntu 26.04 LTS) removes all of it:

- **KVM is native** on bare-metal Linux — `10.0.2.2` works, no `adb reverse`.
- The backend + agent stack can stay **resident** on the CI daemon, so runs start warm.
- **Nx affected + a self-hosted remote cache** make polyglot (Rust/Node/Python) builds incremental across runs.
- A **segregated production environment** on a second daemon receives deployments, so build/test never touches prod.

### Success criteria

1. A push (and later a PR) to the Forgejo repo triggers a **Forgejo Actions** job that, on the CI daemon, builds the affected projects, runs **web E2E (Playwright)** and the **Android E2E Maestro flows** including agent flows (e.g., `agent-search`, `agent-card-navigate`, `agent-disambiguation`, `agent-navigate-movie`) against the resident backend + agent stack — green, no Metro, no host-network hacks.
2. The job is **reproducible from a clean checkout** — it provisions everything it needs (committed Keycloak realm export; no dependency on a hand-set-up box).
3. On failure it uploads Maestro screenshots + view hierarchy and dumps container logs.
4. On success it **builds and pushes images** to the Forgejo container registry, and **Komodo redeploys production** from those images on the prod daemon.
5. The build/test environment and the production environment are **isolated** (separate rootless Docker daemons, separate networks/volumes).
6. Production is reachable from the **Android app off-network** over a stable public hostname with valid TLS, and on-device Keycloak login works end to end.
7. The deploy is **secure-by-default**: only `mcm.`/`auth.` are publicly exposed, images are vulnerability-scanned before promotion, and a green deploy is health-verified before it's considered done.

### Non-goals (this iteration)

- Replacing the local dev inner loop (Metro stays the inner loop for non-agent work).
- iOS E2E.
- Performance/load testing.
- Multi-node / HA orchestration (single server by design).
- Turning on the PR-gate trigger before the pipeline has gone green once on push.

---

## 2. Design / approach

### 2.1 Platform decisions

| Concern | Decision |
|---|---|
| **Server OS** | Ubuntu Server 26.04 LTS, headless, minimized install (kernel ≥ 6.10 covers the Ryzen APU; 26.04 ships 7.0). |
| **Segregation** | Two **rootless Docker daemons** under separate non-root users: `ci` (build/test) and `prod` (hosting). Independent data roots, sockets, networks, volumes. |
| **Source of truth** | **Forgejo** (self-hosted, FOSS) is the **primary repository / single source of truth**. |
| **GitHub** | Kept as a **push-mirror** target only — Forgejo broadcasts commits to GitHub for backup/visibility; GitHub is no longer in the CI path. |
| **CI engine** | **Forgejo Actions** (`act_runner`) on the CI daemon. The existing `android-e2e.yml` ports with minimal edits (GitHub-Actions-compatible YAML). |
| **Container registry** | **Forgejo's built-in OCI registry** (no extra service to run). |
| **CD** | **Komodo** — pulls new images and redeploys the prod compose stacks on the prod daemon. |
| **Build acceleration** | **Nx affected** + a **self-hosted Nx remote cache** (S3/MinIO-compatible backend, no Nx Cloud); pnpm store cache persisted on the runner. |
| **Remote management** | SSH (key-only) + Tailscale for access; Cockpit/Komodo web UIs for ops. |
| **Public ingress** | **Cloudflare Tunnel** (outbound-only, CGNAT-proof, no static IP) exposing only `mcm.`/`auth.`; Tailscale-on-device for private-only use. |
| **TLS / DNS** | TLS at the Cloudflare edge **or** Caddy + Let's Encrypt DNS-01 (Cloudflare); `${BASE_DOMAIN}` DNS on Cloudflare — no DDNS needed. |
| **Image scanning** | **Trivy** gate in CI; promote by digest; **Renovate** for base-image updates. |
| **Monitoring** | node-exporter + cAdvisor + Prometheus/Grafana (reuse `otel-lgtm`), Uptime Kuma alerts, Dozzle, Scrutiny (SSD SMART). |
| **Backup / DR** | restic/Borg (Mongo + Postgres dumps, Forgejo + Keycloak), offsite 3-2-1, tested restores; UPS + NUT. |

### 2.2 Pipeline shape

```
push ──► Forgejo (SSOT) ──► push-mirror ──► GitHub (backup/visibility)
  │
  └─► Forgejo Actions (act_runner on CI rootless daemon)
        1. nx affected: lint / build / unit-test (Rust + Node + Python; remote cache)
        2. bring up / reuse resident backend + agent stack (Keycloak, Mongo rs, Redis,
           mc-service, agent-gateway, movie-mcp/web-api-mcp, ...)  ← persistent on CI daemon
        3. web E2E (Playwright) against the dev BFF container
        4. build release-variant APK (embedded bundle, BFF URL → 10.0.2.2:8082)
        5. Android agent Maestro flows on KVM emulator (per-file isolation)
        6. on green: docker build + push images → Forgejo registry
        7. notify Komodo
              │
              └─► Komodo (prod rootless daemon): pull images, redeploy prod compose stacks
```

### 2.3 Carried-over architecture facts (unchanged from the app design)

- **Embedded-bundle release APK** (`APK_VARIANT=release`, Expo prebuild signs with the debug keystore) — the mobile BFF is the **container** (`:8082`), not Metro. The OOM-prone server is gone.
- **Anthropic provider in CI** (`MODEL_PROVIDER=anthropic`) to avoid a ~19 GB Ollama pull. (On the resident server, a local Ollama model could be pre-pulled later if desired.)
- Agent flows run **isolated per file** (the parallel suite trips the per-user rate-limit + ~5-min token expiry).
- **Stack orchestration is four independently-operable named Compose stacks** (feature 020) under `infrastructure-as-code/docker/stacks/` — `auth`, `mcm`, `audit`, `observability` — each its own Compose project (the single root `compose.yaml` aggregator is **retired** → pointer only). CI brings them up in order via Nx: `nx up-auth` → `nx up-mcm` (app + BFF + agents via `--profile app --profile bff-nonsecure --profile agents`), plus `up-audit` / `up-observability` only if a run needs them. Cross-stack traffic is by Docker DNS over the shared external `backend-network`; there is **no cross-stack `depends_on`**, so auth must come up before the mcm `app` profile (mc-service fetches Keycloak JWKS on startup). The light agent-E2E variant is still `nx up-agents-prod` (no `:8123` socat proxy — that was Metro-only).

### 2.4 The one rootless gotcha to handle in setup

The Maestro **Android emulator needs `/dev/kvm`**. Under rootless Docker this requires passing `--device /dev/kvm` and adding the CI runner's user to the `kvm` group. If that proves fragile, the **Android-E2E runner only** may run as a dedicated low-privilege *system* user with kvm access, while every other CI workload stays fully rootless. The production daemon is unaffected.

### 2.5 Pipeline stages (authoritative — implemented by feature 023)

This remains the **normative stage list**. As implemented, stages 1–3 live in `guardrails.yml` + `app-ci.yml`, stages 4–8 in `app-ci.yml` (CI emulator APK + E2E), and **stages 9–12 (image build/scan → publish → deploy → post-deploy verify) are implemented by `cd-deploy.yml`**. Stages run on the **CI daemon** unless noted; the deploy stage targets the **prod daemon** via Komodo.

| # | Stage | Inputs → Outputs | Pass condition |
|---|---|---|---|
| 1 | **Lint & typecheck** | affected projects (Rust/Node/Python) | clean |
| 2 | **Build** | `nx affected --target=build` (remote cache) | all affected build |
| 3 | **Unit/integration test** | `nx affected --target=test` | green |
| 4 | **Provision env** | `ci-realm.json` + `gen-dev-secrets.mjs` (per-stack `stacks/*.env` from committed `*.env.example`) + BFF `.env.docker` + `keycloak_db_password.txt` | files written, realm imports |
| 5 | **Stack up** | resident/started backend + agent stack (compose profiles) | `/health` green, Keycloak healthy |
| 6 | **Web E2E** | Playwright vs dev BFF container | 104/104 (+ un-gated agent specs) |
| 7 | **Build prod APK** | `APK_VARIANT=release`, BFF URL baked → **public host for prod builds** | signed APK produced |
| 8 | **Android agent E2E** | Maestro flows on KVM emulator, per-file | all four agent flows pass |
| 9 | **Image build + scan** | `docker build` per service → **Trivy scan** | no criticals; push only if clean |
| 10 | **Publish** | push images → **Forgejo OCI registry** (pinned tag + digest) | push succeeds |
| 11 | **Deploy** | notify **Komodo** → prod pulls + redeploys compose stacks | stack converges |
| 12 | **Post-deploy verify** | probe `https://mcm.`/`auth.`/`/health` | green, else auto-rollback to the **prior digest** (Komodo retains it) |

Failure in 1–9 blocks publish; failure in 11–12 triggers rollback **to the prior image digest**. On `push` to a working branch the pipeline runs 1–8 (CI, in `guardrails.yml` + `app-ci.yml`) first; 9–12 (CD, in `cd-deploy.yml`) activate once CI is green and are gated to the deploy branch.

### 2.6 CD / deployment requirements

- **Artifact promotion, not rebuild.** The exact image pushed in stage 10 is what prod runs — promote by **digest**, never rebuild for prod.
- **Single-step deploy straight to prod (no staging).** Komodo deploys the published images directly to the live prod stack — there is no separate staging stack. The safety net is the **stage-12 post-deploy health probe**: if it fails, Komodo **rolls back to the prior image digest** it retains. CD orchestrates **all** prod stacks — the CI-built app images at the run's digest, and the upstream-image stacks (Keycloak/Postgres/Redis/Mongo) at their pinned upstream digests.
- **Secrets split.** CI secrets live in **Forgejo Actions secrets**; prod secrets live in **Komodo/Vault** — never in git. The committed `ci-realm.json` carries **throwaway** CI secrets only.
- **No clear-text secrets in git — EVER** (features 021/022/023; constitution §Secrets Management). Every credential in a tracked compose file is a fail-fast `${VAR:?set in stacks/<stack>.env}` reference — never an inline literal, never a `${VAR:-literal}` default. Real per-machine values are minted by `node scripts/gen-dev-secrets.mjs` from committed `stacks/*.env.example` templates into gitignored `stacks/*.env`; build-time file-secrets stay on `secrets/*.txt` + the `_FILE` pattern. The rule is **not compose-only** — scripts, integration tests, and docs must read from env and skip/fail cleanly when unset, never hardcode a literal or `:-literal` / `?? 'literal'` fallback. **Two CI gates enforce it on every push/PR:** `naming-gate.yml` runs `check-no-inline-secrets.mjs` (inline literals in compose files) and `secret-scan.yml` runs `secret-scan.mjs` (whole-tree credential-shaped strings, incl. the MCM dev-credential placeholder shapes). The Forgejo Actions ports of the pipeline must keep both gates green.
- **Rollback.** Prod compose files pin image **digests**; Komodo keeps the prior digest to roll back on a failed post-deploy probe.
- **Backup before destructive migrations.** Any schema/data migration step takes a `mongodump`/`pg_dump` first (see runbook Phase 14).

### 2.7 Production configuration the pipeline must satisfy (external access)

Because the **prod APK bakes the BFF URL** and auth is OAuth, the CD path must produce/consume a coherent public-origin config (full steps in runbook Phases 10–11):

- Prod APK baked to `https://mcm.${BASE_DOMAIN}` (public host, HTTPS) — **not** an IP or `:8082`.
- Keycloak prod mode: `KC_HOSTNAME=auth.${BASE_DOMAIN}`, proxy headers, real SMTP, brute-force on, admin console not public.
- `movie-collection-manager` client **valid redirect URIs** include the web origin **and** the mobile app-link/custom-scheme deep link (or on-device login loops).
- BFF issuer/`ROOT_URL` → public `auth.` origin; session cookie `Secure`+`HttpOnly`, domain `mcm.${BASE_DOMAIN}`; CORS limited to the app origin.
- Ingress exposes **only** `mcm.`/`auth.` (Cloudflare Tunnel); all other services + the entire CI daemon stay private.

---

## 3. What carries over from the prior (GitHub Actions) work ✅

These are **reusable assets** — the platform changed, the artifacts mostly survive:

- **`build-apk.mjs` — `APK_VARIANT=release`**: builds a standalone embedded-bundle APK; `debug` stays the default for interactive dev. **Reused unchanged.**
- **`android-e2e.yml`**: disk-free, KVM enable, toolchain, Docker networks/volumes, stack bring-up, BFF image build + dev container, `up-agents-prod`, fixture seeding via web `global-setup`, release-APK build, Maestro per-file run, failure-artifact upload. **Ports to Forgejo Actions** — chief edits: runner labels, any `actions/*` marketplace steps swapped for `act_runner`-compatible equivalents, registry login pointed at Forgejo.
- **CLAUDE.md "Mobile E2E approach"** rationale (agent flows → CI; non-agent → local emulator).
- Diagnosis/decision docs under `specs/013-post-agent-enhancements/`.

### Adjacent validation already achieved (so the gap stays narrow)

- **Web E2E: 104/104** against the dev container (auth lifecycle, CRUD, sort; web `agent-search` passes when un-gated).
- **Native login on-device** (`login-keycloak` Maestro flow) — `storeSession` + cookie-based api-client proven on Android.
- **Deterministic session-refresh recovery** (`agent-session-refresh.spec.ts`): 401 → refresh → retry, green.

---

## 4. Status — foundation DONE ✅, pipeline implemented (023) ✅

### 4.1 Server foundation ✅ DONE

- ✅ Ubuntu 26.04 LTS headless installed/secured; SSH key-only; Tailscale; firewall.
- ✅ **Two rootless Docker daemons** (`ci`, `prod`) stood up with separate users, sockets, data roots, networks, volumes.
- ✅ **KVM** enabled; the CI runner user has kvm access (see §2.4).

### 4.2 Forge + CI/CD services ✅ DONE

- ✅ **Forgejo** (+ its DB) deployed; repo created as **SSOT**; **push-mirror to GitHub** configured.
- ✅ **Forgejo OCI registry** enabled.
- ✅ **Forgejo Actions `act_runner`** registered on the CI daemon (Docker backend; runner labels `ubuntu-latest`, `kvm:host` for the Android job).
- ✅ **Komodo** deployed (+ prod rootless daemon); connected to the prod daemon; prod compose stacks defined.
- ✅ **Self-hosted Nx remote cache** server stood up (MinIO/S3 backend). The cache **client** is wired **env-driven** — `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` (Forgejo variable) + `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (Forgejo secret); there is **no `nx.json` literal**, and local runs without the token fall back to local cache.

### 4.3 Environment provisioning (implemented in the pipeline's provision-env step)

The reproducible environment is provisioned by the pipeline's provision-env step; this table is the normative reference for what it materializes. The committed **Keycloak realm export** + `gen-dev-secrets.mjs` is the mechanism:

| Needed in CI | Source today | Note |
|---|---|---|
| `stacks/{auth,mcm,audit,observability}.env` | `node scripts/gen-dev-secrets.mjs` (from committed `stacks/*.env.example`) | gitignored; fail-fast `${VAR:?}` refs in compose (features 021/022). `auth.env` → `KC_BOOTSTRAP_ADMIN_PASSWORD`, **`KC_DB_PASSWORD`** (feature 022 — single source for both Postgres + Keycloak), `VAULT_DEV_ROOT_TOKEN_ID`; `mcm.env` → `AGENT_DB_PASSWORD`; audit/observability → OpenSearch/Unleash/LangFuse creds |
| `frontend/mcm-app/.env.docker` | hand-filled from `.env.docker.example` | `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET` (BFF secrets — outside the stack `.env` externalization) |
| `grumpyrobot` realm + clients + generated secrets | created manually in Keycloak | no committed realm export yet |
| Test user (`E2E_TEST_USER`) with `mc-user` role | manual / registration | needed by every Maestro login |

**Path:** export the configured `grumpyrobot` realm **with users + client secrets** (throwaway CI values are fine to commit), commit it (e.g. `infrastructure-as-code/docker/keycloak/ci-realm.json`), wire Keycloak `--import-realm`, and have the "provision env" step run `gen-dev-secrets.mjs` to mint the per-stack `stacks/*.env` files (incl. `KC_DB_PASSWORD`) and `gen-ci-env.mjs` to fill the BFF `.env.docker` from the Forgejo secrets before bring-up. Source the real values from **Forgejo Actions secrets** (CI) and **Komodo/Vault** (prod), never git — and keep the §2.6 secret gates green in the pipeline.

### 4.4 Port + green the pipeline ✅ DONE (feature 023)

- ✅ The pipeline lives as config-as-code in `.forgejo/workflows/` — `guardrails.yml` (lint/typecheck + secret/naming gates), `app-ci.yml` (build, unit/integration, web E2E, **CI emulator APK**, Android Maestro agent flows), and `cd-deploy.yml` (image build + scan, registry publish, Komodo deploy, post-deploy probe, **prod-apk** job).
- ✅ The **prod/release APK is built by Forgejo Actions** — `app-ci.yml` builds the CI emulator APK; `cd-deploy.yml`'s `prod-apk` job bakes the public BFF host `https://mcm.${BASE_DOMAIN}` from a Forgejo variable. (GitHub Actions no longer builds it.)
- ✅ Build-and-push images → Forgejo registry and the Komodo deploy trigger are in `cd-deploy.yml`.
- Remaining: enable the **PR-gate** trigger and extend the harness to gate web E2E on PRs.

### 4.5 CD, public access & prod config (implemented by `cd-deploy.yml`)

- ✅ Pipeline stages 9–12 (Trivy scan → registry publish → Komodo deploy → post-deploy probe + rollback) are implemented in `cd-deploy.yml`.
- ✅ **Single-step deploy straight to prod** (no staging stack); the post-deploy health probe rolls back to the **prior image digest** on failure.
- ✅ The **prod APK** is built against the public host by `cd-deploy.yml`'s `prod-apk` job. Remaining manual/prod-config: wire Keycloak `KC_HOSTNAME`/redirect URIs and the BFF public-origin config (Phases 10–11).
- Cloudflare Tunnel exposing only `mcm.`/`auth.`; DNS on Cloudflare; TLS at edge or via Caddy DNS-01.

### 4.6 Security, monitoring & backup (new)
- Close public SSH (tailnet-only); docker-socket-proxy in front of Komodo; admin UIs behind Cloudflare Access/tailnet; CrowdSec on the edge.
- Move prod secrets to Vault; CI secrets to Forgejo Actions secrets; 2FA on Forgejo/Cloudflare/Komodo; chrony for clock sync.
- Deploy the infra monitoring profile (node-exporter, cAdvisor, Prometheus/Grafana, Uptime Kuma, Dozzle, Scrutiny).
- Implement scheduled, offsite, **restore-tested** backups + UPS/NUT; set Loki/OpenSearch retention + CI image-prune.

---

## 5. References

- Prior workflow (porting source): `.github/workflows/android-e2e.yml`
- Build script: `frontend/mcm-app/scripts/build-apk.mjs`
- Local web dev-container E2E (the pattern this mirrors): `specs/007-e2e-bff-container/quickstart.md`
- Auth-model decision (why CI is trusted over Metro): `specs/013-post-agent-enhancements/decision-frontend-auth-model.md`
- Mobile `no_token` diagnosis: `specs/013-post-agent-enhancements/diagnosis-mobile-agent-no-token.md`
- App + infra architecture: `MCM-Architecture.md` (container diagrams, compose profiles, agent-layer infra)
- Server build + setup steps: `Server-Setup-Runbook.md` (companion to this PRD)
