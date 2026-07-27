---
type: Architecture
title: Infrastructure-as-code stacks (local Compose + production Komodo)
description: How the four independently operable local Docker Compose stacks (auth, mcm, audit, observability) and the four production Komodo ResourceSync stacks are defined as config-as-code, and the ordering/topology rules that keep them from colliding or drifting.
resource: infrastructure-as-code/komodo/stacks.toml
tags: [infrastructure, docker-compose, komodo, deployment, nx]
timestamp: 2026-07-06T19:56:40-04:00
---

# Infrastructure-as-code stacks (local Compose + production Komodo)

`infrastructure-as-code/` is where every environment's runtime topology is defined as config, not
provisioned by hand. It has two distinct halves that share the same service definitions but serve
different purposes:

- **Local/dev Compose stacks** (`infrastructure-as-code/docker/stacks/*.compose.yaml`) — four
  independently operable named stacks, each its own Compose project using `include:` + `profiles`:
  `auth` (Keycloak + its Postgres + Mailpit), `mcm` (Mongo/Redis test infra plus profile-gated
  [mc-service](/openwiki/projects/mc-service.md), the [BFF](/openwiki/projects/bff.md), and the agent
  layer), `audit` (the OpenSearch audit sink), and `observability` (LangFuse + otel-lgtm + OPA +
  Unleash). Each is driven through Nx targets defined in `infrastructure-as-code/project.json`
  (`up-auth`, `up-mcm`, `up-audit`, `up-observability`, `up-all`, and their `down-*` counterparts),
  never invoked as raw `docker compose` by convention.
- **Production stacks** (`infrastructure-as-code/komodo/stacks.toml`) — four `[[stack]]` blocks
  (`prod-auth`, `prod-mc-service`, `prod-mcm-bff`, `prod-movie-assistant`) that a Komodo
  ResourceSync diff-applies and deploys in `after`-declared dependency order: auth first (mc-service
  fetches Keycloak's JWKS on startup), then mc-service, then the BFF, then the agent/MCP stack last
  (spreadsheet-mcp needs the BFF's network and Redis). Every production deploy after the one-time
  Komodo bootstrap is `git push` → signed webhook → reconcile — see
  [CI/CD pipeline](/openwiki/projects/ci-cd-pipeline.md) for what fires that webhook.

## Gotchas

- **No cross-project `depends_on` between the local stacks — bring `auth` up before `mcm`'s `app`
  profile manually**, or [mc-service](/openwiki/projects/mc-service.md) hangs waiting for Keycloak's
  JWKS endpoint. This was a deliberate removal (feature 020), not an oversight.
- **The committed `stacks.toml` never carries a real host, domain, or IP.** The git-provider host
  lives in a separately bootstrapped Komodo `Repo` resource referenced by name (`linked_repo =
  "mcm-repo"`); the production domain, tailnet admin address, and registry host are Komodo
  *Variables*, interpolated at deploy time — the committed TOML carries only variable references, not
  values. A CI gate scans this file specifically to block a real value from landing in git; see
  [Secrets management](/openwiki/invariants/secrets-management.md) for the full no-clear-text-secret
  posture this stack config lives under.
- **Image digests are not in `stacks.toml`.** A separate, host-free `.env.deploy` file (written by
  [the CI/CD pipeline](/openwiki/projects/ci-cd-pipeline.md)'s digest-by-git promotion step) carries
  the bare digest per service; the compose files assemble the pull reference from a Komodo-injected
  registry-host variable plus that digest. Editing a digest by hand defeats the promotion mechanism.
- **All four live production stacks were adopted in place, not created fresh.** The ResourceSync
  reconciles against already-running containers with matching names — a rename or restructuring here
  is a config *diff* against a live system, not a from-scratch stand-up; preview the diff before
  applying. See [Phase 15 operator checklist](/openwiki/runbooks/phase-15-operator-checklist.md) for
  the manual consolidation that got the stacks to this ResourceSync-managed state.
- **Every prod admin/UI port lives in a reserved range, and moving one requires updating its own
  self-referencing URL variable too** — see
  [Published-port reservation](/openwiki/invariants/published-port-reservation.md) for the collision
  this convention exists to prevent and the secondary-reference trap.
- **HashiCorp Vault is deployed as part of the `auth` stack's `vault` profile but is deliberately
  dormant in production** — see [Secrets management](/openwiki/invariants/secrets-management.md) for
  why, and don't treat its presence in the stack definitions as evidence it's the active secrets
  backend.

See [Homelab server setup](/openwiki/runbooks/server-setup.md) for how the underlying host and its two
segregated rootless Docker daemons were provisioned, and `docs/MCM-Architecture.md`'s "Docker
Infrastructure" section for the full per-stack service/profile table and local bring-up commands.
