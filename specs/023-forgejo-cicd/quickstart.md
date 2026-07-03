# Quickstart: Validate the Forgejo CI/CD Pipeline

Runnable validation scenarios proving the feature end to end. References [contracts/](./contracts/) and [data-model.md](./data-model.md) instead of duplicating detail. Implementation lives in `tasks.md`.

## Prerequisites

- Homelab foundation running (confirmed): Forgejo + registered `act_runner` (a `kvm:host`-labelled runner for the Android job), Forgejo OCI registry, Komodo + prod daemon, self-hosted Nx cache server.
- Forgejo Actions **secrets/variables** populated per [contracts/secrets-and-variables.md](./contracts/secrets-and-variables.md).
- `ci-realm.json` committed; the `E2E_TEST_USER` in it matches the `E2E_TEST_USER` secret.
- Komodo Stacks defined for the prod compose files (operator UI step, one-time).
- `forge` is `origin`; the forge→GitHub push-mirror is already configured.

## Scenario 1 — US1 guardrails run & gate on the forge

```bash
# from a working branch
git commit -am "chore: trivial compliant change" && git push origin HEAD
```

**Expect**: on the forge, the `guardrails` workflow runs the resource-naming gate, inline-secret gate, whole-tree secret-scan, and agent gates; all report green on the commit.

**Negative**: add an inline credential-shaped string to a tracked compose file and push.
**Expect**: `secret-scan` (and/or inline-secret gate) **fails** and names the offending file — same finding GitHub Actions produced (FR-002, SC-001). Remove it → green.

## Scenario 2 — US2 full CI from a clean checkout

```bash
git push origin HEAD   # working branch touching frontend/agents/backend
```

**Expect** (`app-ci`):
1. provisions env: `gen-dev-secrets.mjs` mints `stacks/*.env`; `ci-realm.json` imports; no manual host prep (FR-006).
2. brings up auth → mcm stacks, healthy (FR-007).
3. web Playwright E2E green against the dev-container BFF — no Metro, no host-net hacks (FR-008, SC-003).
4. builds the release APK and runs the 4 Maestro agent flows per-file on the KVM emulator, green (FR-009).
5. **force a failure** (e.g. break a selector) → emulator screenshots, view hierarchy, and container logs upload as artifacts (FR-010).

**Cache check**: push a change touching only one project; confirm unaffected projects are skipped (nx affected + remote cache, FR-005).

## Scenario 3 — US3 green merge deploys itself

```bash
git checkout main && git merge --ff-only <green-branch> && git push origin main
```

**Expect** (`cd-deploy`, main-only):
1. builds the 6 service images via their Nx targets; Trivy scans each.
2. publishes scan-clean images to `${REGISTRY}/${NS}/<svc>` by `:${GIT_SHA}` **and** `@sha256:` digest (FR-014).
3. Komodo redeploys all prod stacks **by digest** — incl. the upstream prod-auth stack (FR-015, FR-015a).
4. post-deploy probe passes: `https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` reports `issuer = https://auth.${BASE_DOMAIN}`; `https://mcm.${BASE_DOMAIN}` health is 200 (SC-002, SC-004).

**Negative A — critical vuln**: introduce a known-vulnerable base image → Trivy fails → image **not** published, deploy **does not** proceed (FR-013, SC-006).

**Negative B — rollback**: force the post-deploy probe to fail → Komodo rolls back to the prior digest; prod stays on the known-good version (FR-016, SC-007).

**Negative C — missing prod secret**: unset a required `${VAR:?}` in a prod Stack → deploy aborts naming the variable, no fallback (FR-019, SC-010).

**Working-branch guard**: push to a non-`main` branch → `cd-deploy` does **not** run (FR-020).

## Scenario 4 — US4 GitHub Actions retired

```bash
ls .github/workflows 2>/dev/null   # expect: empty / no such directory
git push origin main               # mirrors to github
```

**Expect**: no workflow files remain (SC-008); the push mirrors to GitHub but starts **no** GitHub Actions run; `main` branch protection requires the `guardrails`/`app-ci` checks, not the retired GitHub checks (FR-023). The documented rollback (restore a workflow from history if the runner is down) is present (FR-024).

## Scenario 5 — Doc consistency (FR-028 / SC-011)

Confirm the four `docs/proposals/homelab-setup/` files and the feature-022 artifacts all describe "pipeline first, deploy 022 through it," single-step deploy, and the GitHub→Forgejo cutover — with no remaining "Phase 15 future dependency", "hand-deployed prod", or "two-step promotion (recommended)" wording.
