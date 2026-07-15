# Contract: infra-image-scan always-post required context (US2 / FR-007..009 / AC6)

**Guarantee**: The branch-protection-required context `infra-image-scan / infra-image-scan` is posted on **every** PR, `success` when no infra image ref changed and the real Trivy gate when one did.

## Workflow shape (mirrors app-ci.yml)

- **Trigger**: `pull_request:` with **no `paths:` filter** (+ existing `schedule` weekly + `push`).
- **Job `changes`**: `dorny/paths-filter@v3`, output `infra` from the existing infra-image-ref path list.
- **Job `infra-image-scan`** (the required context): `needs: [changes]`, **no job-level `if`** (always runs). Trivy install + scan + gate **steps** carry `if: ${{ needs.changes.outputs.infra == 'true' }}`. Checkout/setup may always run.

## Verification (one PR of each kind — AC6)

- **PC-1 (non-infra PR)**: open a docs-only / `.devcontainer`-only PR. The commit status for the head SHA lists `infra-image-scan / infra-image-scan = success`, and the PR **merges via the API with no admin override** (no `405 "Not all required status checks successful"`).
- **PC-2 (infra PR)**: open a PR that modifies an infra image ref (e.g. a pinned `image:` tag). The `infra-image-scan` job runs Trivy; if a **fixable-Critical** is present the job **fails** and the PR is blocked.
- **PC-3 (context never absent)**: on both PR kinds, `infra-image-scan / infra-image-scan` is present in the head-SHA status list — never simply missing.
- **PC-4 (branch protection unchanged)**: the required-context pattern `infra-image-scan / infra-image-scan*` in `main` protection is unchanged; the fix is entirely in the workflow.

## Notes

- The required-named job MUST be the always-run job (step-level gating), NOT a job-level-skipped conditional — a skipped job posts nothing in this Forgejo and re-creates Gap 3 (PRD subtlety; research R-C1).
- `trigger-cd`/`dast`-style non-required jobs are irrelevant here; `infra-image-scan.yml` has no deploy path.
