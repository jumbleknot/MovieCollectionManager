---
type: Runbook
title: Prod control tower (observability / audit / dormant Vault)
description: Promotes the env-gated observability, audit-sink, and Vault stacks to production as three independently up/down-able Komodo ResourceSync stacks, wired into the BFF and agent gateway via consumer env only — no app code change.
resource: docs/runbooks/prod-control-tower.md
tags: [production, observability, audit, vault, komodo, opensearch, runbook]
timestamp: 2026-09-14T00:00:00Z
---

# Prod control tower (observability / audit / dormant Vault)

Three production stacks — `prod-audit` (OpenSearch audit sink, MVP), `prod-observability` (LangFuse +
Grafana/otel-lgtm + Unleash), and `prod-vault` (deliberately dormant) — deploy the same way as the rest
of prod: merge to `main`, Komodo ResourceSync picks it up. The BFF and agent gateway consume each
capability through environment variables only, so deploying a support stack never itself changes app
behavior; a capability only turns on when its consumer env is present. This is the production landing
of the secrets posture documented in [Secrets management](../invariants/secrets-management.md)
(Vault here is the fail-open, dormant reader described there) and it shares the
[published-port reservation convention](../invariants/published-port-reservation.md) for its two
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
  [Published-port reservation](../invariants/published-port-reservation.md) for the collision
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

### Fresh volumes — the migration is not owed

The migration above is for a volume carrying **root-era data**. A volume created empty — by the
`docker volume create` prerequisite or by `compose up` on a host that has never run the stack —
needs no chown and no operator step at all.

That is true because the **image** carries `/data` owned by `1000:1000`, and Docker seeds a fresh
empty named volume from the image directory it is mounted over, ownership included. It was **not**
true of the image published as `sha256:629bcee8…`, which has no `/data`: a from-empty bring-up on
that image creates a `0:0` volume and MinIO fails with the *same* `unable to rename … file access
denied` as an unmigrated volume — so the error points at a migration that was never owed. Fixed
2026-09-13; needs the new digest pinned in both compose files to take effect.

**If you see that error on a volume you just created**, do not chown it and do not conclude the
migration was missed — check the image first:

```sh
docker run --rm --entrypoint sh <the pinned image> -c 'stat -c "%u:%g" /data'   # must be 1000:1000
```

## Langfuse 4 + ClickHouse 25 cutover (feature 072)

Langfuse 4 requires ClickHouse 25, and the pair was only verified on **empty volumes**. Nothing
measured says an in-place ClickHouse 24→25 jump works, so the cutover **recreates the Postgres,
ClickHouse-data, and ClickHouse-logs volumes**, discarding production Langfuse trace history. Per
[ADR-0002](../decisions/adr-0002-stateful-major-upgrades.md) §4 that trade is ratified.

**The volume work must come BEFORE the merge.** Komodo reconciles `prod-observability` from `main`.
Merge first and it deploys Langfuse 4 straight onto the existing 3.x Postgres schema and a 24.3
ClickHouse data directory — exactly the in-place upgrade this sequence exists to avoid.

Steps 1–5 constitute a planned Langfuse outage. It is contained: no non-Langfuse service in this
stack `depends_on` langfuse, so otel-lgtm, OPA and Unleash keep running, and the agent gateway's
tracing is fire-and-forget (turns are unaffected; traces for the window are lost).

Four things that will catch you out, all hit for real:

1. **`docker compose` cannot be hand-run on this host** — Komodo runs compose from its own stack
   directory with Variables injected. Use container names (`langfuse-web`, `langfuse-postgres`, etc.).
2. **`docker compose down -v` would not remove these volumes anyway.** They are `external: true`;
   compose never removes an external volume. They must be removed *and re-created* by hand — Komodo's
   deploy fails with a missing-external-volume error if they are absent.
3. **`restart: always` is held by an explicit `docker stop`** — *unless the daemon restarts*. Keep
   the window short, and re-check the containers are still stopped just before triggering the redeploy.
4. **`docker stop` does not release a volume.** A stopped container still holds its mounts, so
   `docker volume rm` fails with `volume is in use` until the container is **removed**. Measured on
   the 2026-09-13 cutover: `langfuse-postgres` and `langfuse-clickhouse` must be `docker rm`'d after
   stopping, before attempting to remove their volumes.

**The MinIO volume is deliberately NOT recreated.** It holds blobs, not schema, and it was already
`chown`'d to uid 1000 by the migration above. A freshly-created MinIO volume failed to initialise in
dev even when correctly `chown`'d (`Unable to initialize backend: file access denied`), so recreating
it risks the stack not coming back for no benefit; orphaned blobs are harmless.

