# Phase 1 Data Model: CI/CD Config Artifacts & Promotion

This feature has no application data. The "entities" are configuration artifacts and the records that flow between pipeline stages. Modeled here so contracts and tasks reference a shared vocabulary.

## Entities

### Workflow
A Forgejo Actions definition under `.forgejo/workflows/`.

| Field | Values | Notes |
|---|---|---|
| name | `guardrails` \| `app-ci` \| `cd-deploy` | behavior-named, not US/FR-named |
| triggers | push / pull_request / push-to-`main` | see [contracts/workflow-trigger-matrix.md](./contracts/workflow-trigger-matrix.md) |
| runner label | `ubuntu-latest` \| `kvm:host` | kvm label only for the Android-emulator job |
| gates | the checks that must pass | the RED/GREEN surface |

State: a workflow run is `queued → running → (success | failure)`. Only `cd-deploy` advances to publish/deploy, and only from a `success` CI signal on `main`.

### Service image
A built, scanned container artifact.

| Field | Source | Notes |
|---|---|---|
| service | one of mc-service, mcm-bff, agent-gateway, movie-mcp, web-api-mcp, spreadsheet-mcp | built via its Nx target |
| sha tag | `${REGISTRY}/${NS}/<service>:${GIT_SHA}` | human handle |
| digest | `@sha256:…` captured at push | **immutable promotion key** |
| scan verdict | pass \| critical-found | critical ⇒ not published, deploy blocked |

Lifecycle: `built → scanned → (published | rejected) → promoted(by digest) → (live | rolled-back)`.

### Prod stack (Komodo Stack)
A production compose definition Komodo redeploys on the prod daemon.

| Stack | Compose file | Image kind | Owner |
|---|---|---|---|
| prod-auth | `keycloak/compose.prod.yaml` | upstream (Keycloak, Postgres) — pinned digest | 022 authors, 023 deploys |
| prod-app | `bff/compose.prod.yaml` | CI-built (mcm-bff) + upstream (Redis/Mongo) | 022 authors, 023 deploys |
| prod-mc-service | (022/follow-up) | CI-built (mc-service) | consumed |
| prod-agents | (optional) | CI-built (gateway + 3 MCP) | consumed |

State per redeploy: `pending → converging → (healthy | rolled-back)`; rollback restores the prior digest.

### CI realm export (`ci-realm.json`)
Throwaway identity-realm config imported in CI. Carries realm `grumpyrobot`, the `movie-collection-manager` client, `mc-admin`/`mc-user` roles, the `E2E_TEST_USER`, and **throwaway** client secrets. Distinct from 022's sanitized `prod-realm.json`. Committed (throwaway-only) per FR-011.

### Secret / variable
A credential or config value, never committed.

| Store | Holds | Examples |
|---|---|---|
| Forgejo Actions secrets | CI credentials | `ANTHROPIC_API_KEY`, `E2E_TEST_USER/PASSWORD`, `FORGEJO_REGISTRY_TOKEN`, `KOMODO_WEBHOOK_*`, `NX_…_ACCESS_TOKEN`, BFF/Keycloak client secrets |
| Forgejo Actions variables | non-secret CI config | `REGISTRY`, `NS`, `NX_…_CACHE_SERVER`, `MODEL_PROVIDER` |
| Komodo / Vault | prod credentials | `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD`, BFF cookie/session secrets, `BASE_DOMAIN` |

Full inventory: [contracts/secrets-and-variables.md](./contracts/secrets-and-variables.md).

### GitHub push-mirror
The retained external mirror. After cutover: receives commits, runs **no** Actions, performs **no** deploy. Already configured (clarify) — verify-only.

## Relationships

```
Workflow(app-ci) --green--> Workflow(cd-deploy, main only)
   cd-deploy: Service image[6] --scan(pass)--> publish(tag+digest)
              --> Komodo redeploy(Prod stack[*] by digest)
              --> health probe --(fail)--> rollback(prior digest)
CI realm export --import--> CI Keycloak (app-ci provisioning)
Secret/Variable --inject--> Workflow steps (never committed)
```

## Validation rules (from requirements)

- A `cd-deploy` run MUST NOT start unless the same commit's CI is green on `main` (FR-020/FR-025).
- An image with a critical scan finding MUST NOT be published (FR-013).
- Prod MUST be deployed by digest, never rebuilt (FR-015).
- A missing prod secret MUST abort the deploy naming the variable (FR-019).
- No credential literal may appear in any committed workflow/compose file (FR-004, §Secrets Management) — enforced by the secret + naming gates, which run in `guardrails`.
- `ci-realm.json` MUST contain only throwaway secrets (FR-011).
