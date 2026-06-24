# Contract: Image Build, Scan & Digest Promotion

Governs how `cd-deploy` turns source on `main` into a deployed production artifact. Promotion key is the **digest**, never a mutable tag.

## Buildable images (6)

| Service | Nx build target | Dockerfile | Registry repo |
|---|---|---|---|
| mc-service | `nx build mc-service` | `backend/mc-service/Dockerfile` | `${REGISTRY}/${NS}/mc-service` |
| mcm-bff | `nx docker-build mcm-app` | `frontend/mcm-app/Dockerfile` | `${REGISTRY}/${NS}/mcm-bff` |
| agent-gateway | `nx build movie-assistant` | `agents/movie-assistant/Dockerfile` | `${REGISTRY}/${NS}/agent-gateway` |
| movie-mcp | `nx build movie-mcp` | `mcp-servers/movie-mcp/Dockerfile` | `${REGISTRY}/${NS}/movie-mcp` |
| web-api-mcp | `nx build web-api-mcp` | `mcp-servers/web-api-mcp/Dockerfile` | `${REGISTRY}/${NS}/web-api-mcp` |
| spreadsheet-mcp | `nx build spreadsheet-mcp` | `mcp-servers/spreadsheet-mcp/Dockerfile` | `${REGISTRY}/${NS}/spreadsheet-mcp` |

`${REGISTRY}` and `${NS}` are Forgejo Actions **variables** (no committed host/namespace literal). Build runs through the Nx target (constitution), then the workflow retags for the registry.

## Pipeline contract (per image)

```
build (nx target)
  → tag  ${REGISTRY}/${NS}/<svc>:${GIT_SHA}
  → trivy image --exit-code 1 --severity CRITICAL  <local tag>
       └─ critical found ⇒ FAIL the job, do NOT push, do NOT deploy   (FR-013)
  → docker push  ${REGISTRY}/${NS}/<svc>:${GIT_SHA}
  → capture DIGEST = <svc>@sha256:…   (from push output / imagetools inspect)
  → record (svc, sha_tag, digest) into the run's deploy manifest
```

## Promotion contract

- Production is deployed by **digest** from the run's deploy manifest — `${REGISTRY}/${NS}/<svc>@sha256:…` (FR-015). The `:${GIT_SHA}` tag is a human handle only.
- Prod is **never rebuilt** for deployment; the prod daemon pulls the exact digest CI tested.
- **Upstream-image stacks** (Keycloak, Postgres, Redis, Mongo) are not built by CI; their compose files pin upstream digests (e.g. `quay.io/keycloak/keycloak:26.5.5@sha256:…`). CD redeploys them at their pinned digest (clarify: all prod stacks orchestrated).
- The prior digest per stack is retained by Komodo for rollback (see [komodo-deploy-and-rollback.md](./komodo-deploy-and-rollback.md)).

## Registry auth

- Login: `docker login ${REGISTRY} -u ${REGISTRY_USER} --password-stdin <<< ${{ secrets.FORGEJO_REGISTRY_TOKEN }}`.
- The plain-HTTP-over-Tailscale registry (if applicable) is handled at the daemon (`insecure-registries`), an operator setup detail — not a committed workflow concern.
