# Research: Replace MinIO with RustFS

**Feature**: 080-minio-to-rustfs | **Date**: 2026-10-10

Every claim below is tagged with how it is known:

- **[measured 2026-10-10, brief]** — measured on 2026-10-10 by the operator's session and handed to
  this specification as fact. Not re-run here unless stated.
- **[measured 2026-10-10, here]** — measured while writing this specification, in the dev container,
  against the exact image digests named. Commands are reproducible from `quickstart.md`.
- **[upstream doc]** — RustFS's own interop contract,
  `https://raw.githubusercontent.com/rustfs/rustfs/main/docs/architecture/minio-file-format-compat.md`,
  re-read 2026-10-10.
- **[to verify]** — not known yet; a task in `tasks.md` measures it.

---

## R1 — Why replace rather than keep repairing

**Decision**: replace MinIO everywhere with RustFS.

**Rationale**: Item #560's 2026-09-26 measurement: `amqp091-go v1.10.0` in the `go.mod` of our pin, of
the newest release `RELEASE.2025-10-15T17-29-55Z`, and of `master`. MinIO's community edition stopped
releasing eleven months before the 2026-09-16 advisories were published. Feature 069 gave this
repository the builder, not the dependency graph; with upstream frozen, every future Critical in
MinIO's direct dependencies lands as a permanent suppression. The four `jumbleknot/minio` allowlist
entries expire **2026-12-01** and nothing upstream will clear them.

**Alternatives considered**:

- *Standing suppression posture* — rejected: a time-box with no remediation path is a renewal
  treadmill, and #560 shows the image's channel is invisible when it goes red.
- *`go mod edit -replace` at build time* — rejected for grpc in item #420 as too large a change for one
  advisory; with upstream permanently frozen it becomes an open-ended fork of MinIO's dependency
  graph, maintained by this repository alone.
- *Fix #560's three faults in place* (customManager, visibility, prose) — rejected as the end state:
  it would make a dead upstream's staleness visible, not fixable.

## R2 — Is RustFS a viable upstream?

**Decision**: yes — `rustfs/rustfs`, Apache-2.0, pulled from Docker Hub.

- `1.0.0` GA 2026-09-16; `1.0.1` 2026-10-03 — a live release cadence. **[measured 2026-10-10, brief]**
- Image label `org.opencontainers.image.revision=6de965ae3c965a78ff819fbcd7acd4aa44177d92`,
  `org.opencontainers.image.created=2026-10-03T05:00:20Z`; `rustfs --version` → `rustfs 1.0.1`.
  **[measured 2026-10-10, here]**
- Both `1.0.1` and `1.0.1-glibc` scan **0 fixable Critical** under the gate criterion (Trivy 0.74.0,
  `--severity CRITICAL --ignore-unfixed`, ghcr DB mirrors). **[measured 2026-10-10, brief]**
