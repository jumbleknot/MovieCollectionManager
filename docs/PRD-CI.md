# PRD: Self-hosted CI/CD on the homelab server (Forgejo Actions) — E2E first

**Status:** Revised — re-scoped from a GitHub-hosted job to a **self-hosted CI/CD pipeline** on the new homelab server (2026-06-18). Supersedes the deferred GitHub Actions provisioning task.
**Owner:** Steve.
**Branch where the prior work lives:** `013-post-agent-enhancements` (the GitHub Actions workflow also reached `main` via PR #13 and is now a **portable asset**, not the target platform).

---

## 1. Goal

Run the **mobile agent E2E flows** and the broader app test suite on a **self-hosted, reproducible CI/CD pipeline** that lives on the new homelab server — and extend it through to **automated deployment** into a segregated production environment on the same box.

Two outcomes:

1. **CI** — a Metro-less, reproducible E2E harness (web Playwright + Android Maestro agent flows) that runs on every push/PR against a containerized backend + agent stack, green, with no host-network hacks.
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

1. A push (and later a PR) to the Forgejo repo triggers a **Forgejo Actions** job that, on the CI daemon, builds the affected projects, runs **web E2E (Playwright)** and the **Android agent Maestro flows** (`agent-search`, `agent-card-navigate`, `agent-disambiguation`, `agent-navigate-movie`) against the resident backend + agent stack — green, no Metro, no host-network hacks.
2. The job is **reproducible from a clean checkout** — it provisions everything it needs (committed Keycloak realm export; no dependency on a hand-set-up box).
3. On failure it uploads Maestro screenshots + view hierarchy and dumps container logs.
4. On success it **builds and pushes images** to the Forgejo container registry, and **Komodo redeploys production** from those images on the prod daemon.
5. The build/test environment and the production environment are **isolated** (separate rootless Docker daemons, separate networks/volumes).
6. Production is reachable from the **Android app off-network** over a stable public hostname with valid TLS, and on-device Keycloak login works end to end.
7. The deploy is **secure-by-default**: only `app.`/`auth.` are publicly exposed, images are vulnerability-scanned before promotion, and a green deploy is health-verified before it's considered done.

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
| **Public ingress** | **Cloudflare Tunnel** (outbound-only, CGNAT-proof, no static IP) exposing only `app.`/`auth.`; Tailscale-on-device for private-only use. |
| **TLS / DNS** | TLS at the Cloudflare edge **or** Caddy + Let's Encrypt DNS-01 (Cloudflare); `jumbleknot.net` DNS on Cloudflare — no DDNS needed. |
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
- Stack orchestration stays the repo-root `compose.yaml` with `include:` + `profiles`; CI uses the same `nx up-agents-prod` / profile bring-up, reached by Docker DNS (no `:8123` socat proxy — that was Metro-only).

### 2.4 The one rootless gotcha to handle in setup

The Maestro **Android emulator needs `/dev/kvm`**. Under rootless Docker this requires passing `--device /dev/kvm` and adding the CI runner's user to the `kvm` group. If that proves fragile, the **Android-E2E runner only** may run as a dedicated low-privilege *system* user with kvm access, while every other CI workload stays fully rootless. The production daemon is unaffected.

### 2.5 Pipeline stages (authoritative — for the SDD process)

The SDD process should treat the following as the normative stage list. Each is a candidate spec/feature. Stages run on the **CI daemon** unless noted; the deploy stage targets the **prod daemon** via Komodo.

| # | Stage | Inputs → Outputs | Pass condition |
|---|---|---|---|
| 1 | **Lint & typecheck** | affected projects (Rust/Node/Python) | clean |
| 2 | **Build** | `nx affected --target=build` (remote cache) | all affected build |
| 3 | **Unit/integration test** | `nx affected --target=test` | green |
| 4 | **Provision env** | `ci-realm.json` + secrets → `.env.local`, `.env.docker`, secret files | files written, realm imports |
| 5 | **Stack up** | resident/started backend + agent stack (compose profiles) | `/health` green, Keycloak healthy |
| 6 | **Web E2E** | Playwright vs dev BFF container | 104/104 (+ un-gated agent specs) |
| 7 | **Build prod APK** | `APK_VARIANT=release`, BFF URL baked → **public host for prod builds** | signed APK produced |
| 8 | **Android agent E2E** | Maestro flows on KVM emulator, per-file | all four agent flows pass |
| 9 | **Image build + scan** | `docker build` per service → **Trivy scan** | no criticals; push only if clean |
| 10 | **Publish** | push images → **Forgejo OCI registry** (pinned tag + digest) | push succeeds |
| 11 | **Deploy** | notify **Komodo** → prod pulls + redeploys compose stacks | stack converges |
| 12 | **Post-deploy verify** | probe `https://app.`/`auth.`/`/health` | green, else auto-rollback to prior tag |

Failure in 1–9 blocks publish; failure in 11–12 triggers rollback. On `push` to a working branch the pipeline runs 1–8 (CI) first; 9–12 (CD) activate once CI is green and are gated to the deploy branch.

### 2.6 CD / deployment requirements

- **Artifact promotion, not rebuild.** The exact image pushed in stage 10 is what prod runs — promote by **digest**, never rebuild for prod.
- **Two-step promotion (recommended).** Komodo deploys to a **staging stack on the prod daemon**, smoke-tests, then promotes to the live prod stack — so a bad build never touches real prod data.
- **Secrets split.** CI secrets live in **Forgejo Actions secrets**; prod secrets live in **Komodo/Vault** — never in git. The committed `ci-realm.json` carries **throwaway** CI secrets only.
- **Rollback.** Prod compose files pin image **digests**; Komodo keeps the prior digest to roll back on a failed post-deploy probe.
- **Backup before destructive migrations.** Any schema/data migration step takes a `mongodump`/`pg_dump` first (see runbook Phase 14).

### 2.7 Production configuration the pipeline must satisfy (external access)

Because the **prod APK bakes the BFF URL** and auth is OAuth, the CD path must produce/consume a coherent public-origin config (full steps in runbook Phases 10–11):

- Prod APK baked to `https://app.jumbleknot.net` (public host, HTTPS) — **not** an IP or `:8082`.
- Keycloak prod mode: `KC_HOSTNAME=auth.jumbleknot.net`, proxy headers, real SMTP, brute-force on, admin console not public.
- `movie-collection-manager` client **valid redirect URIs** include the web origin **and** the mobile app-link/custom-scheme deep link (or on-device login loops).
- BFF issuer/`ROOT_URL` → public `auth.` origin; session cookie `Secure`+`HttpOnly`, domain `app.jumbleknot.net`; CORS limited to the app origin.
- Ingress exposes **only** `app.`/`auth.` (Cloudflare Tunnel); all other services + the entire CI daemon stay private.

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

## 4. What still needs doing 🚧

### 4.1 Server foundation (new)
- Install/secure Ubuntu 26.04 LTS headless; SSH key-only; Tailscale; firewall.
- Stand up **two rootless Docker daemons** (`ci`, `prod`) with separate users, sockets, data roots, networks, volumes.
- Enable **KVM** and grant the CI runner user kvm access (see §2.4).

### 4.2 Forge + CI/CD services (new)
- Deploy **Forgejo** (+ its DB) on the prod or a dedicated infra context; create the repo as **SSOT**; configure the **push-mirror to GitHub**.
- Enable the **Forgejo OCI registry**.
- Register a **Forgejo Actions `act_runner`** on the CI daemon (Docker backend; kvm-capable label for the Android job).
- Deploy **Komodo**; connect it to the prod daemon; define the prod compose stacks it manages.
- Stand up the **self-hosted Nx remote cache** (MinIO/S3 backend) and wire `nx.json`.

### 4.3 Environment provisioning (the original blocker — still required)
The full stack still needs a reproducible environment. The committed **Keycloak realm export** remains the right fix:

| Needed in CI | Source today | Note |
|---|---|---|
| `infrastructure-as-code/docker/keycloak/.env.local` | hand-created from `.env.local.example` | `KC_DB_PASSWORD` + client secrets |
| `.../keycloak/secrets/keycloak_db_password.txt` | hand-created | must match `KC_DB_PASSWORD` |
| `frontend/mcm-app/.env.docker` | hand-filled from `.env.docker.example` | `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET` |
| `jumbleknot` realm + clients + generated secrets | created manually in Keycloak | no committed realm export yet |
| Test user (`E2E_TEST_USER`) with `mc-user` role | manual / registration | needed by every Maestro login |

**Path:** export the configured `jumbleknot` realm **with users + client secrets** (throwaway CI values are fine to commit), commit it (e.g. `infrastructure-as-code/docker/keycloak/ci-realm.json`), wire Keycloak `--import-realm`, and have the pipeline write the env files from the now-known secrets in a "provision env" step before bring-up. Store real secrets in **Forgejo Actions secrets** (CI) and **Komodo** (prod), not in git.

### 4.4 Port + green the pipeline
- Port `android-e2e.yml` to Forgejo Actions; trigger on push to a working branch.
- Iterate past the known first-time failure points (each a few minutes to the next): `assembleRelease` signing/bundle in CI, fixture-seeding via `global-setup` at `:8082`, and the first Maestro agent flow on the KVM emulator.
- Add the **build-and-push images → Forgejo registry** step and the **Komodo deploy** trigger.
- Then: enable the **PR-gate** trigger; extend the harness to gate web E2E on PRs.

### 4.5 CD, public access & prod config (new)
- Add pipeline stages 9–12 (Trivy scan → registry publish → Komodo deploy → post-deploy probe + rollback).
- Stand up the **staging → prod promotion** path in Komodo on the prod daemon.
- Build the **prod APK** against the public host; wire Keycloak `KC_HOSTNAME`/redirect URIs and the BFF public-origin config (Phases 10–11).
- Cloudflare Tunnel exposing only `app.`/`auth.`; DNS on Cloudflare; TLS at edge or via Caddy DNS-01.

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
