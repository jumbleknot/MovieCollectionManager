# Research: Dev-Container Stack Reproducibility

Phase 0 output. Each item is a decision that removes a "NEEDS CLARIFICATION" from the plan's Technical Context, in the format Decision / Rationale / Alternatives.

## R-A1 — How to wire the dev realm import without touching the shared base or the CI overlay

**Decision**: Add a dedicated `keycloak/compose.dev.yaml` overlay (dev twin of `compose.ci.yaml`) and apply it as a **second `-f`** on the dev bring-up Nx targets (`up-auth`, composite `up`). It appends `--import-realm` to the `keycloak-service` command and mounts `dev-realm.json` → `/opt/keycloak/data/import/grumpyrobot-realm.json:ro`.

**Rationale**: `up-auth` is a single-`-f` invocation today, so a second `-f` is a localized, reversible change. Not editing `keycloak/compose.yaml` (shared base) or `compose.ci.yaml` means the CI path is provably byte-for-byte unchanged (FR-012) — CI keeps layering `compose.ci.yaml` on the untouched base. Mirrors the already-proven CI overlay mechanism (lowest novelty).

**Relative-path caveat (must validate in tasks)**: `compose.ci.yaml`'s comment documents that Compose resolves a **relative** volume source against the **project directory** (the dir of the first `-f`), not the overlay file's dir — which is why CI passes an **absolute** `${CI_REALM_FILE}`. The dev overlay MUST do the same: mount via an absolute path supplied by the Nx target / a small wrapper (or an `${DEV_REALM_FILE:?}` var), never a bare `./dev-realm.json`, or Docker silently creates an empty directory. Validation: `docker compose -p auth -f auth.compose.yaml -f keycloak/compose.dev.yaml config` shows the mount source as the real file, and a fresh-volume `up` imports the realm.

**Alternatives considered**:
- *Edit the shared `keycloak/compose.yaml` base* (base gets `--import-realm` + dev mount; CI overlay overrides the mount by target path). Rejected: relies on Compose volume-merge-by-target semantics and risks a double-mount to the same import path in CI; makes "CI unchanged" harder to prove.
- *A2 from the PRD — reuse `ci-realm.json` for dev via `compose.ci.yaml`.* Rejected per PRD: couples dev to the CI throwaway realm and its client set.
- *A3 — a post-`up` `kcadm` seed script.* Rejected per PRD: adds an ordering step humans forget.

## R-A2 — Source of truth for the dev realm's client secrets (realm-secret == BFF-secret)

**Decision**: Mint the realm's client secrets + dev `E2E_TEST_PASSWORD` into gitignored `stacks/auth.env` via `gen-dev-secrets.mjs`, and make the **same `auth.env` values** the source the dev BFF/mc-service read for those clients (document the wiring in `local-dev.md`). Keycloak resolves the `${ENV}` placeholders at import from the overlay's `env_file: auth.env`.

**Rationale**: CI achieves realm-secret == BFF-secret by feeding both from the same Forgejo secret; dev must achieve the same invariant from one gitignored source, or login fails with a secret mismatch on a fresh box. Reusing `gen-dev-secrets` (already the per-stack cred minter, idempotent, `--force` to rotate) means no new secret-handling mechanism (constitution).

**Open validation (tasks)**: confirm exactly which dev BFF env file the dev loop reads (`frontend/mcm-app/.env.local` vs `.env.docker` vs Metro env) and ensure it derives from / equals `auth.env` for the client-secret vars. If they are separate today, add the minimal wiring so a single `gen-dev-secrets` run makes both agree.

**Alternatives**: hard-code dev secrets in `dev-realm.json` (rejected — constitution §Secrets Management); a separate dev-only generator (rejected — duplicates `gen-dev-secrets`).

## R-A3 — Where the realm-consistency check runs in CI

