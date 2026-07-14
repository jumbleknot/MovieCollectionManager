# PRD — Dev-Container Stack Reproducibility (Realm Seed + Portable Compose)

**Status:** Proposed
**Created:** 2026-07-14
**Context:** Follow-up hardening from feature 038 (full dev-container toolchain). The final in-container
sign-off (T034: the web E2E on the real dev path) surfaced two gaps that make the app stack
**reproducible on the blessed setups (host Docker Desktop, CI, the v5-pinned dev container) but not
truly from-scratch portable.** That directly undercuts the dev container's core promise — *any
teammate, any fresh machine, an identical working environment.* Both were worked around by hand during
T034; this PRD proposes closing them properly.
**Related:**
[specs/038-devcontainer-full-toolchain/HANDOFF.md](../../specs/038-devcontainer-full-toolchain/HANDOFF.md),
[infrastructure-as-code/docker/keycloak/compose.yaml](../../infrastructure-as-code/docker/keycloak/compose.yaml),
[infrastructure-as-code/docker/keycloak/compose.ci.yaml](../../infrastructure-as-code/docker/keycloak/compose.ci.yaml),
[infrastructure-as-code/docker/keycloak/ci-realm.json](../../infrastructure-as-code/docker/keycloak/ci-realm.json),
[infrastructure-as-code/docker/stacks/mcm.compose.yaml](../../infrastructure-as-code/docker/stacks/mcm.compose.yaml),
[scripts/gen-ci-env.mjs](../../scripts/gen-ci-env.mjs),
[docs/runbooks/local-dev.md](../runbooks/local-dev.md),
[docs/runbooks/devcontainer.md](../runbooks/devcontainer.md),
PR #67 (`fix/038-devcontainer-compose-v5-parity` — the interim Compose-v5 bake this PRD makes durable).

---

## 1. Problem Statement

Standing up the MCM app stack from a genuinely clean state (a fresh dev container, a new teammate, or
any wiped data volume) fails in two non-obvious ways. Neither reproduces on a developer's long-lived
host because persistent Docker volumes hide them.

### Gap 1 — Dev Keycloak seeds no realm on a fresh volume

The dev auth stack runs Keycloak with `command: [start-dev]` and **no `--import-realm`**
([keycloak/compose.yaml](../../infrastructure-as-code/docker/keycloak/compose.yaml)). The
`grumpyrobot` realm, its clients (`movie-collection-manager`, `mcm-bff-service`, `mc-service`,
`mcm-bff-test`, …), and the `e2e-test-user` live **only in the persisted
`keycloak-store-postgres-data` volume** — imported once, long ago, on each existing developer's box.

- On a **fresh** environment, `pnpm nx up-auth` yields an **empty Keycloak** (master realm only). The
  BFF login, mc-service JWT validation, and the web E2E all fail with no obvious cause.
- The **only** automated realm import in the repo today is the **CI path** (`compose.ci.yaml`
  overlay + `ci-realm.json`), which the normal dev loop never invokes.
- This **compounds with the Postgres stale-password gotcha**: the documented fix for a
  `password authentication failed for user "keycloak"` crash is to wipe
  `keycloak-store-postgres-data` — which also wipes the realm, dropping a clean box into exactly this
  hole.

### Gap 2 — Stacks depend on Docker-Desktop-only Compose merge behavior

[stacks/mcm.compose.yaml](../../infrastructure-as-code/docker/stacks/mcm.compose.yaml) `include:`s the
per-service compose files and then **re-declares** imported services (`mc-service`, the BFF variants,
the agent services) at the top level **purely to attach a `profiles:` key** — an *include-override
merge*. This is accepted by newer Docker Compose (host Docker Desktop ships **v5.x**) but **rejected by
the v2.40.x line** the `docker-in-docker` feature installs, with:

```
services.mc-service conflicts with imported resource
```

PR #67 bakes Compose **v5** into the dev-container image, so the **dev container** and **CI** (which
installs the latest plugin) are covered. But the underlying compose files remain **non-portable**:
they assume a specific Compose implementation's merge semantics rather than being self-contained.

