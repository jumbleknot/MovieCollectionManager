# Runbook — Prod Control Tower (observability / audit / dormant Vault)

Feature **025**. Promotes the env-gated Control-Tower services to production as **three Komodo
ResourceSync stacks** — `prod-audit` (P1/MVP), `prod-observability` (P2), `prod-vault` (P3, dormant) —
then wires `prod-mcm-bff` + `prod-movie-assistant` to consume them via **env only** (no app code change).
Upstream images ⇒ no CI build/scan/digest; deploy = merge to `main` → ResourceSync, exactly like `prod-auth`.

Full acceptance runbook + SC checks: [specs/025-observability-audit-vault-prod/quickstart.md](../../specs/025-observability-audit-vault-prod/quickstart.md).
Contracts (variables, consumer-env, health/audit): `specs/025-observability-audit-vault-prod/contracts/`.

**Related (feature 026):** production data-tier authentication (MongoDB SCRAM + keyfile) →
[prod-data-tier-auth.md](prod-data-tier-auth.md); the prod secrets standard (Komodo Variables, not the
dormant Vault) → [ADR-0001](../decisions/ADR-0001-prod-secrets-management.md).

**Related (feature 028):** reboot-resilience — why the LangFuse (`3030`) and Grafana (`3002`) operator UIs
here now bind `0.0.0.0` (rootless-before-tailscaled boot race) and the post-reboot recovery checklist →
[prod-reboot-resilience.md](prod-reboot-resilience.md).

## Files

| Stack | Compose | `stacks.toml` block |
|---|---|---|
| prod-audit | `infrastructure-as-code/docker/opensearch/compose.prod.yaml` (+ reused `init-audit-user.sh`) | `prod-audit` |
| prod-observability | `infrastructure-as-code/docker/observability/compose.prod.yaml` | `prod-observability` |
| prod-vault | `infrastructure-as-code/docker/vault/compose.prod.yaml` + `vault/config/vault.hcl` | `prod-vault` |
| consumers | `bff/compose.prod.yaml`, `agents/compose.prod.yaml` (env + `agent-audit-network`) | extended `prod-mcm-bff` / `prod-movie-assistant` `environment` |

## One-time host prerequisites (prod host)

```sh
# 10 external volumes (data survives redeploys)
docker volume create observability-langfuse-postgres-v18-data   # spec 081 US8b: postgres 18 (the pre-18 -data volume is the rollback)
docker volume create observability-langfuse-clickhouse-data
docker volume create observability-langfuse-clickhouse-logs
# observability-langfuse-rustfs-data: on a FRESH host with no prior Langfuse data, create it empty
# (`docker volume create observability-langfuse-rustfs-data`). On a host that ALREADY holds the old
# store's data, NEVER create it by hand — the migration tool's `copy --apply` creates it (and refuses
# an existing target). See "cut prod Langfuse storage over to RustFS" below.
docker volume create observability-otel-lgtm-data
docker volume create observability-unleash-postgres-v18-data    # spec 081 US8b: postgres 18; restore the Unleash dump into it
docker volume create agent-audit-opensearch-v3-data
docker volume create agent-audit-opensearch-snapshots
docker volume create vault-store-data

# dedicated isolation network for the audit sink (FR-001) — only opensearch + gateway/BFF join it
docker network create agent-audit-network
```

## Seed Komodo Variables (masked) — BEFORE the first sync that references them

An unseeded `[[VAR]]` interpolates empty → the support compose's `${VAR:?}` aborts the deploy (intended
fail-fast). **15 new Variables** (13 observability + 2 audit); Vault dormant needs none.