**Decision**: `check-realm-consistency.mjs` runs in the **guardrails** workflow (fast, keyless, already the home of the naming/secret-scan static gates) with a `--selftest` first, then the real check — matching the repo's gate convention.

**Rationale**: It is a static file-vs-file assertion (no stack), so guardrails (not app-ci) is the right, cheapest home; it then gates every PR that touches either realm file. Consistent with `check-no-inline-secrets.mjs` / `secret-scan.mjs` placement.

**Alternatives**: run only locally (rejected — drift would slip in); run in app-ci (rejected — heavier, unnecessary).

## R-B1 — Are any per-service compose files consumed standalone (profile-relocation risk)?

**Decision**: Safe to relocate `profiles:` into the per-service files. A tree scan shows only `stacks/*.compose.yaml` reference the per-service compose files, via `include:`. Nx `deploy`/`build`/`serve` targets invoke cargo / `docker build` / `cargo run`, not `docker compose up` of a per-service file, so none depend on a per-service service starting by default.

**Rationale**: The only risk (FR-011) is a consumer that `compose up`s a per-service file expecting the now-profiled service to start without `--profile` — none exists. The profile-selection-invariance contract (AC3) is the guard that catches any missed site.

**Open validation (tasks)**: re-run the audit grep at implementation time (`docker compose -f <per-service>.yaml` anywhere in `scripts/`, `.forgejo/`, docs) and record the result in the contract.

## R-C1 — Does a path-gated *skipped* job satisfy a required context in this Forgejo, or must the required job always run?

**Decision**: Make the **required-named job always run** and gate the Trivy **steps** (not the job) on the `changes` filter. Do NOT rely on skipped→success.

**Rationale**: The PRD documents the exact failure — in this Forgejo config, `infra-image-scan*` is *absent* (not "satisfied by zero-match") on a non-infra PR, and it explicitly warns a "conditional-only job posts nothing and re-creates Gap 3." `app-ci` sidesteps this by never path-filtering the workflow and keeping its required contexts on always-run jobs; its `app-e2e` *is* job-level-skipped but is one of several required contexts and the memory notes skipped jobs show a "transient orphaned pending" before settling. To avoid any dependence on that fragile settling for the *sole* required infra context, the always-run-job + step-level-`if` shape guarantees the context is posted `success` deterministically.

**Alternatives**:
- *Job-level `if: needs.changes.outputs.infra == 'true'`* (skip the whole job). Rejected — this is precisely the "conditional-only job" the PRD warns re-creates Gap 3.
- *C2 add `workflow_dispatch`.* Rejected per PRD — relies on a human per PR.
- *C3 remove from the required set.* Rejected per PRD — drops the per-PR blocking gate for infra changes.

## R-G1 — Will `dev-realm.json` be caught by a gitignore secret pattern?

**Decision**: Verify at implementation that the root `.gitignore` (`*.env`, `*.env.*`, `secrets/`) does not match `*realm*.json`; `ci-realm.json` is already committed, proving realm JSONs are tracked. Add the file explicitly and confirm `git check-ignore` reports it un-ignored before the secret-scan run.

**Rationale**: The committed `ci-realm.json` is the existence proof; the only risk is an over-broad new pattern. Cheap to confirm.

## R-G2 — Keycloak import strategy on an existing realm (idempotency proof)

**Decision**: Rely on Keycloak's default directory-import behavior with `--import-realm`, which **ignores** a realm that already exists (does not overwrite). No explicit `KC_IMPORT_STRATEGY`/`OVERWRITE` is set on the dev overlay.

**Rationale**: FR-002 requires non-destructive behavior on an established volume; the default IGNORE-existing behavior gives exactly that (established realm untouched; fresh volume imported). CI wipes the volume each run so it re-imports regardless — dev keeps its data. Validated by the "established volume" edge-case test (up-auth twice → no duplicate-import error, realm unchanged).

**Alternatives**: force overwrite each boot (rejected — would clobber a developer's local realm edits and slow every `up-auth`).