---

## 2. Goals

- **G1.** `pnpm nx up-auth` on a **fresh** `keycloak-store-postgres-data` volume yields a Keycloak with
  the dev realm + `e2e-test-user` + all app clients present — **no manual import, no CI overlay.**
- **G2.** A first-time dev-container open can bring the full app stack up and pass the core web E2E
  **without** the hand-rolled ci-realm dance from feature 038's T034.
- **G3.** The compose stacks parse and `up` **identically on any conformant Docker Compose** (v2.x
  apt-plugin, v5.x, future versions) — no dependency on include-override merge behavior.
- **G4.** No regression to the existing host-persistent-volume workflow, to CI, or to the prod realm
  path. No clear-text secret introduced (constitution §Secrets Management).

## 3. Non-Goals

- Changing the **prod** realm/import model ([prod-realm.json](../../infrastructure-as-code/docker/keycloak/prod-realm.json),
  Komodo-managed) — dev-only scope.
- Reworking the dev-container **toolchain/fast-startup/personal-layer** (feature 038, shipped).
- The agent/assistant E2E specs (need the gateway + LLM — out of scope, CI-covered).
- Removing the Compose-v5 bake from PR #67 — it stays as defense-in-depth even after G3.

---

## 4. Proposed Solution

Two independent workstreams. G3 (Gap 2) is the lower-risk mechanical change; G1/G2 (Gap 1) carries the
secret-handling nuance. They can ship together or in sequence.

### 4.1 Workstream A — Seed the dev realm on a fresh volume (Gap 1)

The dev auth stack must import a realm on first boot, the way CI already does, but with **dev-scoped,
self-consistent** values and no CI-only assumptions.

**Options considered:**

| Option | Approach | Trade-off |
|---|---|---|
| **A1 (recommended)** | Add a committed **`dev-realm.json`** + `--import-realm` to the dev auth stack (mount + command), with `${ENV_VAR}` secret placeholders resolved from `stacks/auth.env` (extend `gen-dev-secrets.mjs` to mint the client secrets + `E2E_TEST_PASSWORD`). | One new committed artifact; dev secrets minted like every other stack cred. Clean, self-contained, mirrors the proven CI mechanism. |
| **A2** | **Reuse `ci-realm.json`** for local dev via the same `compose.ci.yaml`-style overlay, wired into `up-auth`. | No new realm file, but couples dev to the CI throwaway realm and its client set; `up-auth` grows an overlay + a `gen-dev-secrets`-fed env. |
| **A3** | A **`seed-dev-realm` Nx target/script** that imports via `kcadm` after `up-auth`. | Keeps compose untouched but adds an ordering step humans forget — reintroduces "it didn't just work." |

**Recommendation: A1.** A committed `dev-realm.json` with placeholder secrets (never literals),
imported by the dev auth stack by default, is the smallest change that makes `up-auth` self-sufficient
on a clean volume. `gen-dev-secrets.mjs` already owns per-stack cred minting; extend it to emit the
realm's client secrets + a dev `E2E_TEST_PASSWORD` into `stacks/auth.env`, and Keycloak resolves the
`${…}` placeholders at import (KC ≥ 26 placeholder replacement, same mechanism feature 027 US5 uses).

**Secret handling (constitution):** the committed `dev-realm.json` carries **only `${ENV_VAR}`
placeholders**, exactly like `ci-realm.json` — zero literal secrets. Real per-machine values are
gitignored `stacks/auth.env` (gen-dev-secrets). The `secret-scan` gate must stay green.

**Interaction with the stale-password gotcha:** document that wiping `keycloak-store-postgres-data`
now *also* re-imports the realm on the next `up-auth` — turning the compounding failure into a clean
recovery.

### 4.2 Workstream B — Make the compose stacks portable (Gap 2)

Remove the dependency on the include-override merge so the stacks parse on any Compose.

**Options considered:**

