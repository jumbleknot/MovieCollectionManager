# Data Model: Dev-Container Stack Reproducibility

This feature has no runtime domain data. The "entities" are configuration artifacts and their invariants.

## Development realm definition — `infrastructure-as-code/docker/keycloak/dev-realm.json`

- **Represents**: the committed, from-scratch source of the dev `grumpyrobot` identity configuration.
- **Fields**: `realm: "grumpyrobot"`; `clients[]` (client-id set must equal `ci-realm.json`'s app-client set: `movie-collection-manager`, `mcm-bff-service`, `mc-service`, `mcm-bff-test`, `agent-gateway`, `agent-subject-token`, plus default KC clients); `users[]` including `e2e-test-user`; client secrets + the test-user password expressed **only** as `${ENV_VAR}` placeholders.
- **Invariants**:
  - INV-1 (secrets): no literal secret value — every secret is a `${ENV_VAR}` placeholder. (FR-004; secret-scan gate)
  - INV-2 (consistency): the client-id set and the `e2e-test-user` presence match `ci-realm.json`. (FR-013; `check-realm-consistency.mjs`)
  - INV-3 (issuer): redirect URIs / web origins are dev-appropriate (`localhost:8099` / `localhost:8082`), matching the dev Keycloak `KC_HOSTNAME`.
- **Lifecycle**: imported once by Keycloak on a fresh/empty volume (`--import-realm`, IGNORE-existing); ignored on an established volume.

## Per-machine secret set — `infrastructure-as-code/docker/stacks/auth.env` (gitignored)

- **Represents**: the real, per-machine values that resolve `dev-realm.json`'s placeholders.
- **Fields (new)**: `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `AGENT_SUBJECT_TOKEN_CLIENT_SECRET`, `AGENT_GATEWAY_CLIENT_SECRET`, `MC_SERVICE_CLIENT_SECRET`, `E2E_ROPC_CLIENT_SECRET`, `E2E_TEST_PASSWORD`.
- **Invariants**:
  - INV-4: minted by `gen-dev-secrets.mjs` from `auth.env.example` placeholders; never committed. (FR-005)
  - INV-5: the SAME values are the source the dev BFF/mc-service read for those clients → realm-secret == client-secret by construction. (research R-A2)
- **Lifecycle**: generated on first `gen-dev-secrets` run; `--force` rotates.

## Dev auth import overlay — `infrastructure-as-code/docker/keycloak/compose.dev.yaml`

- **Represents**: the dev-only Compose overlay that turns on realm import (dev twin of `compose.ci.yaml`).
- **Fields**: `keycloak-service.command += --import-realm`; `keycloak-service.volumes += <abs dev-realm.json>:…/grumpyrobot-realm.json:ro`; `${ENV}` passthrough for the placeholder secrets (fail-fast `${VAR:?}`).
- **Invariants**: INV-6: applied only on the dev bring-up path (second `-f`); the shared base and CI overlay are untouched. (FR-012)

## Profile map — per-service compose files + `stacks/mcm.compose.yaml`

- **Represents**: the mapping service → profile that selects which services a `--profile` starts.
- **Post-change shape**: each `profiles:` lives in the service's own included file; `mcm.compose.yaml` has **no** top-level `services:` re-declaration block.
- **Invariants**:
  - INV-7 (parse portability): the stack `config`-validates under both the v2.40.x apt plugin and v5.x with no "conflicts with imported resource". (FR-010)
  - INV-8 (selection invariance): each profile (`app`, `bff-nonsecure`, `bff-secure`, `agents`, `agents-metro`, and the no-profile default infra) selects an identical service set before and after the change. (FR-011)

## CI required-context — `.forgejo/workflows/infra-image-scan.yml`

- **Represents**: the branch-protection-required status `infra-image-scan / infra-image-scan`.
- **States**: on every PR the context is **present**; `success` when no infra image ref changed; the Trivy gate result (may be `failure`) when one did.
- **Invariants**:
  - INV-9 (always present): the required-named job always runs (no job-level `if`); Trivy steps are gated on the `changes` filter. (FR-007; research R-C1)
  - INV-10 (real gate preserved): an infra-touching PR runs the full scan and blocks on a fixable-Critical. (FR-009)
