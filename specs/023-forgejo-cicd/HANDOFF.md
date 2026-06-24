# HANDOFF — Feature 023: Self-Hosted Forgejo Actions CI/CD (GitHub Actions Retirement)

**For a fresh session.** Read this first, then [spec.md](./spec.md) → [plan.md](./plan.md) → [research.md](./research.md) → [data-model.md](./data-model.md) → [contracts/](./contracts/) → [tasks.md](./tasks.md). Then run `/speckit-implement`.

## Where we are (2026-06-24)

SDD progress: **constitution ✓ → specify ✓ → clarify ✓ → plan ✓ → tasks ✓ → analyze ✓ → implement ⬜**.

- **Branch**: `023-forgejo-cicd` (HEAD `753a7c4`). Working tree clean. Branched off 022's HEAD; **022 implement is NOT done** (no prod compose files exist yet — see the boundary section).
- **tasks.md** = **29 tasks**, 7 phases (Setup → Foundational → US1 → US2 → US3 → US4 → Polish) + the analyze remediation (T018a). `/speckit-analyze` found 1 CRITICAL (FR-026 prod-APK gap) + 5 lesser — **all remediated** (`753a7c4`).
- The speckit git hooks **auto-commit** (`auto_execute_hooks: true`) — each `/speckit-*` step lands its own commit. `before/after_implement` git hooks are **optional** (commit prompts). This session committed: spec `06751c2`, clarify `9e5e113`, plan `dc09766`, tasks `bc10a90`, analyze-remediation `753a7c4`.

## ⚠️ READ BEFORE TOUCHING ANY FILE — domain is parameterized (history was scrubbed in 022)

The real domain was removed from the repo **and git history** (commit `e0a4f4c`, both remotes force-pushed; see the 022 HANDOFF + memory). **Never re-introduce the literal.** Convention:

- Public hosts are the literal tokens **`mcm.${BASE_DOMAIN}`** (app/BFF) and **`auth.${BASE_DOMAIN}`** (Keycloak) in docs/specs; in committed compose they interpolate `${BASE_DOMAIN:?…}` (fail-fast). The real value is injected at deploy (Komodo/Vault), never committed.
- **This feature adds a second rule**: do **not** commit infra-topology literals either (the tailnet host, the registry host/namespace, the Komodo webhook). Reference them through Forgejo Actions **variables/secrets** (`${{ vars.REGISTRY }}`, `${{ vars.NS }}`, `${{ secrets.KOMODO_WEBHOOK_AUTH }}`, etc.). See [contracts/secrets-and-variables.md](./contracts/secrets-and-variables.md).
- The realm **name** `grumpyrobot` is intentionally retained across the tree.

## What this feature is

Build the homelab CI/CD as config-as-code and retire GitHub Actions. Port the 5 GitHub workflows to **Forgejo Actions** (`.forgejo/workflows/`), add CD (build → Trivy → push by tag+digest → Komodo redeploy → health probe → rollback), wire the self-hosted Nx remote-cache client, commit a throwaway `ci-realm.json`, and cut GitHub to a push-mirror with no Actions. **Inverts** the old "hand-deploy prod, defer the pipeline (Phase 15)" order: build the pipeline first, then deploy feature 022 *through* it.

**User stories**: US1 (P1) guardrail parity on the forge — **MVP**; US2 (P2) full app CI; US3 (P3) CD publish+deploy+verify; US4 (P4) retire GitHub Actions.

## Clarified decisions (2026-06-23) — don't re-litigate

1. **Single-step deploy** straight to prod (no staging); post-deploy health probe + **digest rollback** is the safety net.
2. **CD orchestrates ALL prod stacks** — CI-built app images promote by the run's digest; upstream-image stacks (Keycloak/Postgres/Redis/Mongo) deploy at their pinned upstream digests. 022's Keycloak deploys through the pipeline.
3. **forge→GitHub push-mirror is ALREADY configured** — US4 only removes workflows + repoints gating (no mirror setup).
4. **CD fires automatically** on green CI on `main`, **no approval gate**. Working branches run CI only.

## Load-bearing facts (verified against the repo this session)