| Option | Approach | Trade-off |
|---|---|---|
| **B1 (recommended)** | Move each `profiles:` assignment **into the included per-service compose file itself** (e.g. `mc-service/compose.yaml` declares `profiles: [app]` directly), deleting the top-level re-declaration block in `stacks/mcm.compose.yaml`. | No merge needed → parses on every Compose. Touches the per-service files (must confirm they aren't consumed elsewhere without the profile). |
| **B2** | Keep the bake (PR #67) + **pin `dockerComposeVersion`/document a min Compose version** as the contract. | Zero compose refactor, but leaves the latent landmine — only masks it. |

**Recommendation: B1**, with the PR #67 bake retained as defense-in-depth. Pushing `profiles:` down
into the service files is the change that removes the version dependency **entirely**, so the stacks
travel to any environment (older apt plugin, minimal Linux box, a future Compose v6) unchanged.

**Validation:** `docker compose … config` must succeed under **both** an older v2.x plugin and v5.x,
and `--profile app` / `--profile bff-nonsecure` must select the same service sets as today.

---

## 5. Acceptance Criteria

- **AC1 (G1/G2).** On a freshly created `keycloak-store-postgres-data` volume, `gen-dev-secrets` →
  `up-auth` produces a Keycloak whose `grumpyrobot` realm, `e2e-test-user`, and app clients are
  present — verified by a BFF login succeeding with **no** manual import step.
- **AC2 (G2).** A clean dev-container open runs `up-auth` → `up-mcm` → the **core web E2E green**
  using only committed config + `gen-dev-secrets`/`gen-ci-env` — no bespoke script.
- **AC3 (G3).** `docker compose -p mcm -f stacks/mcm.compose.yaml --profile app config` succeeds under
  a **v2.40.x** plugin (no "conflicts with imported resource") **and** v5.x, selecting identical
  services.
- **AC4 (G4).** `secret-scan` + `check-no-inline-secrets` stay green (no literal in `dev-realm.json`);
  the host-persistent-volume workflow, CI `app-e2e`, and the prod realm path are unchanged.
- **AC5.** [docs/runbooks/local-dev.md](../runbooks/local-dev.md) + [devcontainer.md](../runbooks/devcontainer.md)
  updated: fresh-volume bring-up is a documented one-command path; the stale-password recovery note
  reflects auto-reimport.

## 6. Risks & Mitigations

- **Dev realm drifts from prod/CI client set** → derive `dev-realm.json` from the same source of truth
  as `ci-realm.json` (or generate both from one template); add a lightweight consistency check.
- **`profiles:`-in-service-file breaks another consumer** that includes a per-service file directly →
  audit all `include:` sites before moving; the `--profile` selection tests (AC3) are the guard.
- **Placeholder-resolution differences across Compose/KC versions** → pin the min Compose in docs;
  keep the PR #67 v5 bake so the dev container is never the weak link.

## 7. Rollout & Sequencing

1. **Workstream B first** (mechanical, low-risk): push `profiles:` into service files; prove AC3 on
   both Compose lines. Unblocks any environment immediately.
2. **Workstream A** (realm seed): add `dev-realm.json` + extend `gen-dev-secrets`; prove AC1/AC2 on a
   wiped volume.
3. Docs (AC5) + a `verify-*`-style check that a fresh volume yields a working login, so the guarantee
   is regression-protected the way feature 038's `verify/` scripts protect the toolchain.

## 8. Priority

Gap 1 (Workstream A) is the **higher-impact** fix — it bites **every** fresh container / new teammate
and actively contradicts "reproducible dev container." Gap 2 (Workstream B) is currently **dormant**
(pinned by PR #67) but is a cheap, mechanical de-risking worth doing while the context is fresh.

---

> **Next step:** promote to a feature via `/speckit-specify` (candidate `039-devcontainer-stack-reproducibility`)
> — spec stays tech-agnostic (capabilities), with the realm-import/portable-profiles *mechanism* in
> `plan.md`, mirroring how 037/038 kept DinD and the prebuilt-image mechanism out of their specs.