- **audit (2):** `OPENSEARCH_INITIAL_ADMIN_PASSWORD` (strong — OpenSearch rejects weak), `OPENSEARCH_AUDIT_WRITER_PASSWORD`.
- **observability (13):** `LANGFUSE_SALT`, `LANGFUSE_ENCRYPTION_KEY` (64-hex), `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_PG_PASSWORD`, `LANGFUSE_CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_PASSWORD`, `LANGFUSE_RUSTFS_SECRET_KEY` (feature 080 — the RustFS store's secret; access key is the literal `langfuse`), `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`, `LANGFUSE_INIT_USER_PASSWORD`, `UNLEASH_PG_PASSWORD`, `UNLEASH_ADMIN_TOKEN`, `UNLEASH_CLIENT_TOKEN`.
- **kept for rollback until the feature-080 window closes (M7):** `LANGFUSE_MINIO_ROOT_PASSWORD`. No longer referenced by `stacks.toml`, but reverting the feature-080 merge restores the line that needs it — and a revert cannot recreate a Komodo Variable.
- **reused (NOT new):** `TAILNET_HOST` (already seeded for prod-auth) — LangFuse's tailnet `NEXTAUTH_URL`. The R10 operator-UI binds are `0.0.0.0` since feature 028, so they need no IP Variable.

The `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `_SECRET_KEY` are the **same** values the gateway consumes (the
deterministic bootstrap keeps its pinned keys valid). `UNLEASH_CLIENT_TOKEN` is the **client** token the app uses.

## Deploy order & verify (per phase)

1. **prod-audit (P1/MVP)** — merge → ResourceSync. Verify `agent-audit-opensearch` healthy and
   `agent-audit-init` completed with **write=201 / search=403** in its logs (SC-001, SC-006). Then wire
   consumers (already in the composes) and drive one assistant action → an `mcm-agent-audit*` doc lands.
2. **prod-observability (P2)** — capacity-check the host first, then merge → sync. Every service healthy
   (`langfuse-rustfs-init` and `unleash-seed` stay running and report **healthy** — they idle after
   provisioning, because Komodo counts an exited container as unhealthy). Wired checks: SC-002 (LangFuse trace), SC-003 (OTel
   span), SC-004 (`test_opa_authz.py` deny enforced), SC-005 (flip `mcm.agent.kill-switch`, no redeploy).
3. **prod-vault (P3)** — merge → sync. `vault-service` healthy while **uninitialized + sealed**;
   `docker restart vault-service` → still uninit/sealed, `vault-store-data` persisted; `git grep` → no token.
   **Do NOT run `vault operator init`** (out of scope).

Operator UIs (R10): only `langfuse-web` (`:19030`) + Grafana (`:19002`) — reach them over the tailnet
(`http://<TAILNET_HOST>:19030` / `:19002`). No public port anywhere. **(feature 029)** These bind
`0.0.0.0` (tailnet-only via ufw), NOT `${TS_ADMIN_IP}`, and use the **prod-reserved `19000–19099`** ports
so they can't collide with the CI runner's LangFuse/Grafana on the shared host (the old `:3030`/`:3002`
overlapped CI — see [prod-reboot-resilience.md](prod-reboot-resilience.md) + `check-prod-ci-port-collision.mjs`).

## One-time: cut prod Langfuse storage over to RustFS (feature 080, item #560)

**The authoritative step list is the contract**, `specs/080-minio-to-rustfs/contracts/migration-procedure.md`
(M0–M8). This section is the operator's orientation: the order, why it is that order, and the commands
for the night. Feature 080 replaced the object store everywhere with upstream `rustfs/rustfs`
(digest-pinned, runs as its own uid 10001, no compose `user:`). Production's data is moved **in
place**: the old drive is **copied** to a new volume that RustFS reads, and the original is never
written, so rollback is a revert onto it.

### Merging the PR IS the deploy — so the copy must exist BEFORE the merge

Komodo deploys `prod-observability` from `main` on every push. The new compose mounts the EXTERNAL
volume `observability-langfuse-rustfs-data`, which nothing but the migration tool creates. So:

1. **Before merge** (M0–M3): Komodo Variable `LANGFUSE_RUSTFS_SECRET_KEY` exists; the advance
   `inventory` said `migratable`; writers stopped; `manifest` taken; old store stopped; `inventory`
   again; `copy --apply` created the new volume.
2. **Merge** (M4): `app-ci` on `main` → `trigger-cd` → `cd-deploy` (`deploy=true`) → Komodo redeploys.
3. **After** (M5): `verify` → `parity.json` `pass`; a pre-migration trace with media and a new trace
   both load; every `prod-observability` container healthy; Grafana current.

**If the merge lands first, the deploy fails instead of starting on an empty store.** Measured
2026-10-11 in the dev container against the shipped `compose.prod.yaml` (Docker Compose 5.6.0, with
every OTHER external volume present so the RustFS one was the only gap), with and without pulling:
compose aborts with `external volume "observability-langfuse-rustfs-data" not found`, creates **zero**
containers, and does **not** create the volume. A scratch project then showed that a failed `up` of
this kind leaves the previously deployed containers **running and unchanged** — so an early merge
leaves Langfuse on the old store, still serving. Recover by doing M1–M3 and redeploying. (Komodo was
not exercised; this assumes its deploy is `docker compose up` on the new file, as the
`prod-observability` stack definition says.)

### The tool runs ON the host, from a checkout, through a wrapper

The host has no `node`. `scripts/object-store-migration.sh` runs the tool in a digest-pinned node
container with the host's rootless socket mounted, and the Docker CLI copied out of a digest-pinned
image — nothing is installed. Credentials go in by **name** from your shell, never on a command line:

```sh
cd <a checkout of this repository at the PR's commit>
export MIGRATION_DIR=$HOME/080-cutover          # evidence (inventory/manifest/copy/parity .json) lands here

# M0.4 — advance go/no-go (read-only; the store may be running — the record says sourceInUse)
scripts/object-store-migration.sh inventory --volume observability-langfuse-minio-data --out inventory-advance.json

# M1 — quiesce writers (by container name: this host's stacks are Komodo-managed, so a hand-run
#      `docker compose` fails with "no configuration file provided")
docker stop langfuse-web langfuse-worker

# M2 — manifest from the RUNNING old store, with ITS credentials
read -rs S3_SECRET_KEY && export S3_SECRET_KEY S3_ACCESS_KEY=minio      # value of LANGFUSE_MINIO_ROOT_PASSWORD
scripts/object-store-migration.sh manifest --endpoint http://langfuse-minio:9000 --network backend-network --out manifest.json

# M3 — stop the old store, inventory the STOPPED drive, copy
docker stop langfuse-minio-init langfuse-minio
scripts/object-store-migration.sh inventory --volume observability-langfuse-minio-data --out inventory.json
scripts/object-store-migration.sh copy --from observability-langfuse-minio-data \
     --to observability-langfuse-rustfs-data --out copy.json --apply

# M4 — merge the PR; watch app-ci → trigger-cd → cd-deploy deploy=true complete

# M5 — verify against the NEW store, with ITS credentials
read -rs S3_SECRET_KEY && export S3_SECRET_KEY S3_ACCESS_KEY=langfuse   # value of LANGFUSE_RUSTFS_SECRET_KEY
scripts/object-store-migration.sh verify --endpoint http://langfuse-rustfs:9000 --network backend-network \
     --manifest manifest.json --out parity.json
```

Each step refuses rather than guesses: `copy` without `--apply`, an existing target, a source still
mounted by a running container, an `inventory` whose search instrument fails its self-test, a
volume that does not exist (it is never created by looking at it). `copy.json` must show
`targetPreexisted: false`, `entriesNotOwnedByRuntimeUid: 0` and equal source digests.

**Rollback (M6)** — only if M5 or later checking fails: `git revert` the merge via a PR as usual
(it restores the old compose and the `stacks.toml` lines); Komodo redeploys the old store on the
untouched `observability-langfuse-minio-data` with `LANGFUSE_MINIO_ROOT_PASSWORD`. Writes accepted by
RustFS since M4 are lost (one-way format; accepted). Leave the new volume for diagnosis.

**Cleanup (M7)**, after the 14-day rollback window: delete `observability-langfuse-minio-data`, the
Komodo Variable `LANGFUSE_MINIO_ROOT_PASSWORD` and the `jumbleknot/minio` registry package (rollback
pulls it until then), then the cleanup PR removes the migration tool.

### Traps this procedure is built around, all of them hit for real

1. **`docker run -v <name>:/data` CREATES the volume when it does not exist**, and reports an empty
   drive (feature 070: Docker created the unprefixed `langfuse-minio-data` and it read as a
   measurement of production). The tool checks the volume exists before mounting it, and the real
   name is `observability-langfuse-minio-data`. There is also an unrelated `minio_minio-data` volume
   on the host — the Nx-cache store's (M8), not Langfuse's.
2. **A top-level `stat` is not ownership.** A drive can report the right owner at `/data` while
   entries below it do not (feature 070 trap 2). The tool counts every entry not owned by the
   image's uid, and requires 0.
3. **A search that finds nothing proves nothing until it is shown to find something.** BusyBox
   `grep` in its default locale misses every marker inside a binary `xl.meta`; the first production
   go/no-go (T003) reported "0 SSE" through exactly that blind spot (feature 080 research R19). The
   tool's `inventory` runs with `LC_ALL=C` and self-tests its search on a planted marker first.
4. **`restart: always` is held by an explicit `docker stop`** — *unless the daemon restarts*. Keep
   the window short and re-check the old store is still stopped before `copy`.

## One-time: cut prod over to Langfuse 4 + ClickHouse 25 on RECREATED volumes (feature 072, item #433)

Langfuse 4 requires ClickHouse 25, and `specs/072-langfuse-4-major/` verifies the pair **on empty volumes**.
Nothing measured says an in-place ClickHouse 24 -> 25 jump works, so the cutover recreates the data volumes.
Per ADR-0002 §4 this **discards the production Langfuse trace history**; that is the ratified trade.

### Why the volume work must come BEFORE the merge

Komodo reconciles `prod-observability` from `main`. Merge first and it deploys Langfuse 4 straight onto the
**existing** 3.x Postgres schema and a **24.3** ClickHouse data directory — exactly the in-place upgrade this
sequence exists to avoid. So the volumes are recreated while the stack is stopped, and the merge follows.

**That makes steps 1-5 a planned Langfuse OUTAGE.** It is contained: no non-langfuse service in this stack
`depends_on` langfuse, so otel-lgtm, OPA and Unleash keep running, and the agent gateway's tracing is
fire-and-forget (turns are unaffected; the traces for the window are simply lost).

### Three things that will catch you out

1. **`docker compose` cannot be hand-run on this host** — same reason as the object-store cutover above. Komodo
   runs compose from its own stack directory with Variables injected. Use **container names**.
2. **`docker compose down -v` would not remove these volumes anyway.** They are `external: true`, and
   compose never removes an external volume. They must be removed *and re-created* by hand — Komodo's
   deploy fails with a missing-external-volume error if they are absent.
3. **`restart: always` is held by an explicit `docker stop`** — *unless the daemon restarts*. Keep the
   window short, and re-check the containers are still stopped just before step 5.
4. **`docker stop` does not release a volume.** A stopped container still holds its mounts, so
   `docker volume rm` fails with `volume is in use` until the container is **removed**. Hit for real on
   the 2026-09-13 cutover; step 1b exists because of it.

<!-- history:begin -->
### The MinIO volume is deliberately NOT recreated

`observability-langfuse-minio-data` keeps its data. It holds event/media **blobs, not schema**, so it is
irrelevant to whether Langfuse 4's migrations run, and it was already `chown`ed to uid 1000 by the migration
above. A freshly-created MinIO volume failed to initialise in dev *even when correctly `chown`ed*
(`Unable to initialize backend: file access denied`), so recreating it risks not getting the stack back for
no benefit. The orphaned blobs are harmless.
<!-- history:end -->

`langfuse-redis` has **no volume** — its queue state clears on restart by itself.

```sh
# ── 0. PRE-FLIGHT (nothing destructive yet) ────────────────────────────────────────────────────────
docker volume ls | grep -i langfuse          # expect the four `observability-langfuse-*` names
docker ps --filter name=langfuse --format '{{.Names}}\t{{.Image}}'   # confirm still on :3 / 24.3
#   PR #440 must be reviewed and ready to merge BEFORE you start — step 5 is inside the outage window.

# ── 1. STOP, by container name ─────────────────────────────────────────────────────────────────────
docker stop langfuse-web langfuse-worker langfuse-minio-init \
            langfuse-postgres langfuse-clickhouse langfuse-redis langfuse-minio

# ── 1b. REMOVE the two containers that HOLD the target volumes ─────────────────────────────────────
#    STOPPING IS NOT ENOUGH. A stopped container still references its mounts, and Docker refuses to
#    remove a volume referenced by ANY container, running or not. Measured 2026-09-13 on the real
#    cutover — step 2 failed three times with:
#      Error response from daemon: remove observability-langfuse-postgres-data: volume is in use - [d0975dd…]
#    Safe: Komodo recreates both from compose on redeploy, and it must anyway because their images change.
#    `langfuse-minio` is deliberately left in place — it holds the volume we are KEEPING.
docker rm langfuse-postgres langfuse-clickhouse

# ── 2. REMOVE the three data volumes (external → compose will never do this for you) ───────────────
docker volume rm observability-langfuse-postgres-data \
                 observability-langfuse-clickhouse-data \
                 observability-langfuse-clickhouse-logs

# ── 3. RE-CREATE them immediately — external volumes are not auto-created ──────────────────────────
docker volume create observability-langfuse-postgres-v18-data   # spec 081 US8b: postgres 18 (the pre-18 -data volume is the rollback)
docker volume create observability-langfuse-clickhouse-data
docker volume create observability-langfuse-clickhouse-logs

# ── 4. VERIFY: three volumes exist and are EMPTY (each MUST print 0) ───────────────────────────────
#    Pull alpine FIRST. Otherwise the first iteration's pull progress (stderr) prints between the
#    `printf` label and the count (stdout), so the postgres line reads as if it produced no number at
#    all. Confusing at the best of times; worse mid-outage, where it looks like the check failed.
docker pull -q alpine:3.24
for v in observability-langfuse-postgres-data \
         observability-langfuse-clickhouse-data \
         observability-langfuse-clickhouse-logs; do
  printf '%s -> ' "$v"
  docker run --rm -v "$v":/d alpine:3.24 sh -c 'ls -A /d | wc -l'
done
docker ps --filter name=langfuse --format '{{.Names}}'   # MUST be empty — nothing restarted

# ── 5. MERGE PR #440, then redeploy `prod-observability` in Komodo EXPLICITLY ──────────────────────
#    Do not wait on a webhook: trigger the redeploy from Komodo so the moment of cutover is yours.

# ── 6. VERIFY the cutover ─────────────────────────────────────────────────────────────────────────
docker ps --filter name=langfuse --format '{{.Names}}\t{{.Status}}\t{{.Image}}'   # :4 / 25.12, healthy
docker logs langfuse-web 2>&1 | grep -ciE 'migration'      # >0 — ClickHouse migrations ran
docker logs langfuse-web 2>&1 | grep -iE 'Ready|init scripts'
#    Health + the LANGFUSE_INIT_* re-seed, from inside the network (no host port assumptions):
docker run --rm --network backend-network curlimages/curl:8.11.1 \
  -sS -o /dev/null -w '%{http_code}\n' http://langfuse-web:3000/api/public/health        # 200
docker run --rm --network backend-network curlimages/curl:8.11.1 -sS \
  -u "$LANGFUSE_INIT_PROJECT_PUBLIC_KEY:$LANGFUSE_INIT_PROJECT_SECRET_KEY" \
  http://langfuse-web:3000/api/public/projects                                            # the project
```

### Rollback

Revert the merge and redeploy. The volumes stay as they are — **rollback does not restore the old traces**,
which were discarded at step 2 by design. Langfuse 3 will re-initialise the empty volumes and come up clean.

```sh
# on a workstation
git revert --no-edit <merge-sha> && git push origin HEAD:main
# then redeploy prod-observability in Komodo
```

### After it is live

`langfuse/langfuse:3` and `-worker:3` suppressions are already deleted by the merge, so the infra-image gate
re-blocks if the advisory ever returns. Watch the first scheduled `infra-image-scan` afterwards and confirm
`--check-expiring` reports no UNMATCHED entry.

## One-time: OpenSearch 2 -> 3 for the audit sink, PRESERVING the history (feature 071, item #439)

Unlike the Langfuse cutover, this one **keeps its data**. [ADR-0002 §4a](../decisions/ADR-0002-stateful-major-upgrades.md)
reversed §4 for OpenSearch once the store turned out to hold **5,276 audit events**. The history moves across
by **snapshot and restore**, and the acceptance check is an **exact document count**, not a health check.

### Two deploys, and the order is not negotiable

`path.repo` is a **static** OpenSearch setting: a node cannot register a filesystem snapshot repository
unless it was *started* with that path configured. The live 2.x node has none. So:

```
DEPLOY A   still on 2.x   add the snapshot volume + path.repo -> restart -> register repo -> SNAPSHOT
DEPLOY B   the upgrade    3.x on a NEW EMPTY data volume      -> restore -> verify exact count
```

One deploy cannot work: it would mean snapshotting before the repository exists, or replacing the data
volume before the snapshot is taken.

### Why this is far safer than the Langfuse cutover

**The 2.x data volume is never touched.** 3.x starts on a new one, so at every moment there are two
independent copies (the original volume and the snapshot). Rollback is non-lossy. Nothing irreversible
happens here at all — deleting the old volume is a separate, deliberate act, later, and is **not** part of
this procedure.

```sh
# ═══ DEPLOY A — snapshot, still on 2.x ═══════════════════════════════════════════════════════════

# A1. Create the snapshot volume BEFORE deploying. It is `external: true`, so compose will never create
#     it and the deploy fails on a missing external volume — the same trap as the Langfuse cutover.
docker volume create agent-audit-opensearch-snapshots

# A2. CHOWN it to the node's uid. A fresh volume mounted at a path the image does NOT contain
#     (/mnt/snapshots) is created ROOT-owned, and OpenSearch does not run as root — snapshots would fail
#     with a permissions error that does not name the volume. DERIVE the uid, never assume it.
OS_UID=$(docker exec agent-audit-opensearch id -u)
echo "opensearch runs as uid ${OS_UID}"
docker run --rm -v agent-audit-opensearch-snapshots:/snap alpine:3.24 chown -R "${OS_UID}:${OS_UID}" /snap

# A3. Merge the Deploy A change (snapshot volume + path.repo, image STILL 2.x), then redeploy
#     `prod-audit` in Komodo. The node MUST restart — path.repo is static.

# A4. Confirm the node came back with the repo path configured.
ADMIN_PASS=$(docker exec agent-audit-opensearch printenv OPENSEARCH_INITIAL_ADMIN_PASSWORD)
OS() { docker exec agent-audit-opensearch curl -sk -u "admin:${ADMIN_PASS}" "$@"; }
OS 'https://localhost:9200/_nodes/settings?filter_path=nodes.*.settings.path' ; echo

# A5. RE-MEASURE the document count. 5,276 was a reading, not a constant — the sink is live, and THIS
#     number is what the restore must reproduce. Write it down.
OS 'https://localhost:9200/mcm-agent-audit/_count' ; echo

# A6. Register the repository.
OS -X PUT 'https://localhost:9200/_snapshot/mcm-audit-repo' \
   -H 'Content-Type: application/json' \
   -d '{"type":"fs","settings":{"location":"/mnt/snapshots"}}' ; echo

# A7. Snapshot `mcm-agent-audit` ONLY, and no global state. Restoring system/plugin indices such as
#     .opendistro_security across a major is a conflict risk with no upside (FR-017).
OS -X PUT 'https://localhost:9200/_snapshot/mcm-audit-repo/pre-os3?wait_for_completion=true' \
   -H 'Content-Type: application/json' \
   -d '{"indices":"mcm-agent-audit","include_global_state":false}' ; echo

# A8. GATE: state must be SUCCESS, and the index list must name mcm-agent-audit.
OS 'https://localhost:9200/_snapshot/mcm-audit-repo/pre-os3' ; echo
```

**Stop here and confirm A8 before starting Deploy B.**

```sh
# ═══ DEPLOY B — the upgrade, onto a NEW volume ═══════════════════════════════════════════════════

# B1. Create the new data volume. The OLD one is NOT touched — it is the rollback.
docker volume create agent-audit-opensearch-v3-data

# B2. Merge the Deploy B change (image -> 3.x digest, data volume -> agent-audit-opensearch-v3-data) and redeploy in Komodo.

# B3. STOP THE INIT CONTAINER FIRST. `agent-audit-init` runs init-audit-user.sh on startup, which POSTs
#     a verification doc to mcm-agent-audit — and the role carries `create_index`, so the stack
#     RE-CREATES the index on an empty volume before you can restore into it. Hit for real on the
#     2026-09-13 cutover; B4 failed with:
#       snapshot_restore_exception ... cannot restore index [mcm-agent-audit] because an open index
#       with same name already exists in the cluster
#     Nothing was lost (the index held exactly ONE init-verify doc, and the real data was in the
#     snapshot AND on the untouched 2.x volume) — but it is avoidable, so avoid it.
docker stop agent-audit-init

# B3b. The node comes up EMPTY on 3.x. Re-register the repository (repository registrations are cluster
#      state, and this is a new cluster on a new data volume — the snapshot VOLUME is unchanged).
ADMIN_PASS=$(docker exec agent-audit-opensearch printenv OPENSEARCH_INITIAL_ADMIN_PASSWORD)
OS() { docker exec agent-audit-opensearch curl -sk -u "admin:${ADMIN_PASS}" "$@"; }
OS -X PUT 'https://localhost:9200/_snapshot/mcm-audit-repo' \
   -H 'Content-Type: application/json' \
   -d '{"type":"fs","settings":{"location":"/mnt/snapshots"}}' ; echo

# B4. Restore.
OS -X POST 'https://localhost:9200/_snapshot/mcm-audit-repo/pre-os3/_restore?wait_for_completion=true' \
   -H 'Content-Type: application/json' \
   -d '{"indices":"mcm-agent-audit","include_global_state":false}' ; echo

# B5. THE ACCEPTANCE CHECK — this number MUST equal A5's, exactly. Take it BEFORE restarting the init
#     container: that container adds one more init-verify doc, so afterwards the count is A5 + 1, which
#     is correct but no longer comparable.
OS 'https://localhost:9200/mcm-agent-audit/_count' ; echo

# B5b. Now restart the init container.
docker start agent-audit-init

# B5c. IF B4 STILL FAILS with "an open index with same name already exists": the init container beat you
#      to it. Confirm the index is trivial (docs.count should be 1 — the init-verify doc), then delete and
#      restore. Safe: two independent copies of the real data exist (the snapshot, and the 2.x volume).
#        OS 'https://localhost:9200/_cat/indices/mcm-agent-audit?v&h=index,docs.count,store.size'
#        OS -X DELETE 'https://localhost:9200/mcm-agent-audit'
#      then repeat B4. If docs.count is NOT ~1, STOP — something else is writing and this is not that bug.

# B6. Re-run the least-privilege provisioning check (it now asserts write 201, read 403, search 403,
#     delete 403 — read and delete were added in feature 071).
bash infrastructure-as-code/docker/opensearch/init-audit-user.sh
```

### Rollback — non-lossy, unlike the Langfuse one

Revert the Deploy B change so the compose points at the **2.x digest and the ORIGINAL data volume**, then
redeploy. The 5,276 documents are exactly where they were; nothing was removed from that volume. The
snapshot also still exists, so there are two ways back.

### Afterwards

Only once the restore is verified and has been running for a while: delete `agent-audit-opensearch-data`
(the 2.x volume) and, if you want, the snapshot. **Neither deletion is part of this procedure** — leaving a
stale 327 kb volume behind is far cheaper than an unrecoverable audit trail.

## One-time: observability postgres 16 -> 18 for Langfuse + Unleash, PRESERVING Unleash (spec 081 US8b)

Both `langfuse-postgres` and `unleash-postgres` share one pin and move together. Data decision (spec 081
OQ-3): **Unleash flag state is preserved** by dump/restore; **Langfuse's Postgres is discarded** (ADR-0002
§4) and re-initialised by `LANGFUSE_INIT_*`, which recreates the `mcm` org, the `movie-assistant` project and
its keys, so gateway tracing keeps working. ClickHouse and RustFS are not touched. Anything created by hand in
the Langfuse UI (extra users, prompts, extra API keys) is lost. Restore the Langfuse dump the same way as the
Unleash one (step 4) if that matters on the day.