- **Homelab foundation already exists/running** (user-confirmed): Forgejo + registered `act_runner` (labels `ubuntu-latest`, `kvm:host`), Komodo + prod rootless daemon, Forgejo OCI registry (`…:3000/jumbleknot/<image>`), Beelink server w/ ci/prod daemons + KVM + self-hosted Nx cache server. **023 does NOT stand any of this up.**
- **6 buildable images**, each via its **Nx target** (constitution — never raw `docker build`): `mc-service` (`nx build mc-service`), `mcm-bff` (`nx docker-build mcm-app`), `agent-gateway` (`nx build movie-assistant`), `movie-mcp`/`web-api-mcp`/`spreadsheet-mcp` (`nx build <name>`). All build from repo root with `-f`.
- **`nx.json` is LOCAL-cache-only today** → T004 wires the self-hosted cache *client* via env (`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` var + `…_ACCESS_TOKEN` secret); no token literal.
- **Prod-APK URL bake**: `build-apk.mjs` reads `APK_VARIANT`/`APK_ABI`; the BFF URL is the Expo build-time var **`EXPO_PUBLIC_BFF_NATIVE_URL`** inlined into the bundle. T010 bakes the CI emulator URL (`10.0.2.2:8082`); **T018a** bakes the prod `https://mcm.${BASE_DOMAIN}` from a Forgejo var (this is FR-026 / resolves 022's open T017).
- **`gen-dev-secrets.mjs`** mints `stacks/*.env` from committed `*.env.example`; CI also fills `keycloak/.env.local` + `secrets/keycloak_db_password.txt` + `frontend/mcm-app/.env.docker` from CI secrets (T009).
- **Porting source** (the 5 GH workflows): `.github/workflows/{naming-gate,secret-scan,agent-gates}.yml` → `guardrails.yml` (US1); `android-e2e.yml` → `app-ci.yml` (US2); `android-apk.yml` → `app-ci` release APK + `cd-deploy` prod APK. `android-e2e.yml` carries the KVM-enable, latest-compose-plugin, auth→mcm bring-up, dev-BFF, `up-agents-prod`, Playwright seed, per-file Maestro sequence — reuse it.

## 022 ↔ 023 delivery boundary (critical for US3)

- **023 owns**: the 3 workflows, `ci-realm.json`, Komodo deploy wiring, `nx.json` cache client, GitHub retirement, doc reconciliation, the prod-APK build (T018a).
- **022 owns** (NOT yet implemented): `infrastructure-as-code/docker/keycloak/compose.prod.yaml`, `bff/compose.prod.yaml`, `prod-realm.json`, BFF public-origin env, redirect URIs, the `edge-network` naming-gate edit. Draft Keycloak prod compose is at `docs/proposals/homelab-setup/keycloak-prod.compose.yaml` (`name: prod-auth`).
- **Co-delivery**: US3's *full-app* prod deploy needs 022's prod compose to exist. **T018 validates the CD path first by deploying the upstream Keycloak prod stack alone** (no app build) — proving Komodo digest-deploy + probe + rollback before the app stacks land. The actual 022 app deploy completes when 022 implements its compose (that is the second clause of SC-011, gated on 022).

## Implement order & strategy

- **MVP = Phase 1 (Setup) + Phase 3 (US1 guardrails)** — US1 depends on **Setup only**, not Foundational. Ship/validate this first: push a branch, confirm the gates run green on the forge and catch a planted violation.
- Then Foundational (T004 nx cache) → **US2** (ci-realm + provisioning + `app-ci.yml`) → **US3** (CD; validate via upstream-KC stack) → **US4** (retire GitHub) once US1/US2 are trusted.
- **Polish** = FR-028 doc reconciliation (T024 homelab ×4, T025 the 022 artifacts) + quickstart run (T027) + CLAUDE.md CI-section update (T028) + remove the T001 smoke workflow (T026).
- **Adapted TDD** (constitution-compliant, tracked in plan Complexity): the **gates are RED/GREEN** — gate scripts, `docker compose config` fail-fast on `${VAR:?}`, Trivy on criticals, the ported E2E suites, the health probe. The per-story RED→GREEN tasks are **T007, T012, T019, T022**. tasks.md carries the literal expected RED/GREEN per checkpoint.

## Operator tasks (need you on the Forgejo/Komodo UIs — flagged `(operator)` in tasks.md)

- **T002** seed Forgejo Actions secrets/variables (exact names in [contracts/secrets-and-variables.md](./contracts/secrets-and-variables.md)).
- **T003** confirm runner labels (`ubuntu-latest`, `kvm:host`).
- **T013** define the Komodo Stacks for the prod compose files + record webhook URL/auth into Forgejo vars/secrets.
- **T021** repoint `main` branch-protection required checks to `guardrails`/`app-ci`.

## Gotchas / context

- Forgejo Actions YAML is GitHub-compatible; `uses:` marketplace actions resolve against GitHub by default. **Residual risk**: `android-emulator-runner` under rootless Docker + `/dev/kvm` — must **fail loudly** if KVM is unavailable, never silently skip the mobile suite (use the `kvm:host` runner; Server-Setup-Runbook §2.4).
- The dev stack needs Redis (BFF `/login` 500s without it), a replica-set Mongo (integration tests), and Keycloak up before the mcm `app` profile (JWKS on startup) — bring up auth→mcm in order (no cross-stack `depends_on`).
- Agent flows run **per-file** (parallel trips the per-user rate-limit + ~5-min token expiry); use `MODEL_PROVIDER=anthropic` in CI (avoids ~19 GB Ollama pull).
- **Doc contradiction to fix (FR-028 / T024)**: Server-Setup-Runbook §Phase 9 + PRD-CI §2.6 still say "two-step promotion (recommended)" — reconcile to **single-step + digest rollback** per the clarify.
- After the Metro suites are green, the final regression is the **dev-container web E2E** path (Metro OOMs) + the 4 mobile agent flows — reused as-is on the new runner, not re-authored. Platform Parity Table is **N/A** for this feature (documented in tasks.md).
- Memory: `project_mcm_023_forgejo_cicd` (+ the 022 memory + the 🚨 DOMAIN scrub note) carries the full record.

## Next step — run `/speckit-implement`

Start with the MVP (Setup + US1). Expect operator pauses at T002/T003 (and later T013/T021). Keep the secret + naming gates green throughout — they now run *on the homelab runner* and gate every push.
