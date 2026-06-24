# CI/CD Cutover & Rollback (feature 023)

**Status**: implemented as feature 023. CI/CD is config-as-code under `.forgejo/workflows/` on the self-hosted Forgejo Actions `act_runner`. GitHub is a push-mirror that runs **no** Actions (FR-021/FR-022, SC-008).

This runbook documents (a) the GitHub→Forgejo cutover and (b) how to roll back to cloud CI if the homelab runner is unavailable (FR-024).

## The pipeline

| Workflow | Trigger | What it does |
|---|---|---|
| `guardrails.yml` | push, PR (all branches) | resource-naming + inline-secret + whole-tree secret-scan + keyless agent gates (lint/test/golden-replay). The MVP — gates every push. |
| `app-ci.yml` | push, PR (path-scoped) | nx-affected lint/build/unit (remote-cache-backed) + containerized web Playwright E2E + release APK + Maestro agent flows. Provisions its own env (`gen-dev-secrets.mjs` + `gen-ci-env.mjs` + imported `ci-realm.json`). |
| `cd-deploy.yml` | push to `main` | build 6 images via Nx targets → Trivy (critical blocks) → push by tag+digest → Komodo redeploy all prod stacks by digest → health probe → rollback to prior digest on failure. Builds the prod APK with the public BFF host baked. |

Branch protection on `main` requires the `guardrails` + `app-ci` checks (T021), so a working-branch push can never merge — and never deploys — unless CI is green (fail-closed, FR-020/FR-025).

## Cutover (GitHub Actions → Forgejo)

1. **Validate the forge pipeline first** (do NOT delete GitHub Actions before this):
   - Push a branch → confirm `guardrails` + `app-ci` run green on the forge (quickstart Scenarios 1–2).
   - Merge a green change to `main` → confirm `cd-deploy` publishes by digest, Komodo redeploys, the health probe passes (Scenario 3; validate the upstream Keycloak stack first per T018).
2. **Repoint branch protection** (operator, T021): set `main`'s required status checks to the `guardrails` and `app-ci` job names — never the retired GitHub checks.
3. **Retire GitHub Actions** (T020): delete `.github/workflows/*` (all five: `agent-gates.yml`, `android-apk.yml`, `android-e2e.yml`, `naming-gate.yml`, `secret-scan.yml`). Removing the files inherently disables Actions on the mirror (no workflow → no run). The release/prod APK build is intentionally *ported* (`app-ci.yml` for CI, `cd-deploy.yml` for prod); the debug-APK-on-push trigger is not carried over.
4. **Verify the mirror** (Scenario 4): push to the forge → it mirrors to GitHub and starts **no** GitHub Actions run; `ls .github/workflows` is empty.

## Rollback — runner unavailable

If the homelab `act_runner` (or the forge) is down and you need CI/merge gating in the interim:

1. **Restore a workflow from git history** onto the GitHub mirror to temporarily re-enable cloud CI. The retired workflows remain in history — restore the ones you need:

   ```bash
   # list the commit that deleted them, then restore from its parent
   git log --oneline -- .github/workflows
   git checkout <commit-before-deletion>^ -- .github/workflows/naming-gate.yml \
                                              .github/workflows/secret-scan.yml \
                                              .github/workflows/agent-gates.yml
   # (android-e2e.yml / android-apk.yml only if you also need mobile CI on the cloud)
   git commit -m "ci(rollback): temporarily restore GitHub Actions while the homelab runner is down"
   git push   # the mirror's GitHub Actions runs again
   ```

2. **Repoint branch protection** back to the restored GitHub checks for the duration of the outage.
3. **When the runner is healthy again**: re-validate the forge pipeline (cutover step 1), repoint branch protection to `guardrails`/`app-ci`, delete `.github/workflows/*` again, and confirm the mirror runs no Actions.

> The restored GitHub `android-e2e.yml` carried a `ci-provisioning` BLOCKER (no committed realm/secrets); feature 023 fixed that on the forge (`ci-realm.json` + `gen-ci-env.mjs`). A cloud rollback therefore gives you the **guardrails** gates reliably; the full app E2E is the homelab runner's job.

## Secrets & variables

CI credentials live in the **Forgejo Actions** secrets/variables store (never git); prod credentials live in **Komodo/Vault**. Inventory: [specs/023-forgejo-cicd/contracts/secrets-and-variables.md](../../../specs/023-forgejo-cicd/contracts/secrets-and-variables.md). The throwaway secrets embedded in `ci-realm.json` must match the matching Forgejo CI secrets (seed both from the same values).