### Merging the PR IS the deploy — so the 18 volumes must be seeded BEFORE the merge

postgres 18 **will not start** on a 16 data directory. Measured 2026-10-20: it exits 1 when the old volume is
mounted at `/var/lib/postgresql` or at `/var/lib/postgresql/data`. It also exits 1 on an EMPTY volume mounted
at `/data`. With `restart: always` that is a crash loop for both databases. So the new compose mounts
`/var/lib/postgresql` on **new** external volumes, `observability-{langfuse,unleash}-postgres-v18-data`. The
16 volumes stay untouched as the rollback.

- **Merge before the volumes exist**: the deploy fails up front with `external volume "…-v18-data" not found`.
  The 16 containers keep running, unchanged. That outcome is safe. Recover by doing steps 1-5 and
  redeploying.
- **Merge after creating the volumes but before step 4**: Unleash comes up healthy on an **empty** database.
  `unleash-seed` recreates the three flags default-off, every other flag and toggle is gone, and nothing
  reports it. This is the outcome to avoid.

Rehearsed end to end in the dev container. See specs/081-major-dependency-upgrades/research.md "US8 (PR 8b …)".

**Done in prod 2026-10-20** (PR #809, `44817a42`): Unleash counts identical 16 → seeded 18 → live 18
(`api_tokens 2 · env_enabled 0 · feature_strategies 1 · features 3 · migrations 397`), both databases on 18.6
on the `-v18-data` volumes, Langfuse fresh and healthy. The real run hit three faults in the first version of
these steps; the commands below are the corrected ones:

- **The dump check.** `pg_dumpall` ends with the marker line, then `--`, then a blank line, so `tail -2`
  never shows the marker. Grep for it instead.
- **The password never reached the container.** A `read -rs` inside a pasted block consumes the NEXT pasted
  line as its input, so the variable came out empty. And even when it was set (length 32), the bare
  `-e POSTGRES_PASSWORD` form passed nothing through this host's `docker` CLI: the 18 entrypoint exited with
  `Database is uninitialized and superuser password is not specified`. Take the value from the RUNNING 16
  container (`printenv`, nothing typed) and pass it explicitly.
- **The wait loop spun forever** on a container that had already exited (`cannot exec in a stopped
  container`, once every 2 s). The loop is now bounded, detects the exit and prints the logs; and the
  `docker rm` is in a later block, so a failed start leaves its logs readable.

Paste each block on its own and check its stated output before the next one. If a block opens a new shell,
set `IMG` and `DIR` again first: an empty `$DIR` writes to `/` (`/counts-live18.txt: Permission denied`).
Until step 5, `docker start unleash-service langfuse-web langfuse-worker` returns you to 16 unchanged.

```sh
# Run on the prod host against the PROD rootless daemon. Containers are Komodo-managed, so use
# container names, never a hand-run `docker compose`.
IMG='postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
DIR=$HOME/081-us8b-cutover; mkdir -p "$DIR" && chmod 700 "$DIR"

# ── 0. PRE-FLIGHT (read-only) ─────────────────────────────────────────────────────────────────────
#    The PR is reviewed, CI is green, and it is ready to merge. Steps 1-5 are an Unleash + Langfuse outage.
docker ps --filter name=postgres --format '{{.Names}}\t{{.Image}}\t{{.Status}}'   # both on postgres:16-alpine
docker volume ls | grep -E 'observability-(langfuse|unleash)-postgres'           # only the two -data names
docker exec unleash-postgres psql -U unleash -d unleash -Atc \
  "select 'features',count(*) from features union all select 'feature_strategies',count(*) from feature_strategies
   union all select 'api_tokens',count(*) from api_tokens union all select 'env_enabled',count(*) from feature_environments where enabled
   union all select 'migrations',count(*) from migrations order by 1" | tee "$DIR/counts-16.txt"
docker pull -q "$IMG"                     # pull now, not mid-outage

# ── 1. FREEZE: stop the writers (the databases keep running for the dump) ─────────────────────────
#    Unleash SDK clients (gateway/BFF) serve their last-fetched flags while unleash-service is down.
docker stop unleash-service langfuse-web langfuse-worker

# ── 2. DUMP both 16 instances (the Langfuse one is the rollback copy only) ────────────────────────
docker exec unleash-postgres  pg_dumpall -U unleash  > "$DIR/unleash-16.sql"
docker exec langfuse-postgres pg_dumpall -U langfuse > "$DIR/langfuse-16.sql"
grep -c 'PostgreSQL database cluster dump complete' "$DIR/unleash-16.sql" "$DIR/langfuse-16.sql"   # 1 each
grep -c '^COPY' "$DIR/unleash-16.sql"      # non-zero (108 on the 2026-10-20 run)

# ── 3. CREATE the two NEW external volumes (the 16 volumes are NOT touched, now or later) ─────────
docker volume create observability-unleash-postgres-v18-data
docker volume create observability-langfuse-postgres-v18-data      # left empty: Langfuse initialises it

# ── 4. PRE-SEED Unleash on 18 in a throwaway container (no network, volume only) ──────────────────
#  4a. The password, from the RUNNING 16 container — never typed, never a `read` inside a pasted block.
UNLEASH_PG_PASSWORD=$(docker exec unleash-postgres printenv POSTGRES_PASSWORD)
echo "password length: ${#UNLEASH_PG_PASSWORD}"                                    # non-zero (32)
#  4b. Start, passing the value EXPLICITLY (bare `-e VAR` passed nothing on this host). Wait on TCP — a
#      socket-only check can pass against the entrypoint's temporary init server — bounded, and print the
#      logs if the container exits. Expect READY. On EXITED: stop here, read the logs, `docker rm` it.
docker run -d --name us8b-unleash-seed18 --network none \
  -e POSTGRES_USER=unleash -e POSTGRES_PASSWORD="$UNLEASH_PG_PASSWORD" -e POSTGRES_DB=unleash \
  -v observability-unleash-postgres-v18-data:/var/lib/postgresql "$IMG"
for i in $(seq 1 60); do
  docker exec us8b-unleash-seed18 pg_isready -h 127.0.0.1 -U unleash -d unleash -q 2>/dev/null && { echo READY; break; }
  [ "$(docker inspect -f '{{.State.Running}}' us8b-unleash-seed18)" = true ] || { echo EXITED; docker logs us8b-unleash-seed18 2>&1 | tail -30; break; }
  sleep 2
done
#  4c. Only after READY. psql prints set_config/setval result rows while replaying — that is normal.
docker exec us8b-unleash-seed18 psql -U unleash -Atc 'show data_directory'    # /var/lib/postgresql/18/docker
docker exec -i us8b-unleash-seed18 psql -U unleash -d postgres -q < "$DIR/unleash-16.sql" 2> "$DIR/restore.err"
cat "$DIR/restore.err"     # EXACTLY: role "unleash" already exists / database "unleash" already exists
docker exec us8b-unleash-seed18 psql -U unleash -d unleash -Atc \
  "select 'features',count(*) from features union all select 'feature_strategies',count(*) from feature_strategies
   union all select 'api_tokens',count(*) from api_tokens union all select 'env_enabled',count(*) from feature_environments where enabled
   union all select 'migrations',count(*) from migrations order by 1" > "$DIR/counts-18.txt"
diff "$DIR/counts-16.txt" "$DIR/counts-18.txt" && echo COUNTS-EQUAL                # MUST print COUNTS-EQUAL
docker stop us8b-unleash-seed18 && docker rm us8b-unleash-seed18                   # frees the volume

# ── 5. MERGE the PR, then redeploy `prod-observability` in Komodo EXPLICITLY ──────────────────────
#    Do not wait on a webhook. Trigger the redeploy so you choose the moment of cutover. The deploy
#    recreates both postgres containers on 18 and the new volumes, and starts the three stopped writers.

# ── 6. VERIFY ─────────────────────────────────────────────────────────────────────────────────────
docker ps --filter name=postgres --format '{{.Names}}\t{{.Image}}\t{{.Status}}'   # both postgres:18-alpine, healthy
docker inspect unleash-postgres --format '{{range .Mounts}}{{.Name}} -> {{.Destination}} {{end}}'
#                                     observability-unleash-postgres-v18-data -> /var/lib/postgresql  (nothing else)
docker exec unleash-postgres psql -U unleash -Atc 'select version()'               # PostgreSQL 18.x
docker ps --filter name=unleash-service --filter name=langfuse --format '{{.Names}}\t{{.Status}}'   # all healthy
#    Unleash: open the UI, or use the admin API with UNLEASH_ADMIN_TOKEN. Every flag, its per-environment
#    on/off and its strategies match what was there before step 1.
#    Langfuse: the UI on the tailnet (:19030) signs in with the INIT user. A new agent turn produces a trace
#    under `movie-assistant`.
#    If langfuse-web/worker show errors from before their database was replaced: docker restart langfuse-web langfuse-worker
DIR=$HOME/081-us8b-cutover                 # again — this usually runs in a NEW shell after the Komodo redeploy
docker exec unleash-postgres psql -U unleash -d unleash -Atc \
  "select 'features',count(*) from features union all select 'feature_strategies',count(*) from feature_strategies
   union all select 'api_tokens',count(*) from api_tokens union all select 'env_enabled',count(*) from feature_environments where enabled
   union all select 'migrations',count(*) from migrations order by 1" > "$DIR/counts-live18.txt"
diff "$DIR/counts-16.txt" "$DIR/counts-live18.txt" && echo LIVE-COUNTS-EQUAL     # MUST print LIVE-COUNTS-EQUAL
```

### Rollback — non-lossy for Unleash

Revert the merge and redeploy `prod-observability`. The compose goes back to `postgres:16-alpine` on the
ORIGINAL `-postgres-data` volumes, which hold the state exactly as it was at step 1. Flag changes made on 18
after the cutover are **not** carried back. `"$DIR/unleash-16.sql"` is a second way back.

`main` is protected, so the revert goes through a pull request like any other change:

```sh
# on a workstation, in a fresh worktree off origin/main
git revert --no-edit -m 1 44817a42 && git push origin HEAD:revert-081-us8b
# open the PR from that branch, merge it once green, then redeploy prod-observability in Komodo
```

### Afterwards

Once 18 has run for a while: delete `observability-unleash-postgres-data`, `observability-langfuse-postgres-data`
(the 16 volumes) and `$DIR`. **Neither deletion is part of this procedure.**

## Capacity check (T013) — result (2026-07-03)

Prod host (`prod@homelab`, ~57 GiB usable): **48 GiB RAM available**, actual container RSS ~2.2 GiB (app
is featherweight; Keycloak ~746 MB is the heaviest), `/var/lib/docker` on `/` with **759 GB free**.
Observability (~6–7 GiB) + prod-audit OpenSearch (~1.5 GiB) ≈ ~8 GiB → still ~40 GiB free. **Decision:
always-on (default), no opt-in fallback; ClickHouse `mem_limit: 4g` retained** (ample headroom, no need to
lower). Re-run the check (`free -h` + `docker stats --no-stream`) before any future footprint increase.

## Load-bearing gotchas (do not "fix" away)

- **Audit-init image MUST ship bash + curl.** `init-audit-user.sh` is `#!/usr/bin/env bash`; the bash-less
  `curlimages/curl` (Alpine) can't run it → `agent-audit-init` reuses `opensearchproject/opensearch:2`.
- **`mkdir -p …/stacks` before running the init script.** The reused script self-locates `../stacks/audit.env`
  and `cd`s into it BEFORE the `[ -f ]` guard; under `set -euo pipefail` a missing dir aborts the whole
  script (verified). The init service pre-creates an empty sibling `stacks` dir so the cd succeeds, no
  `audit.env` is found (Komodo checkout has none), and it falls back to the env vars.
- **BFF audit needs `OPENSEARCH_INSECURE_TLS=true`.** OpenSearch serves a self-signed cert; the BFF sink
  (`audit-sink.ts`) POSTs over https via `node:https` with `rejectUnauthorized:false` **only** when this is
  truthy — else the POST fails cert validation and no audit doc lands from the BFF path (SC-006). The
  gateway sink (`audit_sink.py`) uses `httpx verify=False`, so it needs no flag.
- **OPA uses the `-debug` image variant.** Distroless `openpolicyagent/opa` has no shell; `-debug` adds
  busybox so the `/health` wget healthcheck (and Komodo status) works. Policies already `import rego.v1`
  (OPA 1.x compatible). OPA is **fail-closed** on the BFF + gateway when `OPA_URL` is set.
- **ClickHouse capped via `mem_limit: 4g`** (R5) — 24.3 is cgroup-aware, so the container limit bounds its
  internal `max_server_memory_usage`. OpenSearch pinned `-Xms1g -Xmx1g`.
- **Dormant Vault health override.** `?uninitcode=200&sealedcode=200&standbycode=200` makes uninitialized +
  sealed read as healthy; the codes resume real meaning once an operator inits + unseals (future).

## Prod-only deploy gotchas (live rollout, 2026-07-04) — none catchable by `docker compose config`

Every one of these passed local `compose config`/guardrails but only surfaced on the prod host — they are
container-runtime realities (non-root images, root-owned mounts, one-shot exits, orchestrator health, image
entrypoints). Diagnose from `docker logs <svc>` on the prod host, not from the compose.

| Symptom (prod `docker logs`) | Cause | Fix |
|---|---|---|
| OpenSearch: `error setting rlimit type 8: operation not permitted` | prod daemon's memlock rlimit is finite; `ulimits.memlock: -1` (for `bootstrap.memory_lock`) can't be set | **drop** `bootstrap.memory_lock=true` + the `memlock` ulimit (memory-lock is a nicety for a 1 GB audit sink) |
| `agent-audit-init` Exited(1): `mkdir: … Permission denied` | image runs as uid 1000; bind mount makes `/opt/audit` root-owned | run the one-shot init as **`user: "0:0"`** |
| Komodo marks a stack **unhealthy** although services work; `mcm-stacks` PENDING "stack has unhealthy state" | Komodo counts **any exited container** as unhealthy — one-shot inits (`agent-audit-init`, `langfuse-rustfs-init`, `unleash-seed`) exit 0 | init provisions **then idles** (`… && exec sleep infinity`) with a trivial passing healthcheck; for `langfuse-rustfs-init`, gate the healthcheck on a `/tmp/ready` marker and flip `langfuse-worker`'s dep `service_completed_successfully` → `service_healthy` |
| Vault: `open /vault/data/vault.db: permission denied` | image runs Vault as non-root `vault` (uid 100); `/vault/data` is **not** in the image → volume lands root-owned | mount raft at **`/vault/file`** (a vault-owned image dir) — empty volume inherits `vault:vault` |
| Vault: `Failed to lock memory: cannot allocate memory` | finite memlock rlimit again; mlockall fails even with `IPC_LOCK` | **`disable_mlock = true`** in `vault.hcl` (also the recommended setting for raft/BoltDB mmap) |
| Vault: `bind: address already in use` on :8200 (crash loop) | the vault entrypoint appends `-config=/vault/config`; passing `-config=/vault/config/vault.hcl` too loads the listener **twice** | `command: ["server"]` **only** — let the entrypoint auto-load the dir. Keep `cap_add: IPC_LOCK` (entrypoint needs it, else it double-starts) |
| `mcm-stacks` PENDING, diff "**.env.deploy contents changed**" for the app stacks (after a deploy) | normal cd-deploy digest-promote rewrote `.env.deploy` | click **Execute Sync** in Komodo — benign |

**General rule:** the vault config that finally works needs *all* of `/vault/file` + `disable_mlock=true` +
`cap_add: IPC_LOCK` + `command: ["server"]` together. When iterating a container that crash-loops in prod but
not locally, **reproduce locally with the prod constraints** (`docker run … --cap-add IPC_LOCK
--ulimit memlock=65536` …) to iterate in seconds instead of 40-min deploy cycles.

## Additive no-op (SC-008) & rollback (SC-010)

Every consumer var is **optional** (`${VAR}` in compose, never `${VAR:?}`; the `stacks.toml` refs are the
only place they get values). Deploying a support stack does **not** by itself change app behavior — the app
turns a capability on only when its consumer env is present (source gates: `audit_sink`/`OPENSEARCH_URL`,
`observability`/`LANGFUSE_*`+`OTEL_*`, `opa`/`OPA_URL`, `flags`/`UNLEASH_URL`). Unset ⇒ silent no-op ⇒
prior behavior unchanged. **Rollback** = remove the consumer env (→ no-op) and/or delete the support
`[[stack]]` block (→ ResourceSync removes it). No app redeploy needed to disable a capability. Each stack
is independently up/down-able.

## Guardrails (SC-009 — run before every push)

```sh
node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs
node scripts/check-no-inline-secrets.mjs
node scripts/check-resource-naming.mjs
node scripts/check-topology-scrub.mjs
```

The only gate change this feature needs is `agent-audit-network` in `APPROVED_NETWORKS` + the `vault`
volume prefix in `VOLUME_RE` (`scripts/check-resource-naming.mjs`).