**Rollback:** revert the merge and redeploy. The volumes stay as they are — rollback does not restore
the old traces, which were discarded at step 2 by design. Langfuse 3 re-initialises the empty
volumes and comes up clean.

**After it is live:** confirm `--check-expiring` on the next scheduled `infra-image-scan` reports no
UNMATCHED entry (the `langfuse/langfuse:3` suppressions are deleted by the merge, so the gate
re-blocks if the advisory ever returns).

Full cutover script, verification commands, and rollback procedure: `docs/runbooks/prod-control-tower.md`
(§ "One-time: cut prod over to Langfuse 4 + ClickHouse 25 on RECREATED volumes").

## OpenSearch 2 → 3 for the audit sink, PRESERVING the history (feature 071)

Unlike the Langfuse cutover, this upgrade **keeps its data**. [ADR-0002 §4a](../decisions/adr-0002-stateful-major-upgrades.md)
reversed the original §4 "recreate volumes" decision once the audit store proved non-empty — **5,276 documents, 326.9 kb** in `mcm-agent-audit`. History moves across by snapshot and restore; the acceptance check is an **exact document count**, not a health check.

> **A zero from a filtered query means "no match", not "no data".** The count was nearly missed because `_cat/indices/mcm-agent-audit-*` returned empty — the pattern needs no trailing wildcard; the real index name is `mcm-agent-audit`. That empty result was one step from justifying the destruction of a security audit trail. Preserved verbatim from ADR-0002 §4a because the error shape recurs.

### Two deploys — the order is not negotiable

`path.repo` is a **static** OpenSearch setting: a node cannot register a filesystem snapshot repository unless it was *started* with that path configured. The live 2.x node had none, so:

```
DEPLOY A   still on 2.x   add the snapshot volume + path.repo → restart → register repo → SNAPSHOT
DEPLOY B   the upgrade    3.x on a NEW EMPTY data volume       → restore  → verify exact count
```

One deploy cannot work: it would mean snapshotting before the repository exists, or replacing the data volume before the snapshot is taken.

### Why this is safe

The 2.x data volume is **never touched**. 3.x starts on a new one, so at every moment there are two independent copies (the original volume and the snapshot). Rollback is non-lossy. Deleting the old volume is a separate, deliberate act afterwards — it is **not** part of this procedure.

### Load-bearing gotchas

- **Create the snapshot volume BEFORE deploying, and chown it to the node's uid.** It is `external: true`, so compose never creates it — a missing external volume aborts the deploy. A fresh volume mounted at `/mnt/snapshots` (a path the image does NOT contain) is root-owned; OpenSearch does not run as root and snapshots fail with a permissions error that does not name the volume. Derive the uid from the running container (`docker exec agent-audit-opensearch id -u`), never assume it.
- **Re-measure the document count at A5 — 5,276 was a reading, not a constant.** The audit sink is live during Deploy A. Write down the A5 count; that number is what the B5 check must reproduce exactly.
- **Stop at A8 and confirm `state: SUCCESS` before starting Deploy B.** There is no recovery path if the snapshot is absent when the old volume is replaced.
- **The new 3.x cluster must re-register the repository.** Repository registrations are cluster state, and Deploy B starts a new cluster on a new data volume. The snapshot *volume* is unchanged, but the cluster does not know about it — register `mcm-audit-repo` again before restoring.
- **Snapshot only `mcm-agent-audit`, with `include_global_state: false`.** Restoring system indices such as `.opendistro_security` across a major is a conflict risk with no upside (the init script re-provisions the audit writer account on every start).
- **Re-run the least-privilege provisioning check (B6) after restore.** Feature 071 widened the check to assert `read 403` and `delete 403` in addition to `write 201` — the old check was incomplete and would have passed vacuously on a broken privilege set.

### Rollback

Revert the Deploy B change so the compose points at the **2.x digest and the ORIGINAL data volume**, then redeploy. The 5,276 documents are exactly where they were; nothing was removed from that volume. The snapshot also still exists, so there are two ways back.

### Afterwards

Only once the restore is verified and has been running for a while: delete `agent-audit-opensearch-data` (the 2.x volume) and, optionally, the snapshot. **Neither deletion is part of this procedure.**

Full shell script (Deploy A and Deploy B), the `OS()` helper alias, and all verification commands: `docs/runbooks/prod-control-tower.md` (§ "One-time: OpenSearch 2 -> 3 for the audit sink, PRESERVING the history").

Full stack/compose/file table, Komodo Variable seeding list, deploy order per phase, and the complete
prod-only failure-symptom table: `docs/runbooks/prod-control-tower.md`.