- Docker Hub is the registry every other pulled server image here uses, so the infra-image sweep can
  read it (contrast `ghcr.io`, which the keyless sweep cannot — `backups/compose.yaml`'s WebDAV note).

## R3 — Alpine or glibc variant

**Decision**: `rustfs/rustfs:1.0.1` (the Alpine variant), digest-pinned.

| | `1.0.1` (Alpine 3.24.1) | `1.0.1-glibc` (Ubuntu 26.04) |
|---|---|---|
| Fixable Critical | 0 [brief] | 0 [brief] |
| Uncompressed size | **405 MB** [here] | 643 MB [here] |
| `curl` / `wget` | both [here] | `curl` only [here] |
| Runtime uid | 10001 [here] | 10001 [here] |
| Renovate tag line | plain semver | `-glibc` suffix (Renovate keeps suffixes as a compatibility class, so either is stable once chosen) |

**Rationale**: equal on the gate; smaller surface and smaller pull (which matters on CI's per-run
backup-destination bring-up, whose step ceiling was calibrated around image pulls — see
`scripts/ci-step-ceilings.tsv`); it is upstream's default tag; and the fleet is Alpine-heavy, so an
operator's muscle memory (`apk`, busybox) applies. Our load — a handful of Langfuse blobs and backup
test fixtures — gives musl's allocator nothing to lose on.

**Revisit trigger**: a musl-specific defect, or a fixable Critical that exists on the Alpine tag only.
Switching is a one-tag change in three compose files.

## R4 — What the RustFS image actually is

**[measured 2026-10-10, here]**, `rustfs/rustfs:1.0.1` (index digest
`sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c` as resolved locally;
`1.0.1-glibc` → `sha256:87763ed4dcb2bed3fc52cbf6cb7d865411e085b0b952dc78e50dffa9ece0ed9e`). The
implementer re-resolves the **index** digest with `docker buildx imagetools inspect` before pinning.

- `Config.User` is the **name** `rustfs`; `id` → `uid=10001(rustfs) gid=10001(rustfs)`.
- `Entrypoint ["/entrypoint.sh"]`, `Cmd ["rustfs"]`, `Volumes {"/data":{}}`, exposes 9000 and 9001.
- Env defaults: `RUSTFS_VOLUMES=/data`, `RUSTFS_OBS_LOG_DIRECTORY=/logs`,
  `RUSTFS_OBS_LOGGER_LEVEL=warn`, `RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=*`.
- `/data` and `/logs` are `10001:10001`, mode `0750`. No image `HEALTHCHECK`.
- `/entrypoint.sh` (read in full): normalises the command; validates `RUSTFS_ACCESS_KEY` /
  `RUSTFS_SECRET_KEY` (or `*_FILE`) — an **empty** value is a hard error, a **missing** one only
  warns and falls back to the built-in default `rustfsadmin` (the binary also honours `MINIO_ROOT_*`
  aliases, which the script does not inspect); `mkdir -p`s each data/log directory **only if it does
  not exist**, and chowns it only when `RUSTFS_UID`/`RUSTFS_GID` are set. **It never chowns an
  existing directory**, so it cannot repair ownership of a migrated drive.

**Consequence for compose**: credentials MUST be set via `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`
with `${VAR:?}` (fail-fast at interpolation), because the image's own fallback for a *missing*
credential is a warning plus a well-known default — the opposite of this repository's posture.

## R5 — Runtime identity: 10001 (image) vs `user: "1000:1000"` (compose)

**Decision**: run as the image's own uid **10001**; **no `user:` key in compose**; the migration
**chowns the copy** to the image's uid as it produces it.

**Measured [here]** — four RustFS 1.0.1 containers:

| Drive | Runtime identity | Result |
|---|---|---|
| Copy of a MinIO drive, chowned to 10001 | image default (10001) | starts; serves all objects; 0 ERROR lines |
| Copy of a MinIO drive, left at 1000 | `--user 1000:1000` | starts; serves all objects; **WARN** `/logs` `Permission denied` → `fallback_to_stdout` |
| **Fresh** named volume | `--user 1000:1000` | **FATAL** `Local disk initialization failed … Permission denied (os error 13)`, exit 1 |
| Fresh named volume | image default (10001) | starts; `/health` 200 |

The fresh-volume row is decisive. A fresh named volume inherits the image's `/data` (10001, 0750), so
`user: "1000:1000"` breaks **every** fresh environment — a new dev machine, and CI's backup
destination, which is created fresh on **every run**. Making 1000 work would need an extra root
one-shot per stack to chown `/data`, re-introducing exactly the root-owned-writer hazard feature 070
recorded (its trap 2: a root container recreated `.minio.sys/tmp` as `0:0` and the next non-root
start failed).

**Consistency with feature 070**: 070's contract I1 fixed the *number* 1000 because the image was
ours and a counter-allocated uid could drift. Its principle — I3, "the identity is stated in exactly
one place, the image" — is what this decision keeps: the image is now upstream's, and it states
10001. Compose still declares no `user:`. 070's I1 is superseded, not violated, and
`contracts/object-store-service.md` records it.

**Drift guard**: the uid is not written as a literal anywhere. The migration tool reads it from the
pinned image (`docker run --rm --entrypoint id <pinned> -u`) at run time; a Renovate bump that
changed the uid would make the tool chown to the new value, and the parity step's
"entries not owned by the runtime uid = 0" check catches any mismatch.

**Measured nuance**: only the *migrated* drives (prod Langfuse, dev Langfuse, Nx cache) need the
chown; the backup test destination's data is fixture-only and starts from a fresh volume.

## R6 — Does RustFS read our MinIO's drive, as built?

**[upstream doc]** reads unencrypted `xl.meta` meta_ver 1–3 (inline, multipart, versioned, delete
markers); imports `buckets/*/.metadata.bin` and `config/iam/` from `.minio.sys` into `.rustfs.sys` at
startup; one-way (MinIO cannot read a RustFS-written set); SSE fails closed (`InvalidObjectState`) in
default builds; tiered `xl.meta` not fixture-proven. **[measured 2026-10-10, brief]** MinIO's legacy
FS layout is not readable (balena-io/open-balena-s3 PR #333); drive count must match.

**Rehearsal [measured 2026-10-10, here]** with the exact deployed image
`jumbleknot/minio@sha256:8054a7ce…` (MinIO `RELEASE.2025-09-07T16-13-09Z`, uid 1000):

1. Fresh volume, `server /data`, bucket `langfuse`, 53 objects / 88 MiB: a 6-byte object (inline),
   a 2 MB object, a **90 MB object uploaded multipart** by `mc cp`, 50 small JSON objects under
   `events/b/`. Recorded MD5s.
2. `.minio.sys/format.json` → `"format":"xl-single"`, one set of one drive. Tree all owned by 1000.
3. Stopped MinIO; `cp -a` to two new volumes (one chowned to 10001, one not).
4. RustFS 1.0.1 on each: `mc ls -r` → **53 objects**, `mc du` → **88 MiB**, MD5s of the inline, 2 MB
   and multipart objects **identical**; new small and 30 MB uploads succeed; `.rustfs.sys/` created
   beside `.minio.sys/` (importer ran); `find /data ! -user <runtime uid>` → 0.
5. Credentials: RustFS started on a migrated drive with a **different** access key and secret than
   MinIO used → reads succeed with the new pair, the old pair is rejected, no ERROR lines. Root
   credentials are not baked into the drive for RustFS (contrast MinIO, `local-dev.md`'s
   "password-on-first-init" note).
6. Region `auto` (Langfuse's `LANGFUSE_S3_*_REGION`) — SigV4 list and put with region `auto` → 200.

**What the rehearsal does NOT prove for production [to verify]**: production's volume was created
long before feature 069 by the then-upstream `minio/minio` image, so its format record, `xl.meta`
versions and any legacy FS layout must be read **on the host** (task T003). Absence of SSE and tiered
objects must be measured on the host, not inferred from config.

**Observed noise**: every 5 s RustFS logs `WARN Ignoring unknown persisted scalar config key
scanner.idle_speed` (imported from MinIO's config) and once `automatic storage class has no parity`
(expected, single drive). Bounded by the stacks' `json-file` rotation; recorded so it is not chased
as a fault. [to verify] whether a config save clears the scanner key.

## R7 — Health check

**Decision**: `["CMD", "curl", "-fsS", "http://localhost:9000/health/ready"]` (exec form; the image
ships `curl`).

**[measured 2026-10-10, here]** unauthenticated, on a running 1.0.1: `/health` 200,
`/health/ready` 200, `/minio/health/live` 200, `/minio/health/ready` 200, `/rustfs/health` 403.

RustFS's own path is chosen, not the MinIO-compatible one, so nothing keeps a `minio` string alive and
the probe does not depend on a compatibility shim that RustFS may later drop. **[to verify]** (T011)
that `/health/ready` returns non-200 while the drive is still initialising — i.e. that it is a
readiness signal and not a liveness one; if it is not, the healthcheck adds an authenticated
`HEAD /<bucket>` probe.

The integration preflight (`tests/integration/setup/preflight.global.js`) currently probes
`/minio/health/live`; it moves to `/health/ready` for the same reason.

## R8 — Bucket creation without `mc`

**Decision**: the init container is the **same RustFS image** (already pulled, ships `curl`), creating
the bucket with `curl --aws-sigv4` and credentials fed on **stdin** as a curl config, never argv:

```sh
printf 'user = "%s:%s"\n' "$$S3_ACCESS_KEY" "$$S3_SECRET_KEY" \
  | curl -fsS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -X PUT http://langfuse-rustfs:9000/langfuse
```

**[measured 2026-10-10, here]**: PUT new bucket → 200; PUT **existing** bucket → **200** (idempotent,
no 409 to special-case); HEAD bucket → 200; wrong secret → 403 (and `-f` turns it into a non-zero
exit). `printf` is a shell builtin, so the secret is in neither the container's argv nor
`docker inspect`'s `Args` — preserving the rule `backups/compose.yaml` records from commit 56983c75.

**Alternatives**: `rustfs/rc` client image — rejected: a second image to pin, scan, allowlist and keep
visible to Renovate, for one HTTP request. MinIO's `mc` — rejected: it is the thing being removed.

**Shape**: dev and the backup destination keep the one-shot that exits 0
(`service_completed_successfully`); production keeps the "touch `/tmp/ready`, `exec sleep infinity`,
healthcheck on the marker" shape, because Komodo's stack-health counts an exited container as
unhealthy (current `compose.prod.yaml` comment). `exec sleep infinity` needs `sleep` from busybox —
present on Alpine **[to verify in T011]**.

## R9 — Logs

**Decision**: set `RUSTFS_OBS_LOG_DIRECTORY: ""` on every instance.

**[measured here]**: with it empty the entrypoint prints `OBS log directory not configured and logs
outputs to stdout` and `docker logs` carries the server's JSON log. With the image default (`/logs`),
logs go to a file inside the container — invisible to `docker logs`, to CI's `docker logs "$c" | tail
-40` failure dumps in `app-ci.yml`, and to the `json-file` rotation every stack configures.

## R10 — Console

**Decision**: disable the RustFS console on every instance and publish no console port.

Nothing uses MinIO's console today (prod `langfuse-minio` publishes no ports; the backup destination
publishes `127.0.0.1:9101` for it). RustFS's console defaults to `CORS_ALLOWED_ORIGINS=*`. **[to
verify]** the exact disable variable for 1.0.1 (`RUSTFS_CONSOLE_ENABLE=false` per upstream docs) and
that `:9001` is then closed (T011). The Nx-cache host compose currently publishes `9001` on
`0.0.0.0` — removed (R14).

## R11 — Naming and credentials

| Was | Becomes |
|---|---|
| service `langfuse-minio`, `langfuse-minio-init` | `langfuse-rustfs`, `langfuse-rustfs-init` |
| volume `langfuse-minio-data` / prod external `observability-langfuse-minio-data` | `langfuse-rustfs-data` / `observability-langfuse-rustfs-data` (**new** volume — the old one is the rollback target) |
| `mcm-bff-backup-minio`, `-init`, volume `mcm-bff-backup-minio-data` | `mcm-bff-backup-rustfs`, `-init`, `mcm-bff-backup-rustfs-data` |
| `LANGFUSE_MINIO_ROOT_PASSWORD` | `LANGFUSE_RUSTFS_SECRET_KEY` |
| Langfuse access key id literal `minio` | `langfuse` (a non-secret identifier, allowed by `check-no-inline-secrets.mjs`'s `*ACCESS_KEY_ID` rule) |
| endpoint `http://langfuse-minio:9000` | `http://langfuse-rustfs:9000` |
| `BACKUP_TEST_S3_INTERNAL_ENDPOINT=http://mcm-bff-backup-minio:9000` | `http://mcm-bff-backup-rustfs:9000` |
| host port `127.0.0.1:9100` (S3) | unchanged — the integration tier's `BACKUP_TEST_S3_ENDPOINT` default stays valid |

`BACKUP_TEST_S3_ACCESS_KEY` / `_SECRET_KEY` keep their names: they describe the role, not the vendor.

**Rollback dependency (feature 069 R9's lesson)**: the reverted compose references
`LANGFUSE_MINIO_ROOT_PASSWORD` and `REGISTRY_HOST`. Both Komodo Variables, and both entries in
`stacks.toml`'s `prod-observability` block, must survive until the rollback window closes — the
revert restores the `stacks.toml` lines with it, but the **Variables** live in Komodo and a revert
cannot recreate them. So the old Variable is deleted only in the deferred-cleanup task.

**`REGISTRY_HOST` leaves two stacks**: after the swap, no image in `observability/compose*.yaml` or
`backups/compose.yaml` comes from the forge registry. The variable, its `:?` guards, the
`prod-observability` `stacks.toml` line, the env-example blocks and app-ci's backup-step check that
"REGISTRY_HOST is unset" all exist only for MinIO and go. The Komodo Variable itself stays — other
stacks use it. `komodo-stack-env.guard.test.mjs` still holds (it requires supply, not absence).

## R12 — Migration mechanics

**Decision**: a committed tool, `scripts/object-store-migration.mjs`, with subcommands `inventory`,
`manifest`, `copy`, `verify`, `rehearse`. Read-only by default; `copy` writes only with `--apply`;
the repository's shared rejecting argument parser refuses anything unrecognised (CLAUDE.md: a
mis-typed `--dry-run` once meant "delete for real").

- **inventory** (read-only, against the stopped volume via a throwaway container mounting it `:ro`):
  `format.json` `format` (must be `xl-single`) and set shape (exactly one set of one drive); count of
  `xl.meta` files containing `X-Minio-Internal-Server-Side-Encryption` (must be 0) and
  `transition-status` (must be 0); per-bucket `.metadata.bin` presence and whether it carries
  versioning, lifecycle or notification configuration; `config/iam/` users beyond root; object count
  and bytes; a content digest of the whole tree. Refuses non-zero on any blocking finding.
- **manifest** (read-only, against the **running** old store, after writers stop and before it stops):
  S3 list of every object → JSON (bucket, key, size, ETag).
- **copy** (`--apply`): new volume must not already exist (refuses — the feature-070 trap of `docker
  run -v name:` silently *creating* a volume); `cp -a` from `:ro` source; chown to the uid read from
  the pinned RustFS image; recount non-owned entries (must be 0); re-digest the **source** (must equal
  the inventory digest).
- **verify** (read-only, against the running RustFS): list → compare with manifest (count, bytes, key,
  size, ETag; any discrepancy named); GET and SHA-256 every multipart object (ETag contains `-`) and a
  deterministic sample of the rest, compared against the same GETs made by `manifest` from MinIO.
- **rehearse**: the automated end-to-end rehearsal (R13).

Copy by `cp -a` inside a container on the same daemon keeps everything on the prod host, needs no
network transfer and preserves timestamps. Expected duration scales with bytes; the inventory reports
bytes, and the operator schedules the window from it.

## R13 — The rehearsal, and how long MinIO stays referenced

**Decision**: `object-store-migration.mjs rehearse` seeds a scratch volume with the **currently
deployed** MinIO image (by digest), with objects of every shape Langfuse writes plus a versioned
bucket and a delete marker, then runs inventory → manifest → copy → RustFS start → verify, asserts
the source digest is unchanged, then **rolls back** (starts MinIO on the original) and re-reads every
object. Negative cases: a synthetic `"format":"fs"` drive and an SSE-marked `xl.meta` must make
`inventory` refuse.

It needs a Docker daemon, so it is not part of `guardrails` (its pure logic — manifest diffing,
format classification, argument rejection — is unit-tested there). It runs in the dev container, and
its output is attached to the PR as evidence. It skips without Docker **unless**
`MCM_REQUIRE_LIVE_STACK=1`, which turns the skip into a failure (CLAUDE.md: a skip reads as a pass).

**The MinIO image reference** lives only in this tool, and only until the deferred cleanup (after the
production rollback window closes and the old volumes are deleted). Then the tool's `rehearse` path —
and with it the last `jumbleknot/minio` reference — is deleted, and the registry package can be
removed. The registry keeps the manifest pullable meanwhile: the per-run `-r<RUN_ID>` tags (item #577)
keep it referenced, and deleting `minio-image.yml` deletes no package. **Do not delete the
`jumbleknot/minio` registry package before cleanup** — rollback pulls it.

## R14 — The third MinIO: the Nx remote cache

Found while tracing every occurrence, not in the brief. `docs/runbooks/Server-Setup-Runbook.md`
Phase 8 provisions `/home/prod/minio/compose.yaml` on the prod daemon: `quay.io/minio/minio`
(**unpinned**, no digest, so frozen at whatever quay last received), an `mc` sidecar creating
`nx-cache`, ports `9000:9000` and `9001:9001`, root user `nxcache`. The Rust `nx-cache-server` talks
to it at `S3_ENDPOINT_URL=http://127.0.0.1:9000`, and every CI run consults that cache
(`NX_SELF_HOSTED_REMOTE_CACHE_SERVER`). `prod-reboot-resilience.md` lists it among host-managed
composes. It is outside every git-tracked compose, so the infra-image sweep and Renovate have never
seen it.

**Decision**: replace it by the same tool and procedure (default; see spec Open Question 1), keeping
port 9000 so `nx-cache.env` changes only in its credential lines; drop the 9001 publish; pin by
digest in the runbook. Data is rebuildable, so this is P3 and the rehearsal's risk budget is lower.

## R15 — Monitoring is unaffected

**[measured 2026-10-10, brief]** `grafana/otel-lgtm:0.34.0@sha256:b966ea10…`: `/otel-lgtm/tempo-config.yaml`
`storage: backend: local`, writing its own `/data`.

**[measured 2026-10-10, here]** the repository has since moved to
`grafana/otel-lgtm:0.35.0@sha256:2de1094c…`; re-checked on that digest — `storage: trace: backend:
local`, `wal: path: /data/tempo/wal`, and no `/otel-lgtm/*.yaml` mentions MinIO or S3. Out of scope
except that SC-008 checks it still works.

## R16 — What CI and CD actually exercise

- **app-ci** brings up the backup destinations (`backups/compose.yaml`) per run and runs the
  integration tier with `MCM_REQUIRE_BACKUP_TARGETS=1`. It **never** brings up the observability
  stack, so no CI job exercises Langfuse's store. Proof for US1 is operator-run.
- **cd-deploy** fires the Komodo webhook(s) and then `scripts/cd/health-probe.sh`, which checks only
  the Keycloak issuer and `https://mcm.<base>`. **It does not observe `prod-observability`.** So
  SC-006 is demonstrated on the host (`docker ps` health of every `prod-observability` container plus
  Komodo's stack health) — FR-027. Extending the probe is out of scope: Langfuse is tailnet-only and
  the probe runs from the CI runner against the public domain.
- **S3-destination suites**: **14**, not ten — measured by `grep -l
  'BACKUP_TEST_S3\|mcm-bff-backup-minio\|9100' frontend/mcm-app/tests/integration/*.ts`:
  `account-deletion`, `account-deletion-audit`, `backup-account-deletion`, `backup-audit`,
  `backup-ceiling`, `backup-destination-probe`, `backup-destinations-authz`, `backup-driver-s3`,
  `backup-jobs-authz`, `backup-restore-routes`, `backup-retention`, `backup-runner`, `backup-tick`,
  `backup-versions`. The proof runs the whole `test:integration` tier and reads the skip count, so the
  exact number does not need to be maintained anywhere.

## R17 — Item #552

Open as of 2026-10-10: the dev `stacks/mcm.env` lost the four `BACKUP_TEST_*` keys and
`gen-dev-secrets.mjs` will not restore them. It makes the **local** S3 suites skip silently (or, with
`MCM_REQUIRE_LIVE_STACK=1`, fail). CI mints its own per-run credentials and is unaffected.
**Decision**: a precondition, not folded in — T002 checks the four keys exist in the implementer's
`stacks/mcm.env` and, if not, stops and points at #552 rather than hand-patching around it.

## R18 — The touchpoint inventory

`git grep -il minio -- . ':!openwiki' ':!specs' ':!pnpm-lock.yaml'` → **72 files** on `origin/main`
at `60d03774` (2026-10-10). Every one is assigned to a task in `tasks.md` or to the guard's
exemption list in `contracts/no-minio-guard.md`. Plus one **not in git**: the host-managed Nx-cache
compose (R14).

## Residual risks accepted

- **Writes between cutover and a rollback are lost** (one-way format). Bounded by verifying
  immediately after cutover with writers still quiesced until verify passes.
- **RustFS is a younger project than MinIO was.** Mitigated by digest pinning, Renovate's 3-day
  cooldown, the weekly sweep, and by RustFS being the S3 dialect of record only for test fixtures and
  Langfuse blobs.
