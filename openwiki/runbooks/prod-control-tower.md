---
type: Runbook
title: Prod control tower (observability / audit / dormant Vault)
description: Promotes the env-gated observability, audit-sink, and Vault stacks to production as three independently up/down-able Komodo ResourceSync stacks, wired into the BFF and agent gateway via consumer env only — no app code change.
resource: docs/runbooks/prod-control-tower.md
tags: [production, observability, audit, vault, komodo, runbook]
timestamp: 2026-09-12T00:00:00Z
---

# Prod control tower (observability / audit / dormant Vault)

Three production stacks — `prod-audit` (OpenSearch audit sink, MVP), `prod-observability` (LangFuse +
Grafana/otel-lgtm + Unleash), and `prod-vault` (deliberately dormant) — deploy the same way as the rest
of prod: merge to `main`, Komodo ResourceSync picks it up. The BFF and agent gateway consume each
capability through environment variables only, so deploying a support stack never itself changes app
behavior; a capability only turns on when its consumer env is present. This is the production landing
of the secrets posture documented in [Secrets management](/openwiki/invariants/secrets-management.md)
(Vault here is the fail-open, dormant reader described there) and it shares the
[published-port reservation convention](/openwiki/invariants/published-port-reservation.md) for its two
tailnet-reachable operator UIs.

## Gotchas

- **Every consumer var is optional and additive.** No `${VAR:?}` on the consumer side — unset means
  silent no-op, so rollback is just removing the consumer env or the stack's `[[stack]]` block, not an
  app redeploy.
- **A one-shot init container that exits 0 reads as "unhealthy" to the deploy orchestrator.** Every
  init container in this stack set must provision then idle (not simply exit), and downstream services
  that depend on it must gate on a completion marker, not a bare "container exited" signal.
- **Non-root image runtimes and bind-mount ownership are the dominant class of prod-only failures
  here** — memlock rlimits, root-owned bind mounts under a non-root image user, and double-loaded
  entrypoint config all passed local `compose config` validation and only broke on the real prod host.
  Diagnose from container logs on the prod host itself, not from the compose file.
- **The two tailnet-reachable operator UIs (LangFuse, Grafana) use the prod-reserved port range**,
  binding broadly but staying tailnet-only via the host firewall — see
  [Published-port reservation](/openwiki/invariants/published-port-reservation.md) for the collision
  this convention exists to prevent; do not put these ports back on their old defaults.
- **Vault is intentionally left uninitialized and sealed in production.** A health-check override
  makes that state read as healthy; do not run the Vault init/unseal sequence as part of this rollout —
  it is out of scope until the ADR's revisit trigger fires.
- **A capacity check was done before enabling observability**, because the LangFuse/ClickHouse stack is
  the heaviest addition on the shared host — re-run a capacity check before any future footprint
  increase rather than assuming headroom persists.

## MinIO data-volume migration (uid 1000, feature 070)

The `langfuse-minio` image was built as root until feature 070. Migrating to non-root requires a
one-time `chown -R 1000:1000` on the data volume, done in the deploy window. Full procedure:
`docs/runbooks/prod-control-tower.md` (§ "One-time: migrate the MinIO data volume to uid 1000").

Three gotchas, all measured for real:

- **An early chown does NOT stay valid.** Root bypasses DAC checks, so the running root image keeps
  working on a `1000:1000` volume — but every object it writes afterwards is created **root-owned
  again**. Measured: `find /data ! -user 1000` went from `0` straight back to `2` after a single new
  object. So the chown must be the last thing before the non-root image starts, with nothing
  root-owned running in between. It is cheap and fast; it is not durable while root is writing.
- **Stop by container name, not via compose.** The prod stacks are Komodo-managed: Komodo clones the
  repo and runs compose from its own stack directory with env injected from Komodo Variables, so a
  hand-run `docker compose` from `$HOME` fails with "no configuration file provided" and unresolved
  `${LANGFUSE_*}` interpolation errors. Use `docker stop langfuse-minio` — the `container_name` is
  set explicitly and makes this equivalent without either problem.
- **The real gate is the digest-pin update, not the PR merge.** Both compose files pin `langfuse-minio`
  by digest. Merging the non-root image PR publishes a new digest but changes nothing live until the
  pins are updated in a separate commit. Do not perform the chown and then redeploy the old pinned
  image — the root process immediately resumes and undoes the migration. The sequence is only durable
  when step 5 (`docker redeploy prod-observability` via Komodo) starts the non-root image.

Verify with `find /data ! -user 1000 | wc -l` — must print `0`. Do not use `stat /data`; the
top-level directory can show `1000:1000` while children are still root-owned.

Full stack/compose/file table, Komodo Variable seeding list, deploy order per phase, and the complete
prod-only failure-symptom table: `docs/runbooks/prod-control-tower.md`.
